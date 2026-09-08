"""Store list of symbols user wants in their watchlist.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

# load watchilst file
WATCHLIST_FILE = Path(__file__).resolve().parent.parent / ".dv-watchlist.json"

SEARCH_UNIVERSE = [
    "AAPL",
    "MSFT",
    "GOOGL",
    "AMZN",
    "NVDA",
    "TSLA",
    "META",
    "SPY",
    "QQQ",
    "AMD",
    "PLTR",
    "NFLX",
    "DIS",
    "CRM",
    "INTC",
    "AMC",
    "COIN",
    "BABA",
    "SHOP",
    "UBER",
    "NKE",
    "JPM",
    "BAC",
    "BTC/USD",
    "ETH/USD",
    "SOL/USD",
    "DOGE/USD",
]

# Symbols shown by default on a fresh portfolios
DEFAULT_WATCHLIST = [
    "AAPL",
    "MSFT",
    "GOOGL",
    "AMZN",
    "NVDA",
    "TSLA",
    "META",
    "SPY",
    "QQQ",
    "BTC/USD",
    "ETH/USD",
    "AMD",
    "PLTR",
    "NFLX",
    "DIS",
    "CRM",
]


class Watchlist:
    def __init__(self, path: Path = WATCHLIST_FILE) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._symbols: list[str] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            self._symbols = list(DEFAULT_WATCHLIST)
            self._save()
            return
        try:
            data = json.loads(self.path.read_text())
            self._symbols = [
                str(s).upper() for s in data.get("symbols", []) if isinstance(s, str) and s.strip()
            ]
        except Exception:
            self._symbols = list(DEFAULT_WATCHLIST)

    def _save(self) -> None:
        try:
            self.path.write_text(json.dumps({"symbols": self._symbols}, indent=2))
        except Exception:
            pass

    def reload(self, path: Path) -> None:
        with self._lock:
            self.path = path
            self._symbols = []
            self._load()

    def all(self) -> list[str]:
        with self._lock:
            return list(self._symbols)

    def add(self, symbol: str) -> list[str]:
        with self._lock:
            s = symbol.upper().strip()
            if s and s not in self._symbols:
                self._symbols.append(s)
                self._save()
            return list(self._symbols)

    def remove(self, symbol: str) -> list[str]:
        with self._lock:
            s = symbol.upper().strip()
            if s in self._symbols:
                self._symbols.remove(s)
                self._save()
            return list(self._symbols)

    def reorder(self, symbols: list[str]) -> list[str]:
        with self._lock:
            known = set(self._symbols)
            new = [str(s).upper().strip() for s in symbols if str(s).upper().strip() in known]
            new += [s for s in self._symbols if s not in new]
            self._symbols = new
            self._save()
            return list(self._symbols)

    def reset(self) -> list[str]:
        with self._lock:
            self._symbols = list(DEFAULT_WATCHLIST)
            self._save()
            return list(self._symbols)


watchlist = Watchlist()
