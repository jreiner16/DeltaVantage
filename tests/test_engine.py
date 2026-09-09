"""Strategy tests"""

from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd

from delta_vantage.data.cache import BarCache
from delta_vantage.strategy.base import Bar, Strategy
from delta_vantage.strategy.context import StrategyContext
from delta_vantage.strategy.engine import load_strategy
from delta_vantage.trading.paper import PaperBroker


class BuyAndHold(Strategy):
    """Simple strategy for testing, buy 10 shares after 5 bars. """

    def start(self):
        self.bar_count = 0
        self.order = None

    def on_bar(self, bar: Bar):
        self.bar_count += 1
        if self.bar_count == 5:
            self.order = self.ctx.place_order(bar.symbol, "buy", 10, "market")
            self.ctx.log(f"Buying 10x {bar.symbol} @ {bar.close:.2f}")


def _replay_engine(strategy_cls, cache: BarCache, bars: list[Bar]):
    broker = PaperBroker()
    ctx = StrategyContext(broker, cache, ["TEST"])
    strategy = strategy_cls()
    strategy.ctx = ctx
    strategy.start()

    for bar in bars:
        strategy.on_bar(bar)
        for order in broker.get_pending_orders():
            broker.fill_order(order, bar.close)

    strategy.stop()
    return broker, strategy


def test_buy_and_hold_engine(tmp_path):
    cache = BarCache(tmp_path / "test.db")
    n = 100
    np.random.seed(1)
    close = 100 + np.cumsum(np.random.randn(n) * 0.5)
    df = pd.DataFrame(
        {
            "Open": close - 0.2,
            "High": close + 0.5,
            "Low": close - 0.5,
            "Close": close,
            "Volume": np.random.randint(1000, 10000, n).astype(float),
        }
    )
    start = datetime.now(UTC) - timedelta(days=2)
    df.index = pd.date_range(start=start, periods=n, freq="15min", tz="UTC").tz_convert("UTC")
    cache.upsert_bars("TEST", "15Min", df)

    cached = cache.get_bars("TEST", "15Min", start)
    bars = [
        Bar(
            symbol="TEST",
            timestamp=ts.to_pydatetime(),
            open=float(r["Open"]),
            high=float(r["High"]),
            low=float(r["Low"]),
            close=float(r["Close"]),
            volume=float(r["Volume"]),
        )
        for ts, r in cached.iterrows()
    ]

    broker, strategy = _replay_engine(BuyAndHold, cache, bars)

    assert strategy.bar_count == n
    pos = broker.get_position("TEST")
    assert pos is not None
    assert pos.qty == 10
    assert broker._cash < 100_000
    assert len(broker.get_trades()) == 1


def test_load_example_strategy():
    from pathlib import Path

    cls = load_strategy(Path("strategies/sma_crossover.py"))
    assert cls.__name__ == "SMACrossover"
    assert issubclass(cls, Strategy)


def test_market_order_fill_in_engine():
    from delta_vantage.strategy.engine import _check_pending_order

    broker = PaperBroker()
    order = broker.place_order("TEST", "buy", 10, "market")
    bar = Bar("TEST", datetime.now(UTC), 100, 101, 99, 100.5, 1000)
    _check_pending_order(broker, order, bar)

    assert order.status.value == "filled"
    pos = broker.get_position("TEST")
    assert pos.qty == 10
    assert pos.avg_entry_price == 100.5
    assert len(broker.get_trades()) == 1


def test_get_data_window_respects_asof():
    broker = PaperBroker()
    ctx = StrategyContext(broker, None, ["TEST"], backtest_df=None)

    n = 100
    df = pd.DataFrame(
        {
            "Open": [1.0] * n,
            "High": [1.5] * n,
            "Low": [0.5] * n,
            "Close": [1.0] * n,
            "Volume": [1000.0] * n,
        }
    )
    start = datetime.now(UTC) - timedelta(days=2)
    df.index = pd.date_range(start=start, periods=n, freq="15min", tz="UTC")
    ctx._backtest_df = df

    asof = df.index[50]
    ctx.set_backtest_asof(asof)
    win = ctx.get_data("TEST", lookback=25)
    assert len(win) == 25
    assert win.index[-1] == asof
    assert win.index[0] < asof

    ctx.set_backtest_asof(df.index[5])
    win2 = ctx.get_data("TEST", lookback=25)
    assert len(win2) == 6  # only 6 bars lie at/before the pinned bar

    ctx.set_backtest_asof(None)
    assert len(ctx.get_data("TEST", lookback=25)) == 25
