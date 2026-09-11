"""Paper broker/trading tests"""

import pytest

from backend.trading.models import OrderStatus
from backend.trading.paper import PaperBroker


def test_buy_stock():
    broker = PaperBroker(initial_cash=10_000)
    order = broker.place_order("AAPL", "buy", 10, "market")
    broker.fill_order(order, 150.0)

    assert order.status == OrderStatus.FILLED
    assert broker._cash == pytest.approx(10_000 - 10 * 150.0)
    pos = broker.get_position("AAPL")
    assert pos is not None
    assert pos.qty == 10
    assert pos.avg_entry_price == 150.0


def test_sell_stock():
    broker = PaperBroker(initial_cash=10_000)
    buy_order = broker.place_order("AAPL", "buy", 10, "market")
    broker.fill_order(buy_order, 150.0)

    sell_order = broker.place_order("AAPL", "sell", 10, "market")
    broker.fill_order(sell_order, 160.0)

    assert sell_order.status == OrderStatus.FILLED
    assert broker._cash == pytest.approx(10_000 - 10 * 150.0 + 10 * 160.0)
    assert broker.get_position("AAPL") is None
    assert len(broker.get_trades()) == 2


def test_insufficient_cash():
    broker = PaperBroker(initial_cash=1000)
    order = broker.place_order("AAPL", "buy", 100, "market")
    with pytest.raises(ValueError, match="Insufficient cash"):
        broker.fill_order(order, 150.0)
    assert order.status == OrderStatus.REJECTED


def test_insufficient_position():
    broker = PaperBroker(initial_cash=10_000)
    order = broker.place_order("AAPL", "sell", 10, "market")
    with pytest.raises(ValueError, match="Insufficient position"):
        broker.fill_order(order, 150.0)
    assert order.status == OrderStatus.REJECTED


def test_cancel_order():
    broker = PaperBroker()
    order = broker.place_order("AAPL", "buy", 10, "market")
    assert broker.cancel_order(order.id)
    assert order.status == OrderStatus.CANCELLED
    broker.fill_order(order, 150.0) # shouldnt work to cancel this VV
    assert not broker.cancel_order(order.id)


def test_portfolio_value():
    broker = PaperBroker(initial_cash=10_000)
    buy = broker.place_order("AAPL", "buy", 10, "market")
    broker.fill_order(buy, 100.0)

    broker.update_prices({"AAPL": 110.0})
    portfolio = broker.get_portfolio()

    assert portfolio.cash == pytest.approx(9_000)
    assert portfolio.invested == pytest.approx(1_100)
    assert portfolio.total_value == pytest.approx(10_100)
    assert portfolio.unrealized_pnl == pytest.approx(100)


def test_multiple_positions():
    broker = PaperBroker(initial_cash=50_000)
    order1 = broker.place_order("AAPL", "buy", 5, "market")
    broker.fill_order(order1, 150.0)
    order2 = broker.place_order("MSFT", "buy", 10, "market")
    broker.fill_order(order2, 300.0)

    assert len(broker.get_positions()) == 2
    assert broker.get_position("AAPL").qty == 5
    assert broker.get_position("MSFT").qty == 10
    assert broker._cash == pytest.approx(50_000 - 5 * 150 - 10 * 300)


def test_realized_pnl():
    broker = PaperBroker(initial_cash=10_000)
    buy = broker.place_order("AAPL", "buy", 10, "market")
    broker.fill_order(buy, 100.0)
    sell = broker.place_order("AAPL", "sell", 10, "market")
    broker.fill_order(sell, 110.0)

    assert broker.get_portfolio().realized_pnl == pytest.approx(100.0)
    assert broker._cash == pytest.approx(10_000 + 100)


def test_min_order_qty_rejected():
    broker = PaperBroker(initial_cash=10_000, min_order_qty=5)
    with pytest.raises(ValueError, match="minimum quantity"):
        broker.place_order("AAPL", "buy", 2, "market")
    order = broker.place_order("AAPL", "buy", 5, "market")
    assert order is not None


def test_min_order_qty_updatable():
    broker = PaperBroker(initial_cash=10_000)
    broker.apply_settings(min_order_qty=10)
    with pytest.raises(ValueError, match="minimum quantity"):
        broker.place_order("AAPL", "buy", 5, "market")


def test_max_order_qty_rejected():
    broker = PaperBroker(initial_cash=10_000, max_order_qty=100)
    with pytest.raises(ValueError, match="maximum quantity"):
        broker.place_order("AAPL", "buy", 500, "market")
    order = broker.place_order("AAPL", "buy", 100, "market")
    assert order is not None


def test_slippage_applied_to_buy():
    broker = PaperBroker(initial_cash=10_000, slippage=0.05)
    order = broker.place_order("AAPL", "buy", 10, "market")
    broker.fill_order(order, 100.0)
    assert broker._cash == pytest.approx(10_000 - 10 * 100 * 1.05)


def test_slippage_applied_to_sell():
    broker = PaperBroker(initial_cash=10_000, slippage=0.05)
    buy = broker.place_order("AAPL", "buy", 10, "market")
    broker.fill_order(buy, 100.0)
    sell = broker.place_order("AAPL", "sell", 10, "market")
    broker.fill_order(sell, 200.0)
    assert broker._cash == pytest.approx(10_000 - 1050 + 10 * 200 * 0.95)


def test_reset_account():
    broker = PaperBroker(initial_cash=10_000)
    order = broker.place_order("AAPL", "buy", 10, "market")
    broker.fill_order(order, 100.0)
    assert len(broker.get_positions()) == 1
    broker.reset(initial_cash=20_000)
    assert broker.get_positions() == []
    assert broker.get_portfolio().cash == pytest.approx(20_000)
