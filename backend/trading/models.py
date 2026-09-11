"""Trading domain models."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class Side(Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(Enum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"


class OrderStatus(Enum):
    PENDING = "pending"
    FILLED = "filled"
    PARTIAL = "partial"
    CANCELLED = "cancelled"
    REJECTED = "rejected"


@dataclass
class Order:
    id: str
    symbol: str
    side: Side
    order_type: OrderType
    qty: float
    limit_price: float | None = None
    stop_price: float | None = None
    status: OrderStatus = OrderStatus.PENDING
    created_at: datetime | None = None
    filled_at: datetime | None = None
    fill_price: float | None = None


@dataclass
class Trade:
    order_id: str
    symbol: str
    side: Side
    qty: float
    price: float
    timestamp: datetime


@dataclass
class Position:
    symbol: str
    qty: float
    avg_entry_price: float
    current_price: float

    @property
    def market_value(self) -> float:
        return self.qty * self.current_price

    @property
    def unrealized_pnl(self) -> float:
        return (self.current_price - self.avg_entry_price) * self.qty

    @property
    def unrealized_pnl_pct(self) -> float:
        if self.avg_entry_price == 0:
            return 0.0
        pct = (self.current_price - self.avg_entry_price) / self.avg_entry_price * 100.0
        # Short positions profit when price falls, so flip the sign.
        return pct * (-1.0 if self.qty < 0 else 1.0)


@dataclass
class Portfolio:
    cash: float
    positions: dict[str, Position] = field(default_factory=dict)
    total_value: float = 0.0
    unrealized_pnl: float = 0.0
    realized_pnl: float = 0.0
    trades: list[Trade] = field(default_factory=list)
    # Cash free to deploy on new buys (short proceeds are held as collateral).
    buying_power: float = 0.0
    # Additional dollar-notional that can be shorted before hitting the limit.
    short_buying_power: float = 0.0

    @property
    def invested(self) -> float:
        return sum(p.market_value for p in self.positions.values())

    @property
    def num_positions(self) -> int:
        return len(self.positions)

    @property
    def num_trades(self) -> int:
        return len(self.trades)
