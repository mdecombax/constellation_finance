"""Accès batch à Yahoo Finance via l'endpoint v7/quote.

Au lieu de 10840 requêtes fast_info (qui déclenchent 401 Invalid Crumb +
rate-limit), on récupère ~100 symboles par requête avec un cookie+crumb
établis une seule fois. ~110 requêtes au lieu de 10840.

Utilise curl_cffi (embarqué avec yfinance) en impersonant un navigateur
pour passer les défenses anti-bot de Yahoo.
"""
import time

from curl_cffi import requests as cffi_requests

QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb"
COOKIE_URL = "https://fc.yahoo.com"
IMPERSONATE = "chrome"


def make_session():
    """Crée une session curl_cffi avec cookie + crumb Yahoo valides."""
    s = cffi_requests.Session(impersonate=IMPERSONATE)
    # 1) cookie (l'appel renvoie souvent 404/401 mais pose le cookie A3)
    try:
        s.get(COOKIE_URL, timeout=15)
    except Exception:
        pass
    # 2) crumb lié au cookie
    r = s.get(CRUMB_URL, timeout=15)
    crumb = r.text.strip()
    if not crumb or "<html" in crumb.lower():
        raise RuntimeError(f"Crumb invalide: {crumb!r}")
    return s, crumb


def fetch_quotes(session, crumb, symbols):
    """Récupère un lot de symboles. Retourne {symbol: quote_dict}."""
    params = {
        "symbols": ",".join(symbols),
        "crumb": crumb,
        "fields": ("symbol,longName,shortName,quoteType,fullExchangeName,"
                   "marketCap,netAssets,regularMarketPrice,regularMarketOpen,"
                   "regularMarketVolume,averageDailyVolume3Month,"
                   "regularMarketChangePercent"),
    }
    r = session.get(QUOTE_URL, params=params, timeout=20)
    r.raise_for_status()
    data = r.json()
    out = {}
    for q in data.get("quoteResponse", {}).get("result", []):
        sym = q.get("symbol")
        if sym:
            out[sym] = q
    return out


def fetch_all(symbols, batch_size=100, pause=0.4, max_retries=3, log=print):
    """Récupère tous les symboles par lots. Retourne {symbol: quote_dict}."""
    session, crumb = make_session()
    log(f"Session Yahoo établie (crumb={crumb[:8]}...)")
    results = {}
    total = len(symbols)
    for i in range(0, total, batch_size):
        lot = symbols[i:i + batch_size]
        for attempt in range(max_retries):
            try:
                results.update(fetch_quotes(session, crumb, lot))
                break
            except Exception as e:
                if attempt == max_retries - 1:
                    log(f"  lot {i}-{i+len(lot)} échoué: {e}")
                else:
                    # crumb peut expirer -> on en refait un
                    time.sleep(1.0 + attempt)
                    try:
                        session, crumb = make_session()
                    except Exception:
                        pass
        if (i // batch_size) % 10 == 0:
            log(f"  [batch] {min(i+batch_size, total)}/{total} | ok={len(results)}")
        time.sleep(pause)
    return results


PROFILE_URL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{sym}"
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"


def fetch_profile(session, crumb, sym):
    """Retourne {sector, beta} pour un symbole (quoteSummary)."""
    params = {"modules": "assetProfile,defaultKeyStatistics,summaryDetail",
              "crumb": crumb}
    try:
        r = session.get(PROFILE_URL.format(sym=sym), params=params, timeout=15)
        if r.status_code != 200:
            return {"sector": None, "beta": None}
        res = r.json().get("quoteSummary", {}).get("result")
        if not res:
            return {"sector": None, "beta": None}
        m = res[0]
        sector = m.get("assetProfile", {}).get("sector")
        beta = m.get("defaultKeyStatistics", {}).get("beta") or \
            m.get("summaryDetail", {}).get("beta")
        beta = beta.get("raw") if isinstance(beta, dict) else None
        return {"sector": sector, "beta": beta}
    except Exception:
        return {"sector": None, "beta": None}


SPARK_URL = "https://query1.finance.yahoo.com/v7/finance/spark"


def _vol_from_closes(closes):
    """Écart-type des rendements log quotidiens sur ~30 séances."""
    import math
    closes = [c for c in (closes or []) if c]
    if len(closes) < 5:
        return None
    rets = [math.log(closes[i] / closes[i - 1])
            for i in range(1, len(closes))][-30:]
    if len(rets) < 2:
        return None
    mean = sum(rets) / len(rets)
    var = sum((x - mean) ** 2 for x in rets) / (len(rets) - 1)
    return round(math.sqrt(var), 4)


def fetch_volatility(session, sym):
    """Volatilité 30j d'UN symbole (chart endpoint). Conservé pour usage unitaire."""
    try:
        r = session.get(CHART_URL.format(sym=sym),
                        params={"range": "2mo", "interval": "1d"}, timeout=15)
        if r.status_code != 200:
            return None
        res = r.json().get("chart", {}).get("result")
        if not res:
            return None
        return _vol_from_closes(res[0]["indicators"]["quote"][0]["close"])
    except Exception:
        return None


def fetch_volatility_batch(symbols, batch_size=20, pause=0.3, max_retries=3,
                           log=print):
    """Volatilité 30j EN LOT via l'endpoint spark (max 20 sym/req côté Yahoo).

    Bien plus robuste que 4000 requêtes chart individuelles : ~80 requêtes
    séquentielles au lieu d'une rafale multithread qui déclenche le rate-limit
    429 de Yahoo depuis les IP datacenter. Retourne {symbol: vol|None}.
    """
    session, crumb = make_session()
    out = {}
    total = len(symbols)
    for i in range(0, total, batch_size):
        lot = symbols[i:i + batch_size]
        for attempt in range(max_retries):
            try:
                r = session.get(SPARK_URL, params={
                    "symbols": ",".join(lot),
                    "range": "2mo", "interval": "1d"}, timeout=20)
                r.raise_for_status()
                res = r.json().get("spark", {}).get("result", []) or []
                for item in res:
                    sym = item.get("symbol")
                    try:
                        closes = item["response"][0]["indicators"]["quote"][0]["close"]
                        out[sym] = _vol_from_closes(closes)
                    except Exception:
                        out[sym] = None
                break
            except Exception as e:
                if attempt == max_retries - 1:
                    log(f"  spark lot {i}-{i+len(lot)} échoué: {e}")
                else:
                    time.sleep(1.0 + attempt)
                    try:
                        session, crumb = make_session()
                    except Exception:
                        pass
        if (i // batch_size) % 10 == 0:
            log(f"  [spark] {min(i+batch_size, total)}/{total} | ok={len(out)}")
        time.sleep(pause)
    return out


if __name__ == "__main__":
    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from universe import build_universe

    # Test de robustesse : 300 symboles d'affilée (3 lots)
    uni = build_universe()
    syms = [u["ticker"] for u in uni[:300]]
    t0 = time.time()
    res = fetch_all(syms, batch_size=100, pause=0.4)
    dt = time.time() - t0
    sized = sum(1 for q in res.values()
                if q.get("marketCap") or q.get("netAssets"))
    print(f"\n{len(res)}/{len(syms)} récupérés, {sized} avec taille (mc|netAssets) "
          f"en {dt:.1f}s")
    for sym in ["AACB", "AAPL"]:
        q = res.get(sym, {})
        if q:
            print(f"  {sym}: mc={q.get('marketCap')} netAssets={q.get('netAssets')} "
                  f"type={q.get('quoteType')} name={q.get('longName')}")
