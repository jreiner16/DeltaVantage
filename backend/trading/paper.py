"""Paper trading broker — simulated order execution and portfolio tracking."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

from backend.trading.models import (
    Order,
    OrderStatus,
    OrderType,
    Portfolio,
    Position,
    Side,
    Trade,
)


class PaperBroker:
    """Simulates a brokerage for paper trading."""

    def __init__(
        self,
        initial_cash: float = 100_000.00,
        slippage: float = 0.0,
        share_increment: float = 1,
        min_order_qty: int = 1,
        max_order_qty: int = 1_000_000,
        short_leverage: float = 1.0,
    ) -> None:
        self._cash = initial_cash
        self._initial_cash = initial_cash
        self._positions: dict[str, Position] = {}
        self._orders: dict[str, Order] = {}
        self._trades: list[Trade] = []
        self._realized_pnl = 0.0
        self._slippage = slippage
        self._share_increment = share_increment
        self._min_order_qty = min_order_qty
        self._max_order_qty = max_order_qty
        # Max *total* short notional as a multiple of account equity. 1.0 means
        # you can short up to your account equity, 2.0 means twice equity, etc.
        self._short_leverage = max(0.0, float(short_leverage))

    def apply_settings(
        self,
        slippage: float | None = None,
        share_increment: float | None = None,
        min_order_qty: int | None = None,
        max_order_qty: int | None = None,
        short_leverage: float | None = None,
    ) -> None:
        if slippage is not None:
            self._slippage = max(0.0, slippage)
        if share_increment is not None:
            self._share_increment = max(0.000001, float(share_increment))
        if min_order_qty is not None:
            self._min_order_qty = max(1, int(min_order_qty))
        if max_order_qty is not None:
            self._max_order_qty = max(1, int(max_order_qty))
        if short_leverage is not None:
            self._short_leverage = max(0.0, min(10.0, float(short_leverage)))

    def reset(self, initial_cash: float | None = None) -> None:
        """Clear all positions/trades/pnl and restore cash (defaults to initial_cash)."""
        self._cash = initial_cash if initial_cash is not None else self._initial_cash
        self._initial_cash = self._cash
        self._positions = {}
        self._orders = {}
        self._trades = []
        self._realized_pnl = 0.0

    # ------------------------------------------------------------------
    # Order management
    # ------------------------------------------------------------------

    def place_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str = "market",
        limit_price: float | None = None,
        stop_price: float | None = None,
    ) -> Order:
        if qty <= 0:
            raise ValueError("Order quantity must be positive")
        # Crypto tickers (SYM/QUOTE) trade in fractional units, so the
        # integer "min order qty" doesn't apply. Equity qty stays 1+.
        is_crypto = "/" in symbol.upper()
        if not is_crypto and qty < self._min_order_qty:
            raise ValueError(f"Order below minimum quantity of {self._min_order_qty}")
        if not is_crypto and self._share_increment > 0:
            # Reject quantities that aren't a multiple of the share increment
            # (e.g. 3.5 shares with a 1-share increment).
            rem = qty % self._share_increment
            if rem > 1e-9 and self._share_increment - rem > 1e-9:
                raise ValueError(
                    f"Quantity must be a multiple of {self._share_increment:g}"
                )
        if qty > self._max_order_qty:
            raise ValueError(f"Order above maximum quantity of {self._max_order_qty}")
        now = datetime.now(UTC)
        order = Order(
            id=str(uuid.uuid4())[:8],
            symbol=symbol.upper(),
            side=Side(side.lower()),
            order_type=OrderType(order_type.lower()),
            qty=qty,
            limit_price=limit_price,
            stop_price=stop_price,
            status=OrderStatus.PENDING,
            created_at=now,
        )
        self._orders[order.id] = order
        return order

    def fill_order(self, order: Order, fill_price: float) -> Trade:
        """Execute a pending order at *fill_price* (slippage applied adversarially).

        Positions are signed: positive quantity = long, negative = short.
        A SELL with no long position (or exceeding it) opens a short; a BUY that
        reduces a short covers it. Shorts are bounded by the account's
        ``short_leverage`` equity cap and must be backed by reserved cash.
        """
        # Slippage: buyers pay a premium, sellers receive a discount.
        if order.side == Side.BUY:
            fill_price = fill_price * (1 + self._slippage)
        else:
            fill_price = fill_price * (1 - self._slippage)
        cost = order.qty * fill_price
        symbol = order.symbol
        pos = self._positions.get(symbol)

        if order.side == Side.BUY:
            if self._cash - self._short_reserved() < cost:
                order.status = OrderStatus.REJECTED
                raise ValueError(
                    f"Insufficient buying power: need ${cost:.2f}, have ${self._cash - self._short_reserved():.2f}"
                )
            self._cash -= cost
            if pos is not None and pos.qty < 0:
                # Covering an existing short.
                cover = min(order.qty, -pos.qty)
                realized = (pos.avg_entry_price - fill_price) * cover
                self._realized_pnl += realized
                pos.qty += cover
                pos.current_price = fill_price
                if abs(pos.qty) < 1e-9:
                    del self._positions[symbol]
                leftover = order.qty - cover
                if leftover > 0:
                    self._open_long(symbol, leftover, fill_price)
            else:
                self._open_long(symbol, order.qty, fill_price)
        else:  # SELL
            self._check_short_capacity(symbol, order.qty, pos, fill_price)
            self._cash += cost
            if pos is not None and pos.qty > 0:
                sold_long = min(order.qty, pos.qty)
                realized = (fill_price - pos.avg_entry_price) * sold_long
                self._realized_pnl += realized
                pos.qty -= sold_long
                pos.current_price = fill_price
                if pos.qty <= 1e-9:
                    del self._positions[symbol]
                short_qty = order.qty - sold_long
                if short_qty > 0:
                    self._open_short(symbol, short_qty, fill_price)
            else:
                self._open_short(symbol, order.qty, fill_price)

        order.status = OrderStatus.FILLED
        order.filled_at = datetime.now(UTC)
        order.fill_price = fill_price

        trade = Trade(
            order_id=order.id,
            symbol=symbol,
            side=order.side,
            qty=order.qty,
            price=fill_price,
            timestamp=order.filled_at,
        )
        self._trades.append(trade)
        return trade

    # ------------------------------------------------------------------
    # Position helpers (long / short)
    # ------------------------------------------------------------------

    def _open_long(self, symbol: str, qty: float, price: float) -> None:
        pos = self._positions.get(symbol)
        if pos is not None and pos.qty > 0:
            total = pos.qty + qty
            pos.avg_entry_price = (pos.avg_entry_price * pos.qty + price * qty) / total
            pos.qty = total
            pos.current_price = price
        else:
            self._positions[symbol] = Position(
                symbol=symbol, qty=qty, avg_entry_price=price, current_price=price
            )

    def _open_short(self, symbol: str, qty: float, price: float) -> None:
        pos = self._positions.get(symbol)
        if pos is not None and pos.qty < 0:
            total_qty = pos.qty - qty  # more negative
            pos.avg_entry_price = (pos.avg_entry_price * abs(pos.qty) + price * qty) / abs(total_qty)
            pos.qty = total_qty
            pos.current_price = price
        else:
            self._positions[symbol] = Position(
                symbol=symbol, qty=-qty, avg_entry_price=price, current_price=price
            )

    def _short_notional(self, prices: dict[str, float] | None = None) -> float:
        """Total dollar value of all open short positions."""
        total = 0.0
        for pos in self._positions.values():
            if pos.qty < 0:
                mark = prices.get(pos.symbol, pos.current_price) if prices else pos.current_price
                total += -pos.qty * mark
        return total

    def _equity(self, prices: dict[str, float] | None = None) -> float:
        """Net account equity: cash + long value - short notional."""
        return self._cash + sum(
            pos.market_value
            if prices is None
            else pos.qty * prices.get(pos.symbol, pos.current_price)
            for pos in self._positions.values()
        )

    def _short_reserved(self) -> float:
        """Cash frozen as margin collateral for open shorts."""
        return self._short_notional()

    def _check_short_capacity(self, symbol: str, sell_qty: float, pos, price: float) -> None:
        """Reject a SELL that opens/extends a short beyond realistic limits.

        Two bounds, both of which a real broker enforces:
          1. Leverage cap — total short notional may not exceed
             ``short_leverage * equity`` (defaults to 1x equity, so you can't
             short "a billion shares": your account size limits it).
          2. Cash reserve — the proceeds of a short sale must be backed by cash
             (shorts are collateralised like a real margin account).
        """
        net_after = (pos.qty if pos is not None else 0.0) - sell_qty
        if net_after >= 0:
            return  # selling out of (or into part of) a long position — no new short
        short_notional_after = -net_after * price

        mark_prices = None
        if pos is not None:
            mark_prices = {symbol: price, **{s: p.current_price for s, p in self._positions.items()}}
        equity = self._equity(mark_prices)
        cap = self._short_leverage * max(0.0, equity)
        if short_notional_after > cap + 1e-9:
            raise ValueError(
                f"Short too large: ${short_notional_after:,.2f} notional exceeds the "
                f"{self._short_leverage:.1f}x equity limit of ${cap:,.2f}"
            )

        cash_after = self._cash + sell_qty * price
        reserved_after = short_notional_after
        if cash_after < reserved_after - 1e-9:
            raise ValueError(
                f"Short not supported: need ${reserved_after - cash_after:,.2f} more cash collateral"
            )

    def cancel_order(self, order_id: str) -> bool:
        order = self._orders.get(order_id)
        if order and order.status == OrderStatus.PENDING:
            order.status = OrderStatus.CANCELLED
            return True
        return False

    # ------------------------------------------------------------------
    # State queries
    # ------------------------------------------------------------------

    def get_position(self, symbol: str) -> Position | None:
        return self._positions.get(symbol.upper())

    def get_positions(self) -> list[Position]:
        return list(self._positions.values())

    def get_pending_orders(self) -> list[Order]:
        return [o for o in self._orders.values() if o.status == OrderStatus.PENDING]

    def get_trades(self) -> list[Trade]:
        return list(self._trades)

    def update_prices(self, prices: dict[str, float]) -> None:
        """Update current prices for all positions (for P&L calculation)."""
        for symbol, price in prices.items():
            pos = self._positions.get(symbol)
            if pos:
                pos.current_price = price

    def get_portfolio(self) -> Portfolio:
        total_value = self._cash
        unrealized_pnl = 0.0
        for pos in self._positions.values():
            total_value += pos.market_value
            unrealized_pnl += pos.unrealized_pnl

        return Portfolio(
            cash=self._cash,
            positions=self._positions,
            total_value=total_value,
            unrealized_pnl=unrealized_pnl,
            realized_pnl=self._realized_pnl,
            trades=self._trades,
            buying_power=self.buying_power(),
            short_buying_power=self.short_capacity(),
        )

    # ------------------------------------------------------------------
    # Account health (used by the UI and order validation)
    # ------------------------------------------------------------------

    def buying_power(self) -> float:
        """Cash available for new buys (short proceeds are held as collateral)."""
        return self._cash - self._short_reserved()

    def short_capacity(self) -> float:
        """Max *additional* short dollar-notional this account can open right now."""
        cap = self._short_leverage * max(0.0, self._equity())
        return max(0.0, cap - self._short_notional())

    # ------------------------------------------------------------------
    # Persistence (per-portfolio)
    # ------------------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "cash": self._cash,
            "initial_cash": self._initial_cash,
            "realized_pnl": self._realized_pnl,
            "slippage": self._slippage,
            "min_order_qty": self._min_order_qty,
            "max_order_qty": self._max_order_qty,
            "short_leverage": self._short_leverage,
            "positions": [
                {
                    "symbol": p.symbol,
                    "qty": p.qty,
                    "avg_entry_price": p.avg_entry_price,
                    "current_price": p.current_price,
                }
                for p in self._positions.values()
            ],
            "orders": [
                {
                    "id": o.id,
                    "symbol": o.symbol,
                    "side": o.side.value,
                    "order_type": o.order_type.value,
                    "qty": o.qty,
                    "limit_price": o.limit_price,
                    "stop_price": o.stop_price,
                    "status": o.status.value,
                    "created_at": o.created_at.isoformat() if o.created_at else None,
                    "filled_at": o.filled_at.isoformat() if o.filled_at else None,
                    "fill_price": o.fill_price,
                }
                for o in self._orders.values()
            ],
            "trades": [
                {
                    "order_id": t.order_id,
                    "symbol": t.symbol,
                    "side": t.side.value,
                    "qty": t.qty,
                    "price": t.price,
                    "timestamp": t.timestamp.isoformat(),
                }
                for t in self._trades
            ],
        }

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), indent=2))

    def load(self, path: str | Path) -> None:
        """Replace in-memory account state from a persisted JSON file."""
        path = Path(path)
        if not path.exists():
            self.reset()
            return
        data = json.loads(path.read_text())
        self._cash = float(data.get("cash", data.get("initial_cash", self._initial_cash)))
        self._initial_cash = float(data.get("initial_cash", self._cash))
        self._realized_pnl = float(data.get("realized_pnl", 0.0))
        self._slippage = float(data.get("slippage", 0.0))
        self._min_order_qty = int(data.get("min_order_qty", 1))
        self._max_order_qty = int(data.get("max_order_qty", 1_000_000))
        self._short_leverage = max(0.0, min(10.0, float(data.get("short_leverage", 1.0))))
        self._positions = {}
        for p in data.get("positions", []):
            self._positions[p["symbol"]] = Position(
                symbol=p["symbol"],
                qty=float(p["qty"]),
                avg_entry_price=float(p["avg_entry_price"]),
                current_price=float(p.get("current_price", p["avg_entry_price"])),
            )
        self._orders = {}
        for o in data.get("orders", []):
            self._orders[o["id"]] = Order(
                id=o["id"],
                symbol=o["symbol"],
                side=Side(o["side"]),
                order_type=OrderType(o["order_type"]),
                qty=float(o["qty"]),
                limit_price=o.get("limit_price"),
                stop_price=o.get("stop_price"),
                status=OrderStatus(o["status"]),
                created_at=datetime.fromisoformat(o["created_at"]) if o.get("created_at") else None,
                filled_at=datetime.fromisoformat(o["filled_at"]) if o.get("filled_at") else None,
                fill_price=o.get("fill_price"),
            )
        self._trades = []
        for t in data.get("trades", []):
            self._trades.append(
                Trade(
                    order_id=t["order_id"],
                    symbol=t["symbol"],
                    side=Side(t["side"]),
                    qty=float(t["qty"]),
                    price=float(t["price"]),
                    timestamp=datetime.fromisoformat(t["timestamp"]),
                )
            )

    def clear_orders(self) -> None:
        """Drop all order records (used when switching context is not desired)."""
        self._orders = {}
