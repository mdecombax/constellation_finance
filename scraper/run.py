"""Orchestrateur du scraper Celestial Market (flux batch Yahoo).

Pipeline robuste (session curl_cffi + crumb gérés une fois) :
  Passe 1  v7/quote batch (100 sym/req) sur tout l'univers
           -> taille (marketCap ou netAssets) -> tri -> top N
  Passe 2a quoteSummary -> sector/beta, MAIS seulement pour les tickers absents
           du cache data/profiles.json (attributs quasi-statiques -> cumulatif).
  Passe 2b spark batch (20 sym/req) -> volatility_30d.

Sorties :
  data/days/<date-séance>.json.gz  (un fichier par séance, compressé)
  data/index.json                  (manifest : days[], latest)
  data/snapshot.json               (compat app actuelle ; retiré à l'étape de nettoyage)
  data/profiles.json               (cache cumulatif sector/beta)

Usage : python run.py [N]   (N = nombre d'actifs visés, défaut 4000)
"""
import gzip
import json
import os
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "providers"))

import yahoo_batch as yb
from universe import build_universe
from transform import safe_log10, volume_norm, change_pct

DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(DATA, "snapshot.json")
DAYS_DIR = os.path.join(DATA, "days")
INDEX = os.path.join(DATA, "index.json")
PROFILES = os.path.join(DATA, "profiles.json")
os.makedirs(DATA, exist_ok=True)

TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 4000
PROFILE_WORKERS = 6
NY = ZoneInfo("America/New_York")


def asset_size(q):
    """Taille pour le tri/encodage : marketCap (actions) ou netAssets (ETF)."""
    return q.get("marketCap") or q.get("netAssets")


def pass1_quotes(universe):
    """v7/quote sur tout l'univers -> dict {sym: quote}. Tri -> top TARGET."""
    syms = [u["ticker"] for u in universe]
    print(f"Passe 1 : quotes batch de {len(syms)} candidats...", flush=True)
    t0 = time.time()
    quotes = yb.fetch_all(syms, batch_size=100, pause=0.3)
    sized = [(s, q) for s, q in quotes.items() if asset_size(q)]
    sized.sort(key=lambda kv: asset_size(kv[1]), reverse=True)
    top = sized[:TARGET]
    print(f"Passe 1 OK en {time.time()-t0:.0f}s : "
          f"{len(quotes)} quotes, {len(sized)} dimensionnés -> top {len(top)}",
          flush=True)
    return dict(top), [s for s, _ in top]


def load_profiles():
    """Cache cumulatif {ticker: {sector, beta}} (sector/beta quasi-statiques)."""
    try:
        with open(PROFILES) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_profiles(cache):
    with open(PROFILES, "w") as f:
        json.dump(cache, f, ensure_ascii=False, indent=0, sort_keys=True)


def pass2_profiles(session, crumb, syms, quotes, cache):
    """Complète le cache sector/beta : ne scrape (quoteSummary) que les ACTIONS
    absentes du cache ou sans secteur. Contourne le rate-limit cloud sur ces
    attributs statiques (le cache, versionné, ne fait que grandir)."""
    todo = []
    for s in syms:
        if (quotes[s].get("quoteType") or "").upper() != "EQUITY":
            continue  # ETF & co. : pas de secteur attendu
        c = cache.get(s)
        if not c or c.get("sector") is None:
            todo.append(s)
    print(f"Passe 2a : sector/beta — cache={len(cache)}, à scraper={len(todo)}...",
          flush=True)
    t0 = time.time()
    if todo:
        with ThreadPoolExecutor(max_workers=PROFILE_WORKERS) as ex:
            for s, prof in ex.map(
                    lambda s: (s, yb.fetch_profile(session, crumb, s)), todo):
                cur = cache.get(s, {})
                if prof.get("sector") is not None:
                    cur["sector"] = prof["sector"]
                if prof.get("beta") is not None:
                    cur["beta"] = prof["beta"]
                if cur:
                    cache[s] = cur
    print(f"Passe 2a OK en {time.time()-t0:.0f}s", flush=True)
    return cache


def pass2_volatility(syms):
    """Volatilité 30j via spark batch (max 20 sym/req, séquentiel).

    Remplace l'ancienne version multithread (4000 requêtes chart) qui se faisait
    rate-limiter (429) depuis les IP datacenter -> volatilité à 0/4000.
    """
    print(f"Passe 2b : volatilité 30j (spark batch) sur {len(syms)} actifs...",
          flush=True)
    t0 = time.time()
    vols = yb.fetch_volatility_batch(syms, batch_size=20, pause=0.3)
    print(f"Passe 2b OK en {time.time()-t0:.0f}s", flush=True)
    return vols


def session_date(quotes):
    """Date de la séance (timezone New York), déduite de regularMarketTime.
    Fallback : date du jour à New York."""
    dates = []
    for q in quotes.values():
        t = q.get("regularMarketTime")
        if t:
            try:
                dates.append(datetime.fromtimestamp(t, NY).date().isoformat())
            except Exception:
                pass
    if dates:
        return Counter(dates).most_common(1)[0][0]
    return datetime.now(NY).date().isoformat()


