"""Probe de dérisquage : Yahoo bloque-t-il les IP de GitHub Actions ?

Test minimal et autonome (n'écrit aucune donnée). Réutilise le VRAI mécanisme
du scraper (session curl_cffi + crumb + endpoint batch v7) pour être fidèle.

Verdict clair en sortie + code de sortie :
  exit 0  -> ça passe (récupération OK)
  exit 1  -> bloqué / échec (session KO ou trop peu de tickers récupérés)

Usage : python probe_yahoo.py
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "providers"))

import yahoo_batch as yb  # noqa: E402

# Large caps + quelques ETF : des symboles qui DOIVENT renvoyer une taille.
TICKERS = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "BRK-B",
    "JPM", "V", "UNH", "XOM", "JNJ", "WMT", "MA", "PG", "HD", "CVX",
    "ABBV", "KO", "PEP", "COST", "MRK", "ADBE", "CRM", "NFLX", "AMD",
    "INTC", "CSCO", "ORCL", "QCOM", "TXN", "IBM", "GE", "BA", "CAT",
    "SPY", "QQQ", "VOO", "VTI", "IWM", "DIA", "GLD", "TLT", "ARKK",
]


def main():
    print("=" * 60)
    print("PROBE YAHOO — test de connectivité depuis cette machine")
    print("=" * 60)

    # 1) Établissement de la session (cookie + crumb)
    try:
        t0 = time.time()
        session, crumb = yb.make_session()
        print(f"[OK] Session établie en {time.time()-t0:.1f}s "
              f"(crumb={crumb[:10]}...)")
    except Exception as e:
        print(f"[ÉCHEC] Impossible d'établir la session : {e}")
        print("\nVERDICT : 🔴 BLOQUÉ dès la session (cookie/crumb refusés).")
        sys.exit(1)

    # 2) Récupération d'un lot de tickers connus
    try:
        t0 = time.time()
        quotes = yb.fetch_quotes(session, crumb, TICKERS)
        dt = time.time() - t0
    except Exception as e:
        print(f"[ÉCHEC] fetch_quotes a levé : {e}")
        print("\nVERDICT : 🔴 BLOQUÉ sur la requête quote "
              "(401 Invalid Crumb / 429 rate-limit probable).")
        sys.exit(1)

    got = len(quotes)
    sized = sum(1 for q in quotes.values()
                if q.get("marketCap") or q.get("netAssets"))
    print(f"[INFO] {got}/{len(TICKERS)} tickers récupérés "
          f"({sized} avec taille) en {dt:.1f}s")

    # Échantillon lisible
    for sym in ["AAPL", "NVDA", "SPY"]:
        q = quotes.get(sym)
        if q:
            print(f"   {sym}: price={q.get('regularMarketPrice')} "
                  f"mc={q.get('marketCap')} netAssets={q.get('netAssets')} "
                  f"name={q.get('longName') or q.get('shortName')}")

    # 3) Verdict : on exige au moins 80% du lot.
    ratio = got / len(TICKERS)
    print("-" * 60)
    if ratio >= 0.8 and sized >= 0.8 * len(TICKERS):
        print(f"VERDICT : 🟢 OK — {got}/{len(TICKERS)} récupérés. "
              "Yahoo répond depuis cette IP.")
        sys.exit(0)
    else:
        print(f"VERDICT : 🟠 PARTIEL/SUSPECT — seulement {got}/{len(TICKERS)} "
              "récupérés. Possible rate-limit ou filtrage partiel.")
        sys.exit(1)


if __name__ == "__main__":
    main()
