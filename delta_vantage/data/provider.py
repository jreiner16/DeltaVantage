"""Abstract data provider interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

import pandas as pd


class DataProvider(ABC):
    """All data sources implement this contract."""

    @abstractmethod
    def get_bars(
        self,
        symbol: str,
        interval: str,
        start: datetime,
        end: datetime | None = None,
    ) -> pd.DataFrame:
        """Return OHLCV bars as a DataFrame.

        Columns: Open, High, Low, Close, Volume
        Index: DatetimeIndex (timezone-aware, UTC)
        """

    @abstractmethod
    def get_latest_price(self, symbol: str) -> float:
        """Return the most recent price for *symbol*."""

    def symbol_is_crypto(self, symbol: str) -> bool:
        """Heuristic: does this symbol look like a crypto pair?"""
        return "/" in symbol or (symbol.endswith("USD") and len(symbol) >= 6)
