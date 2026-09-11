"""Charting — renders OHLCV + indicators using lightweight-charts."""

from __future__ import annotations

import pandas as pd


def _resolve_time(ts):
    """Normalize a timestamp/index to a string, handling both datetime and period."""
    if hasattr(ts, "strftime"):
        return ts.strftime("%Y-%m-%d")
    return str(ts)


def render_chart(
    df: pd.DataFrame,
    title: str = "OHLCV",
    indicators: dict[str, pd.Series | pd.DataFrame] | None = None,
    trades: list[dict] | None = None,
    block: bool = False,
) -> None:
    """Open an interactive chart window (lightweight-charts engine).

    Parameters
    ----------
    df : DataFrame with columns Open, High, Low, Close, Volume (DatetimeIndex)
    title : chart title
    indicators : dict of name -> Series/DataFrame to overlay
    trades : list of dicts with keys: type ("buy"/"sell"), price, timestamp
    block : whether to block until the window closes
    """
    from lightweight_charts import Chart

    # Build the base time column once from the DataFrame index
    times = [_resolve_time(ts) for ts in df.index]

    chart = Chart(title=title, width=1200, height=700)
    chart.legend()

    # Candlestick data
    candle_data = pd.DataFrame({
        "time": times,
        "Open": df["Open"].values,
        "High": df["High"].values,
        "Low": df["Low"].values,
        "Close": df["Close"].values,
    })
    chart.set(candle_data)

    # Volume histogram in a subchart below the main chart
    vol_chart = chart.create_subchart(position="bottom", height=150)
    vol_series = vol_chart.create_histogram(
        name="Volume", color="rgba(0,150,136,0.3)", price_line=False, price_label=False
    )
    vol_series.set(pd.DataFrame({
        "time": times,
        "Volume": df["Volume"].values,
    }))

    # Indicators
    if indicators:
        color_idx = 0
        for name, data in indicators.items():
            if isinstance(data, pd.Series):
                ind_series = chart.create_line(name=name, color=_pick_color(color_idx))
                color_idx += 1
                ind_series.set(pd.DataFrame({"time": times, name: data.values}))
            elif isinstance(data, pd.DataFrame):
                for col in data.columns:
                    ind_series = chart.create_line(name=col, color=_pick_color(color_idx))
                    color_idx += 1
                    ind_series.set(pd.DataFrame({"time": times, col: data[col].values}))

    # Trade markers
    if trades:
        for t in trades:
            chart.marker(
                time=_resolve_time(t["timestamp"]),
                position="below" if t["type"] == "buy" else "above",
                shape="arrow_up" if t["type"] == "buy" else "arrow_down",
                color="#26a69a" if t["type"] == "buy" else "#ef5350",
                text=f"{t['type'].upper()} @ {t['price']:.2f}",
            )

    chart.show(block=block)


_PALETTE = [
    "#2196F3",  # blue
    "#FF9800",  # orange
    "#9C27B0",  # purple
    "#4CAF50",  # green
    "#E91E63",  # pink
    "#00BCD4",  # cyan
    "#FFC107",  # amber
]


def _pick_color(index: int) -> str:
    return _PALETTE[index % len(_PALETTE)]
