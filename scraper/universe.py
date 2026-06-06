"""Construit l'univers de tickers candidats depuis les fichiers officiels nasdaqtrader.

Sortie : liste de dicts {ticker, name_raw, exchange, asset_type} nettoyée.
On scanne large (candidats) puis run.py garde le top 4000 par market_cap.
"""
import csv
import io
import re
import urllib.request

NASDAQ_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
OTHER_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"

# Codes d'exchange "Exchange" du fichier otherlisted -> nom lisible
EXCHANGE_MAP = {
    "A": "NYSE MKT",   # AMEX
    "N": "NYSE",
    "P": "NYSE ARCA",
    "Z": "BATS",
    "V": "IEX",
}

# Mots-clés qui trahissent un instrument non-action/ETF dans le nom du titre
JUNK_NAME = re.compile(
    r"\b(warrants?|rights?|units?|preferred|preferreds?|depositary|notes?|"
    r"debentures?|subordinated|when[- ]issued|convertible)\b",
    re.IGNORECASE,
)


def _download(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def _clean_symbol(sym: str) -> str | None:
    """Garde les symboles 'propres' (common stock / ETF), rejette le reste."""
    sym = sym.strip().upper()
    if not sym or len(sym) > 5:
        return None
    # Suffixes/caractères spéciaux = warrants, units, preferred, classes exotiques
    if any(c in sym for c in (".", "$", "+", "^", "=", "/", " ")):
        return None
    if not sym.isalpha():
        return None
    return sym


def _parse_nasdaq(text: str) -> list[dict]:
    out = []
    reader = csv.DictReader(io.StringIO(text), delimiter="|")
    for row in reader:
        if not row.get("Symbol"):
            continue
        if row.get("Test Issue", "N") == "Y":
            continue
        sym = _clean_symbol(row["Symbol"])
        if not sym:
            continue
        name = row.get("Security Name", "")
        if JUNK_NAME.search(name):
            continue
        is_etf = row.get("ETF", "N") == "Y"
        out.append({
            "ticker": sym,
            "name_raw": name,
            "exchange": "NASDAQ",
            "asset_type": "etf" if is_etf else "stock",
        })
    return out


def _parse_other(text: str) -> list[dict]:
    out = []
    reader = csv.DictReader(io.StringIO(text), delimiter="|")
    for row in reader:
        sym_raw = row.get("ACT Symbol") or ""
        if not sym_raw:
            continue
        if row.get("Test Issue", "N") == "Y":
            continue
        sym = _clean_symbol(sym_raw)
        if not sym:
            continue
        name = row.get("Security Name", "")
        if JUNK_NAME.search(name):
            continue
        is_etf = row.get("ETF", "N") == "Y"
        exch = EXCHANGE_MAP.get(row.get("Exchange", "").strip(), "NYSE")
        out.append({
            "ticker": sym,
            "name_raw": name,
            "exchange": exch,
            "asset_type": "etf" if is_etf else "stock",
        })
    return out


def build_universe() -> list[dict]:
    """Retourne la liste dédupliquée des candidats."""
    nasdaq = _parse_nasdaq(_download(NASDAQ_URL))
    other = _parse_other(_download(OTHER_URL))
    seen = {}
    for item in nasdaq + other:
        seen.setdefault(item["ticker"], item)  # NASDAQ prioritaire
    return list(seen.values())


if __name__ == "__main__":
    u = build_universe()
    stocks = sum(1 for x in u if x["asset_type"] == "stock")
    etfs = sum(1 for x in u if x["asset_type"] == "etf")
    print(f"Univers candidats : {len(u)} tickers ({stocks} actions, {etfs} ETF)")
    for x in u[:8]:
        print(" ", x)
