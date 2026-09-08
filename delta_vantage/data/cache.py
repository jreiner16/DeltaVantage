"""SQLite-backed OHLCV cache."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from threading import RLock

import pandas as pd

from delta_vantage.config import CACHE_DB

_CREATE = """
CREATE TABLE IF NOT EXISTS bars (
    symbol    TEXT    NOT NULL,
    interval  TEXT    NOT NULL,
    timestamp TEXT    NOT NULL,
    open      REAL,
    high      REAL,
    low       REAL,
    close     REAL,
    volume    REAL,
    PRIMARY KEY (symbol, interval, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_bars_lookup ON bars(symbol, interval, timestamp);
"""


class BarCache:
    def __init__(self, db_path: Path = CACHE_DB) -> None:
        self._db_path = db_path
        # check_same_thread=False lets the cache be shared across threads
        # (e.g. a FastAPI web server); the RLock serialises concurrent access.
        self._lock = RLock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        with self._lock:
            self._conn.executescript(_CREATE)

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def get_bars(
        self, symbol: str, interval: str, start: datetime, end: datetime | None = None
    ) -> pd.DataFrame | None:
        """Return cached bars, or None if nothing is cached for this range."""
        sql = "SELECT * FROM bars WHERE symbol = ? AND interval = ? AND timestamp >= ?"
        params: list = [symbol, interval, start.isoformat()]
        if end is not None:
            sql += " AND timestamp <= ?"
            params.append(end.isoformat())
        sql += " ORDER BY timestamp"

        with self._lock:
            df = pd.read_sql_query(sql, self._conn, params=params)
        if df.empty:
            return None
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        df.set_index("timestamp", inplace=True)
        df.rename(
            columns={
                "open": "Open",
                "high": "High",
                "low": "Low",
                "close": "Close",
                "volume": "Volume",
            },
            inplace=True,
        )
        return df[["Open", "High", "Low", "Close", "Volume"]]

    def get_latest_timestamp(self, symbol: str, interval: str) -> datetime | None:
        with self._lock:
            cur = self._conn.execute(
                "SELECT MAX(timestamp) FROM bars WHERE symbol = ? AND interval = ?",
                (symbol, interval),
            )
            row = cur.fetchone()
        if row and row[0]:
            return datetime.fromisoformat(row[0])
        return None

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def upsert_bars(self, symbol: str, interval: str, df: pd.DataFrame) -> int:
        """Insert or replace bars. Returns count of rows affected."""
        if df.empty:
            return 0
        rows = []
        for ts, row in df.iterrows():
            ts_str = ts.isoformat()
            rows.append(
                (
                    symbol,
                    interval,
                    ts_str,
                    float(row.get("Open", row.get("open", 0))),
                    float(row.get("High", row.get("high", 0))),
                    float(row.get("Low", row.get("low", 0))),
                    float(row.get("Close", row.get("close", 0))),
                    float(row.get("Volume", row.get("volume", 0))),
                )
            )
        with self._lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO bars VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            self._conn.commit()
        return len(rows)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def symbol_count(self) -> dict[str, int]:
        with self._lock:
            cur = self._conn.execute("SELECT symbol, COUNT(*) FROM bars GROUP BY symbol")
            return dict(cur.fetchall())

    def close(self) -> None:
        with self._lock:
            self._conn.close()
