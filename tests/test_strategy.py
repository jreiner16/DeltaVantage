"""Tests for strategies"""

from datetime import UTC, datetime

from delta_vantage.data.cache import BarCache
from delta_vantage.strategy.base import Bar, Strategy
from delta_vantage.strategy.context import StrategyContext
from delta_vantage.trading.paper import PaperBroker


class CountingStrategy(Strategy):
    def start(self):
        self.bar_count = 0
        self.last_bar = None
        self.filled_orders = []

    def on_bar(self, bar: Bar):
        self.bar_count += 1
        self.last_bar = bar
        if self.bar_count == 5:
            self.ctx.place_order(bar.symbol, "buy", 1, "market")

    def on_order_filled(self, order):
        self.filled_orders.append(order)


def test_strategy_lifecycle():
    strategy = CountingStrategy()
    assert strategy.ctx is None

    broker = PaperBroker()
    cache = BarCache()
    strategy.ctx = StrategyContext(broker, cache, ["AAPL"])

    strategy.start()
    assert strategy.bar_count == 0

    for i in range(10):
        strategy.on_bar(
            Bar(
                symbol="AAPL",
                timestamp=datetime.now(UTC),
                open=100.0,
                high=101.0,
                low=99.0,
                close=100.5,
                volume=1000,
            )
        )

    assert strategy.bar_count == 10
    assert strategy.last_bar.symbol == "AAPL"


def test_strategy_context_get_data(tmp_path):
    broker = PaperBroker()
    cache = BarCache(tmp_path / "test.db")
    ctx = StrategyContext(broker, cache, ["AAPL"])
    df = ctx.get_data("AAPL", lookback=100)
    assert df.empty
    assert list(df.columns) == ["Open", "High", "Low", "Close", "Volume"]
