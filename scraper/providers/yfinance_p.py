"""Provider yfinance — source du prototype (gratuit, sans clé).

Deux modes :
- fetch_fast : .fast_info (léger) -> market_cap/price/open/volume, pour trier l'univers.
- fetch_full : .info + .history -> schéma complet, sur les tickers retenus.
"""
import yfinance as yf

from transform import (
    change_pct,
    map_exchange,
    safe_log10,
    volatility_30d,
    volume_norm,
)


def fetch_fast(ticker: str) -> dict | None:
    """Passe 1 : juste de quoi trier par market cap. Léger et rapide.

    NB: FastInfo expose ses valeurs en attributs snake_case (fi.market_cap),
    alors que fi.get()/keys() utilisent du camelCase — on prend les attributs.
    """
    try:
        fi = yf.Ticker(ticker).fast_info
        mc = fi.market_cap
        if not mc or mc <= 0:
            return None
        return {"ticker": ticker, "market_cap": int(mc)}
    except Exception:
        return None


def fetch_full(ticker: str, meta: dict) -> dict | None:
    """Passe 2 : schéma complet. `meta` = entrée univers (exchange/asset_type fallback)."""
    try:
        t = yf.Ticker(ticker)
        info = t.info or {}
        market_cap = info.get("marketCap")
        if not market_cap or market_cap <= 0:
            return None

        price = info.get("regularMarketPrice") or info.get("currentPrice")
        price_open = info.get("regularMarketOpen") or info.get("open")
        volume = info.get("regularMarketVolume") or info.get("volume")
        avg_volume = info.get("averageVolume") or info.get("averageVolume10days")

        chg = info.get("regularMarketChangePercent")
        if chg is None:
            chg = change_pct(price, price_open)
        else:
            chg = round(chg, 2)

        # Historique pour la volatilité 30j
        vol30 = None
        try:
            hist = t.history(period="2mo", interval="1d")
            if not hist.empty:
                vol30 = volatility_30d(list(hist["Close"].dropna()))
        except Exception:
            pass

        qtype = (info.get("quoteType") or "").upper()
        asset_type = "etf" if qtype == "ETF" else ("stock" if qtype == "EQUITY"
                                                   else meta.get("asset_type", "stock"))

        return {
            "ticker": ticker,
            "name": info.get("longName") or info.get("shortName") or meta.get("name_raw"),
            "sector": info.get("sector"),
            "asset_type": asset_type,
            "exchange": map_exchange(info.get("exchange"), meta.get("exchange", "")),
            "market_cap": int(market_cap),
            "market_cap_log": safe_log10(market_cap),
            "volume": int(volume) if volume else None,
            "volume_norm": volume_norm(volume, avg_volume),
            "beta": round(info["beta"], 3) if info.get("beta") is not None else None,
            "volatility_30d": vol30,
            "price": round(price, 2) if price else None,
            "price_open": round(price_open, 2) if price_open else None,
            "change_pct": chg,
            "pos_x": None,
            "pos_y": None,
            "pos_z": None,
        }
    except Exception:
        return None
