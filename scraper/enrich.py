"""Ré-enrichit data/snapshot.json en sector/beta/volatility_30d.

La passe 1 (top 4000 + champs marché) est déjà fiable dans le snapshot.
Ici on ne refait QUE les champs qui exigent des requêtes par-ticker
(quoteSummary + chart), en rafraîchissant la session Yahoo par chunks pour
éviter la dégradation du crumb/cookie observée au-delà de ~1500 requêtes.

Idempotent : relançable, écrase sector/beta/volatility_30d à chaque fois.
Usage : python enrich.py
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "providers"))
import yahoo_batch as yb

SNAP = os.path.join(HERE, "..", "data", "snapshot.json")
CHUNK = 600        # tickers par session fraîche
WORKERS = 5
PAUSE = 0.5        # pause entre chunks


def enrich_one(session, crumb, sym):
    """2 requêtes : profile (sector/beta) + volatility."""
    prof = yb.fetch_profile(session, crumb, sym)
    vol = yb.fetch_volatility(session, sym)
    return sym, prof, vol


def main():
    doc = json.load(open(SNAP))
    assets = doc["assets"]
    syms = [a["ticker"] for a in assets]
    by = {a["ticker"]: a for a in assets}
    print(f"Enrichissement de {len(syms)} actifs (chunks de {CHUNK})...", flush=True)

    t0 = time.time()
    done = 0
    for i in range(0, len(syms), CHUNK):
        chunk = syms[i:i + CHUNK]
        session, crumb = yb.make_session()  # session fraîche par chunk
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for sym, prof, vol in ex.map(
                    lambda s: enrich_one(session, crumb, s), chunk):
                a = by[sym]
                if prof.get("sector") is not None:
                    a["sector"] = prof["sector"]
                if prof.get("beta") is not None:
                    a["beta"] = round(prof["beta"], 3)
                if vol is not None:
                    a["volatility_30d"] = vol
        done += len(chunk)
        rate = done / (time.time() - t0)
        print(f"  {done}/{len(syms)} | {rate:.0f} tk/s "
              f"| ETA {(len(syms)-done)/max(rate,1e-9)/60:.1f} min", flush=True)
        time.sleep(PAUSE)

    # ETF : sector/beta légitimement null -> on ne les compte pas comme manquants
    stocks = [a for a in assets if a["asset_type"] == "stock"]
    def filled(field, pool):
        return sum(1 for a in pool if a.get(field) is not None)

    json.dump(doc, open(SNAP, "w"), ensure_ascii=False, indent=2)
    print(f"\n✅ snapshot ré-écrit en {(time.time()-t0)/60:.1f} min")
    print(f"  sector (stocks)     {filled('sector', stocks)}/{len(stocks)}")
    print(f"  beta (stocks)       {filled('beta', stocks)}/{len(stocks)}")
    print(f"  volatility_30d (all) {filled('volatility_30d', assets)}/{len(assets)}")


if __name__ == "__main__":
    main()
