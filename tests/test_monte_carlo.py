"""Monte Carlo sim tests"""

from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd

from delta_vantage.strategy.base import Bar, Strategy
from delta_vantage.strategy.engine import _simulate, run_backtest
from delta_vantage.strategy.monte_carlo import (
    MC_FAN_BARS,
    run_monte_carlo,
    simulate_path,
    _factors,
)


def _random_df(n: int = 120, seed: int = 3) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 0.8, n))
    close = np.maximum(close, 20)
    df = pd.DataFrame(
        {
            "Open": close - 0.3,
            "High": close + 0.8,
            "Low": close - 0.8,
            "Close": close,
            "Volume": rng.integers(1000, 9000, n).astype(float),
        }
    )
    start = datetime.now(UTC) - timedelta(days=n)
    df.index = pd.date_range(start=start, periods=n, freq="h", tz="UTC")
    return df


class FlatBuy(Strategy):
    def start(self):
        self.bought = False

    def on_bar(self, bar: Bar):
        if len(self.ctx.get_data(bar.symbol, lookback=10)) >= 10 and not self.bought:
            self.ctx.place_order(bar.symbol, "buy", 10, "market")
            self.bought = True


def _real_equity(df: pd.DataFrame):
    res = _simulate(FlatBuy, df, "TEST", "1Hour")
    return np.asarray(res.equity, dtype=float)


def test_simulate_path_preserves_structure():
    df = _random_df()
    F, volume = _factors(df)
    rng = np.random.default_rng(42)
    synth = simulate_path(df, rng, 12, F, volume)

    assert len(synth) == len(df)
    assert (synth.index == df.index).all()
    assert (synth["Close"] > 0).all()
    assert (synth["Open"] > 0).all()
    assert (synth["Low"] <= np.minimum(synth["Open"], synth["Close"])).all()
    assert (synth["High"] >= np.maximum(synth["Open"], synth["Close"])).all()
    assert synth["Volume"].equals(df["Volume"]) is False


def test_same_seed_is_deterministic():
    df = _random_df()
    a = run_monte_carlo(FlatBuy, df, "TEST", "1Hour", 300, sims=40, seed=7)
    b = run_monte_carlo(FlatBuy, df, "TEST", "1Hour", 300, sims=40, seed=7)
    assert a["stats"] == b["stats"]
    assert a["percentiles"] == b["percentiles"]
    assert a["fan"]["p50"] == b["fan"]["p50"]
    assert a["actual"]["v"] == b["actual"]["v"]


def test_percentiles_are_monotonic():
    df = _random_df()
    out = run_monte_carlo(FlatBuy, df, "TEST", "1Hour", 300, sims=60, seed=1)
    p = out["percentiles"]
    keys = ["p5", "p10", "p25", "p50", "p75", "p90", "p95", "p99"]
    vals = [p[k] for k in keys]
    assert vals == sorted(vals)


def test_output_shape_and_sanity():
    df = _random_df()
    out = run_monte_carlo(FlatBuy, df, "TEST", "1Hour", 300, sims=50, seed=2)

    assert out["sims"] == 50
    assert out["bars"] == len(df)
    assert out["start"] == df.index[0].isoformat()
    assert out["end"] == df.index[-1].isoformat()
    assert len(out["fan"]["p50"]) <= MC_FAN_BARS
    assert len(out["fan"]["p10"]) == len(out["fan"]["p90"])
    assert out["stats"]["prob_profit"] + out["stats"]["prob_loss"] == 1.0
    assert 0 <= out["stats"]["prob_profit"] <= 1
    assert out["stats"]["start_value"] == out["actual"]["v"][0]
    assert out["stats"]["final_median"] >= out["stats"]["final_worst"]
    assert out["stats"]["final_best"] >= out["stats"]["final_median"]


def test_run_backtest_full_dict():
    df = _random_df()
    result, broker = run_backtest(FlatBuy, df, "TEST", "1Hour")
    for key in ("symbol", "interval", "order_count", "trade_count", "start", "end",
                "equity", "metrics", "runtime_ms", "bars_processed", "logs"):
        assert key in result
    assert result["bars_processed"] == len(df)
    assert len(result["equity"]) == len(df)
    assert broker.get_position("TEST") is not None
    assert result["equity"][0]["v"] == 100_000.0
    assert isinstance(result["metrics"]["total_return_pct"], float)


def test_too_few_bars_raises():
    df = _random_df(n=15)
    try:
        run_monte_carlo(FlatBuy, df, "TEST", "1Hour", 30, sims=10, seed=1)
    except ValueError as e:
        assert "20" in str(e)
        return
    raise AssertionError("expected ValueError for short history")