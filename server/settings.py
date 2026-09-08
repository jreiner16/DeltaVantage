"""Persist settings via JSON (slippage, theme, etc)
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

SETTINGS_FILE = Path(__file__).resolve().parent.parent / ".dv-settings.json"

DEFAULTS = {
    "slippage": 0.001,  # fractional, 0.001 == 0.1%
    "share_increment": 1,  # min quantity step (1 = whole shares)
    "min_order_qty": 1,
    "max_order_qty": 1_000_000,
    "starting_cash": 100_000.00,
    "short_leverage": 1.0,  # max short notional as a multiple of account equity
    "theme": "dark",  # "dark" | "light" | "mid"
    "default_interval": "1Min",
    "default_lookback_days": 7,
}

_ALLOWED = set(DEFAULTS)


class Settings:
    def __init__(self, path: Path = SETTINGS_FILE) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._data = dict(DEFAULTS)
        self._load()

    def _load(self) -> None:
        try:
            if self.path.exists():
                loaded = json.loads(self.path.read_text())
                self._data.update({k: v for k, v in loaded.items() if k in _ALLOWED})
        except Exception:
            pass

    def _save(self) -> None:
        try:
            self.path.write_text(json.dumps(self._data, indent=2))
        except Exception:
            pass

    def reload(self, path: Path) -> None:
        with self._lock:
            self.path = path
            self._data = dict(DEFAULTS)
            self._load()

    def all(self) -> dict:
        with self._lock:
            return dict(self._data)

    def get(self, key: str):
        with self._lock:
            return self._data.get(key)

    def update(self, patch: dict) -> dict:
        with self._lock:
            for k, v in patch.items():
                if k not in _ALLOWED:
                    continue
                if k == "slippage":
                    v = max(0.0, float(v))
                elif k == "share_increment":
                    v = max(0.000001, float(v)) if v is not None else None
                elif k == "min_order_qty" or k == "max_order_qty":
                    v = max(1, int(v))
                elif k == "starting_cash":
                    v = max(0.0, float(v))
                elif k == "short_leverage":
                    v = max(0.0, min(float(v), 10.0))
                elif k == "theme":
                    v = v if v in {"light", "dark", "mid"} else "dark"
                elif k == "default_interval":
                    v = v if v in {"1Min", "5Min", "15Min", "1Hour", "1Day"} else "1Min"
                elif k == "default_lookback_days":
                    v = max(1, min(int(v), 365))
                if v is not None:
                    self._data[k] = v
            self._save()
            return dict(self._data)


settings = Settings()
