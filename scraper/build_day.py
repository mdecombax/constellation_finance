"""Reconstruit une séance PASSÉE réelle à partir des séries OHLCV de Yahoo.

Sert à amorcer l'historique sans attendre de nouvelles clôtures : on rejoue un
jour de bourse réel (open/close/volume du jour, variation vs veille, volatilité
30j à cette date) pour les actifs déjà présents dans data/snapshot.json.

Usage : python build_day.py 2026-06-04
"""
import gzip
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "providers"))

import yahoo_batch as yb  # noqa: E402

DATA = os.path.join(HERE, "..", "data")
SNAP = os.path.join(DATA, "snapshot.json")
DAYS_DIR = os.path.join(DATA, "days")
INDEX = os.path.join(DATA, "index.json")
NY = ZoneInfo("America/New_York")
CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"

TARGET = sys.argv[1] if len(sys.argv) > 1 else None
if not TARGET:
    sys.exit("Usage : python build_day.py YYYY-MM-DD")


def fetch_series(session, sym):
    """OHLCV quotidien (~3 mois). Retourne (dates[], opens[], closes[], vols[])."""
    try:
        r = session.get(CHART.format(sym=sym),
                        params={"range": "3mo", "interval": "1d"}, timeout=15)
        if r.status_code != 200:
            return None
        res = r.json().get("chart", {}).get("result")
        if not res:
            return None
        ts = res[0]["timestamp"]
        q = res[0]["indicators"]["quote"][0]
        dates = [datetime.fromtimestamp(t, NY).date().isoformat() for t in ts]
        return dates, q["open"], q["close"], q["volume"]
    except Exception:
        return None


def build_asset(base, series, ti):
    """Construit l'enregistrement de l'actif pour l'indice de date ti."""
    dates, opens, closes, vols = series
    close = closes[ti]
    if close is None:
        return None
    open_ = opens[ti]
    vol = vols[ti]
    prev_close = next((closes[j] for j in range(ti - 1, -1, -1)
                       if closes[j] is not None), None)

    # variation = vs clôture de la veille (comme Yahoo) ; fallback vs open du jour
    if prev_close:
        chg = (close - prev_close) / prev_close * 100
    elif open_:
        chg = (close - open_) / open_ * 100
    else:
        chg = None

    # taille : cap actuelle ajustée au ratio de prix (shares ~constantes sur la fenêtre)
    cur_price = base.get("price")
    cur_cap = base.get("market_cap")
    cap = int(cur_cap * close / cur_price) if (cur_cap and cur_price) else cur_cap
    cap_log = round(math.log10(cap), 2) if cap and cap > 0 else None

    # volume_norm = volume du jour / moyenne ~3 mois (closes valides)
    vv = [v for v in vols if v]
    avg = sum(vv) / len(vv) if vv else None
    vnorm = round(min(1.5, vol / avg), 3) if (avg and vol) else None

    # volatilité 30j à cette date (rendements log des 30 séances <= ti)
    cl = [c for c in closes[:ti + 1] if c]
    vol30 = None
    if len(cl) >= 6:
        rets = [math.log(cl[i] / cl[i - 1]) for i in range(1, len(cl))][-30:]
        if len(rets) >= 2:
            m = sum(rets) / len(rets)
            var = sum((x - m) ** 2 for x in rets) / (len(rets) - 1)
            vol30 = round(math.sqrt(var), 4)

    return {
        "ticker": base["ticker"], "name": base.get("name"),
        "sector": base.get("sector"), "asset_type": base.get("asset_type"),
        "exchange": base.get("exchange"),
        "market_cap": cap, "market_cap_log": cap_log,
        "volume": int(vol) if vol else None, "volume_norm": vnorm,
        "beta": base.get("beta"), "volatility_30d": vol30,
        "price": round(close, 2), "price_open": round(open_, 2) if open_ else None,
        "change_pct": round(chg, 2) if chg is not None else None,
        "pos_x": None, "pos_y": None, "pos_z": None,
        "updated_at": TARGET,
    }


def main():
    snap = json.load(open(SNAP))
    bases = snap["assets"]
    print(f"Reconstruction de {TARGET} pour {len(bases)} actifs (endpoint chart)...",
          flush=True)

    t0 = time.time()
    by_ticker = {b["ticker"]: b for b in bases}

    def run_pass(targets, workers):
        """Tente une passe sur `targets` (tickers). Retourne {ticker: asset|None}."""
        session, _ = yb.make_session()

        def work(tk):
            s = fetch_series(session, tk)
            if not s or TARGET not in s[0]:
                return tk, None
            return tk, build_asset(by_ticker[tk], s, s[0].index(TARGET))

        out = {}
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for tk, a in ex.map(work, targets):
                out[tk] = a
        return out

    # Passe 1 (rapide) puis boucle de complétion sur les manquants (rate-limit chart).
    results = {}
    todo = [b["ticker"] for b in bases]
    workers = 8
    for rnd in range(6):
        res = run_pass(todo, workers)
        for tk, a in res.items():
            if a:
                results[tk] = a
        todo = [tk for tk in todo if tk not in results]
        print(f"  passe {rnd+1} (w={workers}) : ok={len(results)}/{len(bases)} "
              f"| restants={len(todo)}", flush=True)
        if not todo:
            break
        workers = max(3, workers - 1)   # on ralentit pour calmer le rate-limit
        time.sleep(3.0)

    assets = list(results.values())
    assets.sort(key=lambda a: a["market_cap"] or 0, reverse=True)
    now = datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds").replace("+00:00", "Z")
    doc = {
        "meta": {
            "generated_at": now, "session_date": TARGET,
            "source": "yahoo-finance (chart/historique)",
            "count": len(assets), "schema_version": 2,
            "notes": [
                "Séance reconstruite depuis les séries OHLCV (chart) — données réelles.",
                "market_cap = cap actuelle ajustée au ratio de prix du jour.",
            ],
        },
        "assets": assets,
    }

    os.makedirs(DAYS_DIR, exist_ok=True)
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz_path = os.path.join(DAYS_DIR, f"{TARGET}.json.gz")
    with gzip.open(gz_path, "wb", compresslevel=9) as f:
        f.write(raw)

    days = sorted(fn[:-len(".json.gz")] for fn in os.listdir(DAYS_DIR)
                  if fn.endswith(".json.gz"))
    json.dump({"days": days, "latest": days[-1], "count": len(days),
               "updated_at": now}, open(INDEX, "w"), ensure_ascii=False, indent=2)

    filled = sum(1 for a in assets if a.get("volatility_30d") is not None)
    print(f"\n✅ {len(assets)} actifs -> days/{TARGET}.json.gz "
          f"({len(raw)//1024} Ko -> {gz_path and os.path.getsize(gz_path)//1024} Ko gz) "
          f"en {(time.time()-t0)/60:.1f} min")
    print(f"   volatilité remplie : {filled}/{len(assets)}")
    print(f"   index : {days}")


if __name__ == "__main__":
    main()
