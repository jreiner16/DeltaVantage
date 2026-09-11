"""Runs strategies on live bar data """

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from backend.data.cache import BarCache
from backend.strategy.base import Bar, Strategy
from backend.strategy.context import StrategyContext
from backend.trading.paper import PaperBroker

logger = logging.getLogger(__name__)

_INTERVAL_SECONDS = {
    "1Min": 60,
    "5Min": 300,
    "15Min": 900,
    "30Min": 1800,
    "1Hour": 3600,
    "1Day": 86400,
}


@dataclass
class RunningStrategy:
    strategy_name: str
    symbol: str
    interval: str
    params: dict[str, Any]
    last_bar_at: datetime | None = None
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    bars_processed: int = 0
    logs: list[str] = field(default_factory=list)
    _instance: Strategy | None = field(default=None, repr=False)
    _context: StrategyContext | None = field(default=None, repr=False)
    _errored: bool = field(default=False, repr=False)

    def to_dict(self) -> dict:
        return {
            "key": f"{self.strategy_name}:{self.symbol}",
            "strategy": self.strategy_name,
            "symbol": self.symbol,
            "interval": self.interval,
            "params": self.params,
            "started_at": self.started_at.isoformat(),
            "last_bar_at": self.last_bar_at.isoformat() if self.last_bar_at else None,
            "bars_processed": self.bars_processed,
            "logs": self.logs[-50:],
        }


