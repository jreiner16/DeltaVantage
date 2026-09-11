"""SQLite bar cache testing"""

from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd

from backend.data.cache import BarCache


def _sample_df(n: int = 50) -> pd.DataFrame:
    np.random.seed(7)
    close = 100 + np.cumsum(np.random.randn(n))
    start = datetime.now(UTC) - timedelta(days=1)
    index = pd.date_range(start=start, periods=n, freq="15min", tz="UTC")
    return pd.DataFrame(
        {
            "Open": close - 0.2,
            "High": close + 0.5,
            "Low": close - 0.5,
            "Close": close,
            "Volume": np.random.randint(1000, 9000, n).astype(float),
        },
        index=index,
    )


def test_upsert_and_get(tmp_path):
    cache = BarCache(tmp_path / "test.db")
    df = _sample_df()
    count = cache.upsert_bars("AAPL", "15Min", df)
    assert count == len(df)

    out = cache.get_bars("AAPL", "15Min", df.index[0].to_pydatetime())
    assert out is not None
    assert len(out) == len(df)
    assert list(out.columns) == ["Open", "High", "Low", "Close", "Volume"]
    assert out.index.tz is not None
    pd.testing.assert_series_equal(
        out["Close"],
        df["Close"],
        check_names=False,
        check_freq=False,
        check_index_type=False,
    )


def test_upsert_dedupes(tmp_path):
    cache = BarCache(tmp_path / "test.db")
    df = _sample_df()
    cache.upsert_bars("AAPL", "15Min", df)
    cache.upsert_bars("AAPL", "15Min", df)
    out = cache.get_bars("AAPL", "15Min", df.index[0].to_pydatetime())
    assert len(out) == len(df)


def test_get_missing_returns_none(tmp_path):
    cache = BarCache(tmp_path / "test.db")
    out = cache.get_bars("NOPE", "15Min", datetime.now(UTC))
    assert out is None


def test_latest_timestamp(tmp_path):
    cache = BarCache(tmp_path / "test.db")
    df = _sample_df()
    cache.upsert_bars("AAPL", "15Min", df)
    latest = cache.get_latest_timestamp("AAPL", "15Min")
    assert latest is not None
    assert latest == df.index[-1].to_pydatetime()
