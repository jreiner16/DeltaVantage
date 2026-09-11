"""yfinance provider — used ONLY for one-time historical data bootstrap."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from threading import Lock

import pandas as pd
import socket
import yfinance as yf

from backend.data.provider import DataProvider

_INTERVAL_MAP = {
    "1Min": "1m",
    "5Min": "5m",
    "15Min": "15m",
    "30Min": "30m",
    "1Hour": "1h",
    "1Day": "1d",
}

# Yahoo caps how far back intraday data can go; 1m history only exists for
# the last 7 days no matter what period is requested. Clamp the window so a
# single request covers most of the span instead of fanning out into dozens
# of pointless calls (e.g. "1Min, 90d" previously meant 13 requests, 12 of
# which returned empty frames).
_MAX_LOOKBACK_DAYS = {
    "1m": 7,
    "5m": 30,
    "15m": 45,
    "30m": 45,
    "1h": 730,
    "1d": 10_000,
}

_MAX_WORKERS = 6
_REQUEST_TIMEOUT_S = 20


def _fetch_chunk(args: tuple) -> pd.DataFrame:
    """Fetch a single time-range chunk. Runs in a thread."""
    symbol, yf_interval, chunk_start, chunk_end = args
    socket.setdefaulttimeout(_REQUEST_TIMEOUT_S)
    ticker = yf.Ticker(symbol)
    df = ticker.history(start=chunk_start, end=chunk_end, interval=yf_interval)
    return df


class YFinanceProvider(DataProvider):
    def get_bars(
        self, symbol: str, interval: str, start: datetime, end: datetime | None = None
    ) -> pd.DataFrame:
        yf_interval = _INTERVAL_MAP.get(interval)
        if yf_interval is None:
            raise ValueError(f"Unsupported interval: {interval}")

        if end is None:
            end = datetime.now(UTC)

        chunk_days = _MAX_LOOKBACK_DAYS.get(yf_interval, 45)
        start = max(start, end - timedelta(days=chunk_days))

        # Build the list of chunks to fetch
        chunks: list[tuple] = []
        cursor = start
        while cursor < end:
            window_end = min(cursor + timedelta(days=chunk_days), end)
            chunks.append((symbol, yf_interval, cursor, window_end))
            cursor = window_end

        if not chunks:
            return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"])

        # Fetch all chunks in parallel
        frames: list[pd.DataFrame] = []
        lock = Lock()

        def _do_fetch(chunk_args: tuple) -> pd.DataFrame | None:
            try:
                return _fetch_chunk(chunk_args)
            except Exception:
                return None

        with ThreadPoolExecutor(max_workers=min(_MAX_WORKERS, len(chunks))) as pool:
            futures = {pool.submit(_do_fetch, c): c for c in chunks}
            for future in as_completed(futures):
                result = future.result()
                if result is not None and not result.empty:
                    with lock:
                        frames.append(result)

        if not frames:
            return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"])

        frames.sort(key=lambda f: f.index[0])
        result = pd.concat(frames)
        if "Datetime" in result.columns:
            result = result.set_index("Datetime")
        result = result[["Open", "High", "Low", "Close", "Volume"]].copy()
        result.index = (
            pd.DatetimeIndex(result.index).tz_convert("UTC")
            if result.index.tz is not None
            else pd.DatetimeIndex(result.index, tz="UTC")
        )
        return result

    def get_latest_price(self, symbol: str) -> float:
        ticker = yf.Ticker(symbol)
        info = ticker.fast_info
        return float(info["lastPrice"])
