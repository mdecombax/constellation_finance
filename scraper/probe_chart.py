"""Diagnostic ciblé : pourquoi l'endpoint chart (volatilité) échoue depuis le cloud ?

Teste plusieurs variantes pour récupérer un historique de prix et logge le
STATUS CODE réel + un extrait de réponse. But : trouver un chemin qui passe
depuis les IP GitHub (query2 ? spark batch ? avec crumb ?).

Usage : python probe_chart.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "providers"))

import yahoo_batch as yb  # noqa: E402

SYM = "AAPL"
BATCH = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"]


def show(label, r):
    body = (r.text or "")[:160].replace("\n", " ")
    print(f"[{label}] HTTP {r.status_code} | {len(r.text)}o | {body}")


def main():
    session, crumb = yb.make_session()
    print(f"Session OK (crumb={crumb[:8]}...)\n")

    tests = [
        ("chart query1",
         "https://query1.finance.yahoo.com/v8/finance/chart/" + SYM,
         {"range": "2mo", "interval": "1d"}),
        ("chart query2",
         "https://query2.finance.yahoo.com/v8/finance/chart/" + SYM,
         {"range": "2mo", "interval": "1d"}),
        ("chart query1 +crumb",
         "https://query1.finance.yahoo.com/v8/finance/chart/" + SYM,
         {"range": "2mo", "interval": "1d", "crumb": crumb}),
        ("spark query1 (batch)",
         "https://query1.finance.yahoo.com/v7/finance/spark",
         {"symbols": ",".join(BATCH), "range": "1mo", "interval": "1d"}),
        ("spark query2 (batch)",
         "https://query2.finance.yahoo.com/v7/finance/spark",
         {"symbols": ",".join(BATCH), "range": "1mo", "interval": "1d"}),
    ]

    for label, url, params in tests:
        try:
            r = session.get(url, params=params, timeout=15)
            show(label, r)
        except Exception as e:
            print(f"[{label}] EXCEPTION : {e}")


if __name__ == "__main__":
    main()
