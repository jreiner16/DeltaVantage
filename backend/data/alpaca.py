"""Alpaca Markets data provider (equities + crypto, free tier)."""

from __future__ import annotations

from datetime import UTC, datetime

import pandas as pd

from backend.config import ALPACA_API_KEY, ALPACA_SECRET_KEY
from backend.data.provider import DataProvider

_ALPACA_INTERVAL_MAP = {
    "1Min": "1Min",
    "5Min": "5Min",
    "15Min": "15Min",
    "30Min": "30Min",
    "1Hour": "1Hour",
    "1Day": "1Day",
}


class AlpacaProvider(DataProvider):
    def __init__(self) -> None:
        self._client = None
        self._crypto_client = None

    def _get_stock_client(self):
        if self._client is None:
            from alpaca.data import StockHistoricalDataClient

            self._client = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)
        return self._client

    def _get_crypto_client(self):
        if self._crypto_client is None:
            from alpaca.data import CryptoHistoricalDataClient

            self._crypto_client = CryptoHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)
        return self._crypto_client

    def get_bars(
        self, symbol: str, interval: str, start: datetime, end: datetime | None = None
    ) -> pd.DataFrame:
        alpaca_interval = _ALPACA_INTERVAL_MAP.get(interval)
        if alpaca_interval is None:
            raise ValueError(f"Unsupported interval: {interval}")

        if end is None:
            end = datetime.now(UTC)

        if self.symbol_is_crypto(symbol):
            return self._get_crypto_bars(symbol, alpaca_interval, start, end)
        return self._get_stock_bars(symbol, alpaca_interval, start, end)

    def _get_stock_bars(
        self, symbol: str, interval: str, start: datetime, end: datetime
    ) -> pd.DataFrame:
        from alpaca.data.requests import StockBarsRequest

        client = self._get_stock_client()
        request = StockBarsRequest(
            symbol_or_symbols=[symbol],
            timeframe=alpaca_timeframe(interval),
            start=start,
            end=end,
            feed="iex",
        )
        bars = client.get_stock_bars(request)
        df = bars.df
        if isinstance(df.index, pd.MultiIndex):
            df = df.droplevel("symbol")
        return df[["open", "high", "low", "close", "volume"]].rename(
            columns={
                "open": "Open",
                "high": "High",
                "low": "Low",
                "close": "Close",
                "volume": "Volume",
            }
        )

    def _get_crypto_bars(
        self, symbol: str, interval: str, start: datetime, end: datetime
    ) -> pd.DataFrame:
        from alpaca.data.requests import CryptoBarsRequest

        client = self._get_crypto_client()
        # Alpaca crypto uses "/" notation, e.g. "BTC/USD"
        if "/" not in symbol:
            if symbol.endswith("USD"):
                symbol = f"{symbol[:-3]}/{symbol[-3:]}"
            else:
                symbol = f"{symbol}/USD"
        request = CryptoBarsRequest(
            symbol_or_symbols=[symbol],
            timeframe=alpaca_timeframe(interval),
            start=start,
            end=end,
        )
        bars = client.get_crypto_bars(request)
        df = bars.df
        if isinstance(df.index, pd.MultiIndex):
            df = df.droplevel("symbol")
        return df[["open", "high", "low", "close", "volume"]].rename(
            columns={
                "open": "Open",
                "high": "High",
                "low": "Low",
                "close": "Close",
                "volume": "Volume",
            }
        )

    def get_latest_price(self, symbol: str) -> float:
        if self.symbol_is_crypto(symbol):
            from alpaca.data.requests import CryptoLatestQuoteRequest

            client = self._get_crypto_client()
            if "/" not in symbol:
                if symbol.endswith("USD"):
                    symbol = f"{symbol[:-3]}/{symbol[-3:]}"
                else:
                    symbol = f"{symbol}/USD"
            request = CryptoLatestQuoteRequest(symbol_or_symbols=[symbol])
            quote = client.get_crypto_latest_quote(request)
            return float(quote[symbol].ask_price)
        else:
            from alpaca.data.requests import StockLatestQuoteRequest

            client = self._get_stock_client()
            request = StockLatestQuoteRequest(symbol_or_symbols=[symbol])
            quote = client.get_stock_latest_quote(request)
            return float(quote[symbol].ask_price)


def alpaca_timeframe(interval: str):
    """Convert our interval string to an Alpaca TimeFrame object."""
    from alpaca.data import TimeFrame

    mapping = {
        "1Min": TimeFrame.Minute,
        "5Min": TimeFrame(5, "Min"),
        "15Min": TimeFrame(15, "Min"),
        "30Min": TimeFrame(30, "Min"),
        "1Hour": TimeFrame.Hour,
        "1Day": TimeFrame.Day,
    }
    factory = mapping.get(interval)
    if factory is None:
        raise ValueError(f"Unknown interval: {interval}")
    if callable(factory) and not isinstance(factory, type):
        return factory()
    return factory
