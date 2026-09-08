"""Strategy engine — dynamic loading and pending-order checks for the FastAPI backend."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from delta_vantage.strategy.base import Bar, Strategy
from delta_vantage.trading.paper import PaperBroker


def load_strategy(path: Path) -> type[Strategy]:
    """Dynamically load a Strategy subclass from a Python file."""
    module_name = path.stem
    spec = importlib.util.spec_from_file_location(module_name, str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)

    for attr_name in dir(module):
        attr = getattr(module, attr_name)
        if isinstance(attr, type) and issubclass(attr, Strategy) and attr is not Strategy:
            return attr
    raise TypeError(f"No Strategy subclass found in {path}")


def _check_pending_order(broker: PaperBroker, order, bar: Bar) -> None:
    """Check if a pending order should fill against a bar."""
    # Market orders fill immediately at the current bar's close
    if order.order_type.value == "market":
        try:
            broker.fill_order(order, bar.close)
        except ValueError:
            pass  # insufficient cash/position — leave rejected
    elif order.order_type.value == "limit" and order.limit_price is not None:
        buy_hit = order.side.value == "buy" and bar.low <= order.limit_price
        sell_hit = order.side.value == "sell" and bar.high >= order.limit_price
        if buy_hit or sell_hit:
            broker.fill_order(order, order.limit_price)
    elif order.order_type.value == "stop" and order.stop_price is not None:
        buy_hit = order.side.value == "buy" and bar.high >= order.stop_price
        sell_hit = order.side.value == "sell" and bar.low <= order.stop_price
        if buy_hit or sell_hit:
            broker.fill_order(order, order.stop_price)
