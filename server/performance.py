"""Save equity/performance stats etc in-memory
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

PERF_FILE = Path(__file__).resolve().parent.parent / ".dv-performance.json"
_SAMPLE_SECONDS = 5.0
_MAX_POINTS = 10_000


class PerformanceRecorder:
    def __init__(self, path: Path = PERF_FILE) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._points: list[dict] = []
        self._last_sample = 0.0
        self._load()

    def _load(self) -> None:
        try:
            if self.path.exists():
                data = json.loads(self.path.read_text())
                self._points = [
                    {"t": float(p["t"]), "equity": float(p["equity"]), "cash": float(p["cash"])}
                    for p in data.get("points", [])
                ]
        except Exception:
            self._points = []

    def _save(self) -> None:
        try:
            self.path.write_text(json.dumps({"points": self._points}, indent=2))
        except Exception:
            pass

    def reload(self, path: Path) -> None:
        with self._lock:
            self.path = path
            self._points = []
            self._last_sample = 0.0
            self._load()

    def sample(self, equity: float, cash: float) -> None:
        with self._lock:
            now = time.time()
            if now - self._last_sample < _SAMPLE_SECONDS:
                # Only adjust the trailing value if it's the same tick window.
                if self._points:
                    self._points[-1] = {
                        "t": now,
                        "equity": round(equity, 2),
                        "cash": round(cash, 2),
                    }
                return
            self._last_sample = now
            self._points.append(
                {
                    "t": now,
                    "equity": round(equity, 2),
                    "cash": round(cash, 2),
                }
            )
            if len(self._points) > _MAX_POINTS:
                self._points = self._points[-_MAX_POINTS:]
            self._save()

    def points(self) -> list[dict]:
        with self._lock:
            return list(self._points)

    def reset(self) -> None:
        with self._lock:
            self._points = []
            self._last_sample = 0.0
            self._save()


performance = PerformanceRecorder()
