"""Strategy base class — Unity-inspired lifecycle (Start / OnBar / OnTick)."""

from __future__ import annotations

from abc import ABC
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from delta_vantage.strategy.context import StrategyContext


@dataclass
class Bar:
    symbol: str
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class Tick:
    symbol: str
    timestamp: datetime
    price: float
    size: float = 0.0


class Strategy(ABC):
    """Base class for all trading strategies.

    Subclass and override any of:
        start()       — called once before the first bar
        on_bar(bar)   — called on each new OHLC candle
        on_tick(tick)  — called on each price tick (if streaming)
        on_order_filled(order) — called when an order is executed
    """

    def __init__(self) -> None:
        self.ctx: StrategyContext = None  # type: ignore[assignment]
        self.params: dict[str, Any] = {}

    # -- Lifecycle hooks ---------------------------------------------------

    def start(self) -> None:
        """Called once before the first bar. Override to initialise state."""

    def on_bar(self, bar: Bar) -> None:
        """Override to implement bar-level strategy logic."""

    def on_tick(self, tick: Tick) -> None:
        """Override to implement tick-level strategy logic."""

    def on_order_filled(self, order: Any) -> None:
        """Override to react to order fills."""

    def stop(self) -> None:
        """Called when the strategy is shut down. Override for cleanup."""
