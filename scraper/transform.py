"""Transformations dérivées : tout ce qui n'est pas scrapé directement."""
import math

# Codes d'exchange Yahoo -> noms lisibles
YF_EXCHANGE_MAP = {
    "NMS": "NASDAQ", "NGM": "NASDAQ", "NCM": "NASDAQ", "NIM": "NASDAQ",
    "NYQ": "NYSE", "ASE": "NYSE MKT", "PCX": "NYSE ARCA",
    "BTS": "BATS", "IEX": "IEX",
}


def map_exchange(yf_code: str | None, fallback: str = "") -> str:
    if not yf_code:
        return fallback
    return YF_EXCHANGE_MAP.get(yf_code, fallback or yf_code)


def safe_log10(market_cap) -> float | None:
    if not market_cap or market_cap <= 0:
        return None
    return round(math.log10(market_cap), 2)


def volume_norm(volume, avg_volume) -> float | None:
    if not volume or not avg_volume:
        return None
    return round(volume / avg_volume, 3)


def change_pct(price, price_open) -> float | None:
    if not price or not price_open:
        return None
    return round((price - price_open) / price_open * 100, 2)


def volatility_30d(closes: list[float]) -> float | None:
    """Écart-type des rendements log quotidiens sur ~30 séances (vol journalière)."""
    closes = [c for c in closes if c and c > 0]
    if len(closes) < 5:
        return None
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
    rets = rets[-30:]
    if len(rets) < 2:
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return round(math.sqrt(var), 4)