def assemble(universe, quotes, syms, cache, vols, now):
    meta_by = {u["ticker"]: u for u in universe}
    assets = []
    for s in syms:
        q = quotes[s]
        u = meta_by.get(s, {})
        size = asset_size(q)
        qtype = (q.get("quoteType") or "").upper()
        asset_type = "etf" if qtype == "ETF" else (
            "stock" if qtype == "EQUITY" else u.get("asset_type", "stock"))
        price = q.get("regularMarketPrice")
        p_open = q.get("regularMarketOpen")
        vol = q.get("regularMarketVolume")
        avg = q.get("averageDailyVolume3Month")
        chg = q.get("regularMarketChangePercent")
        chg = round(chg, 2) if chg is not None else change_pct(price, p_open)
        prof = cache.get(s, {})
        beta = prof.get("beta")
        assets.append({
            "ticker": s,
            "name": q.get("longName") or q.get("shortName") or u.get("name_raw"),
            "sector": prof.get("sector"),
            "asset_type": asset_type,
            "exchange": u.get("exchange", q.get("fullExchangeName")),
            "market_cap": int(size) if size else None,
            "market_cap_log": safe_log10(size),
            "volume": int(vol) if vol else None,
            "volume_norm": volume_norm(vol, avg),
            "beta": round(beta, 3) if beta is not None else None,
            "volatility_30d": vols.get(s),
            "price": round(price, 2) if price else None,
            "price_open": round(p_open, 2) if p_open else None,
            "change_pct": chg,
            "pos_x": None, "pos_y": None, "pos_z": None,
            "updated_at": now,
        })
    return assets


def write_outputs(doc, sess_date):
    """Écrit le jour gzippé, reconstruit l'index, et garde snapshot.json (compat).
    L'index est reconstruit depuis le dossier days/ -> jamais de doublon de date."""
    os.makedirs(DAYS_DIR, exist_ok=True)
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    gz_path = os.path.join(DAYS_DIR, f"{sess_date}.json.gz")
    is_new = not os.path.exists(gz_path)
    with gzip.open(gz_path, "wb", compresslevel=9) as f:
        f.write(raw)

    with open(OUT, "w") as f:  # compat app actuelle (non compressé)
        json.dump(doc, f, ensure_ascii=False, indent=2)

    days = sorted(fn[:-len(".json.gz")] for fn in os.listdir(DAYS_DIR)
                  if fn.endswith(".json.gz"))
    index = {
        "days": days,
        "latest": days[-1] if days else None,
        "count": len(days),
        "updated_at": doc["meta"]["generated_at"],
    }
    with open(INDEX, "w") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    return gz_path, is_new, len(raw), os.path.getsize(gz_path)


def main():
    t0 = time.time()
    universe = build_universe()
    print(f"Univers : {len(universe)} candidats.", flush=True)

    quotes, syms = pass1_quotes(universe)

    cache = load_profiles()
    session, crumb = yb.make_session()
    cache = pass2_profiles(session, crumb, syms, quotes, cache)
    save_profiles(cache)
    vols = pass2_volatility(syms)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    sess_date = session_date(quotes)
    assets = assemble(universe, quotes, syms, cache, vols, now)
    assets.sort(key=lambda a: a["market_cap"] or 0, reverse=True)

    doc = {
        "meta": {
            "generated_at": now,
            "session_date": sess_date,
            "source": "yahoo-finance",
            "count": len(assets),
            "target": TARGET,
            "schema_version": 2,
            "notes": [
                "session_date = jour de bourse (timezone New York).",
                "market_cap = marketCap (actions) ou netAssets/AUM (ETF).",
                "volatility_30d = écart-type des rendements log quotidiens (~30 séances).",
                "sector/beta proviennent du cache cumulatif data/profiles.json.",
                "pos_x/y/z null : remplis par le pipeline de clustering aval.",
            ],
        },
        "assets": assets,
    }

    gz_path, is_new, raw_sz, gz_sz = write_outputs(doc, sess_date)

    # Bilan qualité
    def filled(field):
        return sum(1 for a in assets if a.get(field) is not None)
    stock = sum(1 for a in assets if a.get("asset_type") == "stock")
    stock_sec = sum(1 for a in assets
                    if a.get("asset_type") == "stock" and a.get("sector"))
    tag = "NOUVEAU" if is_new else "refresh"
    print(f"\n✅ {len(assets)} actifs -> days/{sess_date}.json.gz "
          f"[{tag}] ({raw_sz//1024} Ko -> {gz_sz//1024} Ko gz) "
          f"en {(time.time()-t0)/60:.1f} min")
    print("Remplissage des champs clés :")
    for f in ["sector", "beta", "volatility_30d", "volume_norm", "change_pct"]:
        print(f"  {f:16s} {filled(f)}/{len(assets)}")
    print(f"  secteur (actions) {stock_sec}/{stock} "
          f"= {100*stock_sec/stock:.0f}%" if stock else "")
    print(f"Cache profiles : {len(cache)} tickers -> data/profiles.json")


if __name__ == "__main__":
    main()