class LiveStrategyManager:
    def __init__(self, broker: PaperBroker, cache: BarCache) -> None:
        self._broker = broker
        self._cache = cache
        self._running: dict[str, RunningStrategy] = {}
        self._lock = threading.RLock()

    def _key(self, strategy_name: str, symbol: str) -> str:
        return f"{strategy_name}:{symbol}"

    def start(
        self,
        strategy_name: str,
        symbol: str,
        interval: str = "15Min",
        params: dict[str, Any] | None = None,
    ) -> RunningStrategy:
        key = self._key(strategy_name, symbol)
        with self._lock:
            if key in self._running:
                raise ValueError(f"Strategy '{strategy_name}' is already live on {symbol}")
            from pathlib import Path

            from backend.strategy.engine import load_strategy

            strategies_dir = Path(__file__).resolve().parent.parent / "strategies"
            path = strategies_dir / f"{strategy_name}.py"
            if not path.exists():
                raise ValueError(f"Strategy '{strategy_name}' not found")

            cls = load_strategy(path)
            instance = cls()
            if params:
                instance.params = params

            ctx = StrategyContext(self._broker, self._cache, symbols=[symbol])
            instance.ctx = ctx

            try:
                instance.start()
            except Exception as exc:
                logger.exception("Live strategy start() failed: %s", exc)
                instance.ctx.log(f"ERROR during start(): {exc}")

            entry = RunningStrategy(
                strategy_name=strategy_name,
                symbol=symbol,
                interval=interval,
                params=params or {},
                _instance=instance,
                _context=ctx,
            )
            self._running[key] = entry
            logger.info("Live strategy started: %s on %s (%s)", strategy_name, symbol, interval)
            return entry

    def stop(self, key: str) -> bool:
        with self._lock:
            entry = self._running.pop(key, None)
            if entry is None:
                return False
            if entry._instance is not None:
                try:
                    entry._instance.stop()
                except Exception:
                    pass
            logger.info("Live strategy stopped: %s", key)
            return True

    def stop_all(self) -> int:
        with self._lock:
            keys = list(self._running.keys())
        count = 0
        for key in keys:
            if self.stop(key):
                count += 1
        return count

    def get_running(self) -> list[RunningStrategy]:
        with self._lock:
            return list(self._running.values())

    def get_for_symbol(self, symbol: str) -> list[RunningStrategy]:
        with self._lock:
            return [r for r in self._running.values() if r.symbol == symbol]

    def tick(self) -> None:
        with self._lock:
            entries = list(self._running.values())

        for entry in entries:
            if entry._errored or entry._instance is None:
                continue
            try:
                self._process_entry(entry)
            except Exception as exc:
                logger.exception(
                    "Live strategy tick error for %s:%s — stopping: %s",
                    entry.strategy_name, entry.symbol, exc,
                )
                entry.logs.append(f"ERROR: {exc}")
                entry._errored = True
                self.stop(self._key(entry.strategy_name, entry.symbol))

    def _process_entry(self, entry: RunningStrategy) -> None:
        from backend.data.alpaca import AlpacaProvider
        from backend.data.yfinance import YFinanceProvider

        symbol = entry.symbol
        interval = entry.interval
        now = datetime.now(UTC)

        # Pull recent bars so the cache advances. Alpaca first (if keys are
        # configured), fall back to yfinance. Best effort either way.
        try:
            step = _INTERVAL_SECONDS.get(interval, 900)
            start = now - timedelta(days=2 if step < 86400 else 5)
            try:
                df = AlpacaProvider().get_bars(symbol, interval, start, now)
            except Exception:
                df = None
            if df is None or df.empty:
                # yfinance uses a dash for crypto (BTC-USD, not BTC/USD).
                df = YFinanceProvider().get_bars(symbol.replace("/", "-"), interval, start, now)
            if df is not None and not df.empty:
                self._cache.upsert_bars(symbol, interval, df)
        except Exception:
            pass

        lookback_days = max(1, 365 if interval == "1Day" else 90)
        df = self._cache.get_bars(symbol, interval, now - timedelta(days=lookback_days), now)
        if df is None or df.empty:
            return

        # First tick: baseline on the newest cached bar so we only feed bars
        # that print after the strategy started, no replaying history.
        if entry.last_bar_at is None:
            if len(df) > 0:
                latest = df.index[-1]
                entry.last_bar_at = latest.to_pydatetime() if hasattr(latest, "to_pydatetime") else latest
            return

        bars: list[Bar] = []
        for ts, r in df.iterrows():
            bar_ts = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
            if bar_ts > entry.last_bar_at:
                bars.append(
                    Bar(
                        symbol=symbol,
                        timestamp=bar_ts,
                        open=float(r["Open"]),
                        high=float(r["High"]),
                        low=float(r["Low"]),
                        close=float(r["Close"]),
                        volume=float(r["Volume"]),
                    )
                )

        if not bars:
            return

        for bar in bars:
            # Pin get_data to <= this bar so a replay (catch-up after the app
            # was closed) doesn't let indicators peek at future bars.
            if entry._context is not None:
                entry._context.set_backtest_asof(bar.timestamp)
            try:
                entry._instance.on_bar(bar)
            except Exception as exc:
                entry.logs.append(f"ERROR on_bar({bar.timestamp}): {exc}")
                logger.exception(
                    "Live strategy on_bar error: %s:%s", entry.strategy_name, symbol
                )
                raise  # intentional — kills the strategy so we surface the bug

            # market orders fill at bar close, limit/stop checked against the range
            try:
                from backend.strategy.engine import _check_pending_order

                for order in self._broker.get_pending_orders():
                    if order.symbol == symbol:
                        _check_pending_order(self._broker, order, bar)
            except Exception:
                pass

            entry.bars_processed += 1
            entry.last_bar_at = bar.timestamp

        if entry._context is not None:
            entry._context.set_backtest_asof(None)

        if entry._context is not None and entry._context._log_buffer:
            entry.logs.extend(entry._context._log_buffer)
            entry._context._log_buffer = []
            if len(entry.logs) > 200:
                entry.logs = entry.logs[-200:]

    # ── persistence ─────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        with self._lock:
            return {
                key: {
                    "strategy": e.strategy_name,
                    "symbol": e.symbol,
                    "interval": e.interval,
                    "params": e.params,
                    "started_at": e.started_at.isoformat(),
                    "last_bar_at": e.last_bar_at.isoformat() if e.last_bar_at else None,
                    "bars_processed": e.bars_processed,
                }
                for key, e in self._running.items()
            }

    def restore(self, data: dict) -> None:
        for key, entry_data in data.items():
            try:
                entry = self.start(
                    strategy_name=entry_data["strategy"],
                    symbol=entry_data["symbol"],
                    interval=entry_data.get("interval", "15Min"),
                    params=entry_data.get("params", {}),
                )
                # Carry the last-seen bar forward so the first tick after a
                # restart replays everything that printed while we were down.
                last_bar_at = entry_data.get("last_bar_at")
                if last_bar_at:
                    try:
                        entry.last_bar_at = datetime.fromisoformat(last_bar_at)
                    except ValueError:
                        entry.last_bar_at = None
                entry.bars_processed = entry_data.get("bars_processed", 0)
            except Exception as exc:
                logger.warning("Failed to restore live strategy %s: %s", key, exc)