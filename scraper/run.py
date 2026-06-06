"""Orchestrateur du scraper Celestial Market (flux batch Yahoo).

Pipeline robuste (session curl_cffi + crumb gérés une fois) :
  Passe 1  v7/quote batch (100 sym/req) sur tout l'univers
           -> taille (marketCap ou netAssets) -> tri -> top N
  Passe 2a quoteSummary sur le top N -> sector, beta
  Passe 2b chart sur le top N -> volatility_30d
  Écriture data/snapshot.json (beau fichier pour la viz 3D).

Usage : python run.py [N]   (N = nombre d'actifs visés, défaut 4000)
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "providers"))

import yahoo_batch as yb
from universe import build_universe
from transform import safe_log10, volume_norm, change_pct

OUT = os.path.join(HERE, "..", "data", "snapshot.json")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 4000
PROFILE_WORKERS = 6
VOL_WORKERS = 6


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


def pass2_profiles(session, crumb, syms):
    print(f"Passe 2a : sector/beta sur {len(syms)} actifs...", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=PROFILE_WORKERS) as ex:
        profs = list(ex.map(lambda s: (s, yb.fetch_profile(session, crumb, s)), syms))
    print(f"Passe 2a OK en {time.time()-t0:.0f}s", flush=True)
    return dict(profs)


def pass2_volatility(session, syms):
    print(f"Passe 2b : volatilité 30j sur {len(syms)} actifs...", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=VOL_WORKERS) as ex:
        vols = list(ex.map(lambda s: (s, yb.fetch_volatility(session, s)), syms))
    print(f"Passe 2b OK en {time.time()-t0:.0f}s", flush=True)
    return dict(vols)


def assemble(universe, quotes, syms, profiles, vols, now):
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
        assets.append({
            "ticker": s,
            "name": q.get("longName") or q.get("shortName") or u.get("name_raw"),
            "sector": profiles.get(s, {}).get("sector"),
            "asset_type": asset_type,
            "exchange": u.get("exchange", q.get("fullExchangeName")),
            "market_cap": int(size) if size else None,
            "market_cap_log": safe_log10(size),
            "volume": int(vol) if vol else None,
            "volume_norm": volume_norm(vol, avg),
            "beta": round(profiles[s]["beta"], 3)
                    if profiles.get(s, {}).get("beta") is not None else None,
            "volatility_30d": vols.get(s),
            "price": round(price, 2) if price else None,
            "price_open": round(p_open, 2) if p_open else None,
            "change_pct": chg,
            "pos_x": None, "pos_y": None, "pos_z": None,
            "updated_at": now,
        })
    return assets


def main():
    t0 = time.time()
    universe = build_universe()
    print(f"Univers : {len(universe)} candidats.", flush=True)

    quotes, syms = pass1_quotes(universe)

    session, crumb = yb.make_session()
    profiles = pass2_profiles(session, crumb, syms)
    vols = pass2_volatility(session, syms)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    assets = assemble(universe, quotes, syms, profiles, vols, now)
    assets.sort(key=lambda a: a["market_cap"] or 0, reverse=True)

    doc = {
        "meta": {
            "generated_at": now,
            "source": "yahoo-finance",
            "count": len(assets),
            "target": TARGET,
            "schema_version": 1,
            "notes": [
                "market_cap = marketCap (actions) ou netAssets/AUM (ETF).",
                "volatility_30d = écart-type des rendements log quotidiens (~30 séances).",
                "pos_x/y/z null : remplis par le pipeline de clustering aval.",
            ],
        },
        "assets": assets,
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    # Bilan qualité
    def filled(field):
        return sum(1 for a in assets if a.get(field) is not None)
    sectors = {}
    for a in assets:
        s = a.get("sector") or "(ETF/Unknown)"
        sectors[s] = sectors.get(s, 0) + 1
    print(f"\n✅ {len(assets)} actifs -> {os.path.relpath(OUT, HERE)} "
          f"en {(time.time()-t0)/60:.1f} min")
    print("Remplissage des champs clés :")
    for f in ["sector", "beta", "volatility_30d", "volume_norm", "change_pct"]:
        print(f"  {f:16s} {filled(f)}/{len(assets)}")
    print("Top secteurs :")
    for s, n in sorted(sectors.items(), key=lambda x: -x[1])[:12]:
        print(f"  {n:5d}  {s}")


if __name__ == "__main__":
    main()
