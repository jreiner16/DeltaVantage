"""StrategyContext — the bridge between a strategy and the rest of the platform."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pandas as pd

from delta_vantage.data.cache import BarCache
from delta_vantage.indicators.technical import INDICATORS
from delta_vantage.trading.models import Order, Portfolio, Position
from delta_vantage.trading.paper import PaperBroker


class StrategyContext:
    def __init__(
        self,
        broker: PaperBroker,
        cache: BarCache,
        symbols: list[str],
        backtest_df: pd.DataFrame | None = None,
    ) -> None:
        self.broker = broker
        self.cache = cache
        self.symbols = symbols
        self._backtest_df = backtest_df
        self._asof: datetime | None = None
        self._log_buffer: list[str] = []
        self._quiet = False

    def set_backtest_asof(self, ts: datetime) -> None:
        """Pin the current bar timestamp so get_data only sees bars up to it."""
        self._asof = ts

    # ------------------------------------------------------------------
    # Data access
    # ------------------------------------------------------------------

    def get_data(self, symbol: str, interval: str = "15Min", lookback: int = 100) -> pd.DataFrame:
        """Return OHLCV data for *symbol* with at least *lookback* rows.

        In backtest mode this returns the backtest's own bars (up to the
        current bar); otherwise it reads the live cache.
        """
        if self._backtest_df is not None:
            df = self._backtest_df
            if df is None or df.empty:
                return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"])
            # Positional slice instead of a boolean mask — O(log n) per call
            # instead of O(rows), which matters when replaying long histories.
            pos = len(df)
            if self._asof is not None:
                pos = df.index.searchsorted(self._asof, side="right")
            return df.iloc[max(0, pos - lookback) : pos]

        now = datetime.now(UTC)
        # Request enough history — rough heuristic: lookback * interval_duration * 2
        start = now - timedelta(days=max(1, lookback // 10))
        df = self.cache.get_bars(symbol, interval, start, now)
        if df is None or df.empty:
            return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"])
        pos = len(df)
        if self._asof is not None:
            pos = df.index.searchsorted(self._asof, side="right")
        return df.iloc[max(0, pos - lookback) : pos]

    def get_indicator(
        self, symbol: str, indicator_name: str, lookback: int = 100, **kwargs: Any
    ) -> pd.Series | pd.DataFrame:
        """Compute an indicator on cached data."""
        func = INDICATORS.get(indicator_name)
        if func is None:
            raise ValueError(f"Unknown indicator: {indicator_name}")
        df = self.get_data(symbol, lookback=lookback + 50)  # extra rows for warmup
        if df.empty:
            return pd.Series(dtype=float)
        return func(df, **kwargs)

    # ------------------------------------------------------------------
    # Order management (delegates to broker)
    # ------------------------------------------------------------------

    def place_order(
        self,
        symbol: str,
        side: str,
        qty: int,
        order_type: str = "market",
        limit_price: float | None = None,
        stop_price: float | None = None,
    ) -> Order:
        return self.broker.place_order(symbol, side, qty, order_type, limit_price, stop_price)

    def cancel_order(self, order_id: str) -> bool:
        return self.broker.cancel_order(order_id)

    def get_position(self, symbol: str) -> Position | None:
        return self.broker.get_position(symbol)

    def get_portfolio(self) -> Portfolio:
        return self.broker.get_portfolio()

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------

    def log(self, msg: str) -> None:
        if self._quiet:
            return
        self._log_buffer.append(msg)
        print(f"  [LOG] {msg}")
