"""Technical indicator library — pure functions that append columns to DataFrames."""

from __future__ import annotations

import pandas as pd


def sma(df: pd.DataFrame, period: int = 20, column: str = "Close") -> pd.Series:
    """Simple Moving Average."""
    return df[column].rolling(window=period, min_periods=period).mean()


def ema(df: pd.DataFrame, period: int = 20, column: str = "Close") -> pd.Series:
    """Exponential Moving Average."""
    return df[column].ewm(span=period, adjust=False).mean()


def bollinger_bands(
    df: pd.DataFrame, period: int = 20, std_dev: float = 2.0, column: str = "Close"
) -> pd.DataFrame:
    """Bollinger Bands — returns DataFrame with columns: BB_Mid, BB_Upper, BB_Lower."""
    mid = sma(df, period, column)
    rolling_std = df[column].rolling(window=period, min_periods=period).std()
    return pd.DataFrame(
        {
            "BB_Mid": mid,
            "BB_Upper": mid + std_dev * rolling_std,
            "BB_Lower": mid - std_dev * rolling_std,
        }
    )


def rsi(df: pd.DataFrame, period: int = 14, column: str = "Close") -> pd.Series:
    """Relative Strength Index (Wilder's smoothing)."""
    delta = df[column].diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)

    avg_gain = gain.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()

    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def macd(
    df: pd.DataFrame,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
    column: str = "Close",
) -> pd.DataFrame:
    """MACD — returns DataFrame with columns: MACD, MACD_Signal, MACD_Hist."""
    fast_ema = ema(df, fast, column)
    slow_ema = ema(df, slow, column)
    macd_line = fast_ema - slow_ema
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return pd.DataFrame(
        {
            "MACD": macd_line,
            "MACD_Signal": signal_line,
            "MACD_Hist": histogram,
        }
    )


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average True Range."""
    high = df["High"]
    low = df["Low"]
    prev_close = df["Close"].shift(1)
    tr = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()


def vwap(df: pd.DataFrame) -> pd.Series:
    """Volume Weighted Average Price (intraday, resets per session)."""
    typical_price = (df["High"] + df["Low"] + df["Close"]) / 3.0
    cum_tp_vol = (typical_price * df["Volume"]).cumsum()
    cum_vol = df["Volume"].cumsum()
    return cum_tp_vol / cum_vol


def stochastic(df: pd.DataFrame, k_period: int = 14, d_period: int = 3) -> pd.DataFrame:
    """Stochastic Oscillator — returns DataFrame with columns: Stoch_K, Stoch_D."""
    low_min = df["Low"].rolling(window=k_period, min_periods=k_period).min()
    high_max = df["High"].rolling(window=k_period, min_periods=k_period).max()
    k = 100.0 * (df["Close"] - low_min) / (high_max - low_min)
    d = k.rolling(window=d_period, min_periods=d_period).mean()
    return pd.DataFrame({"Stoch_K": k, "Stoch_D": d})


# Registry for dynamic lookup by name
INDICATORS = {
    "sma": sma,
    "ema": ema,
    "bollinger": bollinger_bands,
    "rsi": rsi,
    "macd": macd,
    "atr": atr,
    "vwap": vwap,
    "stochastic": stochastic,
}
