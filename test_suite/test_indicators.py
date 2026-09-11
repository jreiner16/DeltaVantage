"""Test technical indicators"""

import numpy as np
import pandas as pd

from backend.indicators.technical import (
    atr,
    bollinger_bands,
    ema,
    macd,
    rsi,
    sma,
    stochastic,
    vwap,
)


def _make_ohlc(n: int = 100, start_price: float = 100.0) -> pd.DataFrame:
    np.random.seed(42)
    close = start_price + np.cumsum(np.random.randn(n) * 0.5)
    return pd.DataFrame(
        {
            "Open": close + np.random.randn(n) * 0.2,
            "High": close + np.abs(np.random.randn(n) * 0.5),
            "Low": close - np.abs(np.random.randn(n) * 0.5),
            "Close": close,
            "Volume": np.random.randint(1000, 10000, n).astype(float),
        }
    )


def test_sma():
    df = _make_ohlc()
    result = sma(df, period=20)
    assert isinstance(result, pd.Series)
    assert len(result) == len(df)
    assert result.isna().sum() == 19  # first 19 should atually be NaN
    assert not result.iloc[-1:].isna().any()


def test_ema():
    df = _make_ohlc()
    result = ema(df, period=20)
    assert isinstance(result, pd.Series)
    assert len(result) == len(df)
    assert not result.iloc[19:].isna().any()


def test_bollinger():
    df = _make_ohlc()
    result = bollinger_bands(df, period=20)
    assert list(result.columns) == ["BB_Mid", "BB_Upper", "BB_Lower"]
    assert len(result) == len(df)
    valid = result.dropna()
    assert (valid["BB_Upper"] >= valid["BB_Mid"]).all()
    assert (valid["BB_Mid"] >= valid["BB_Lower"]).all()


def test_rsi():
    df = _make_ohlc()
    result = rsi(df, period=14)
    assert isinstance(result, pd.Series)
    valid = result.dropna()
    assert (valid >= 0).all()
    assert (valid <= 100).all()


def test_macd():
    df = _make_ohlc()
    result = macd(df)
    assert list(result.columns) == ["MACD", "MACD_Signal", "MACD_Hist"]
    assert len(result) == len(df)


def test_atr():
    df = _make_ohlc()
    result = atr(df, period=14)
    assert isinstance(result, pd.Series)
    valid = result.dropna()
    assert (valid > 0).all()


def test_vwap():
    df = _make_ohlc()
    result = vwap(df)
    assert isinstance(result, pd.Series)
    assert len(result) == len(df)
    assert not result.iloc[1:].isna().any()


def test_stochastic():
    df = _make_ohlc()
    result = stochastic(df)
    assert list(result.columns) == ["Stoch_K", "Stoch_D"]
    valid = result.dropna()
    assert (valid["Stoch_K"] >= 0).all() and (valid["Stoch_K"] <= 100).all()
    assert (valid["Stoch_D"] >= 0).all() and (valid["Stoch_D"] <= 100).all()
