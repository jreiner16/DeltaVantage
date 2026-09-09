"""Strategy engine: dynamic loading, pending-order checks, and the backtest loop."""

from __future__ import annotations

import importlib.util
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from delta_vantage.strategy.base import Bar, Strategy
from delta_vantage.strategy.context import StrategyContext
from delta_vantage.trading.models import Portfolio
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


@dataclass
class SimResult:
    equity: list[float]
    bars_held: int
    bars_processed: int
    order_count: int
    trade_count: int
    runtime_ms: float
    logs: list[str]
    broker: PaperBroker


def _simulate(
    cls: type[Strategy],
    df: pd.DataFrame,
    symbol: str,
    interval: str,
    params: dict | None = None,
    cache=None,
    quiet: bool = False,
) -> SimResult:
    """Run a strategy over a bar frame and return the raw sim internals.

    quiet=True skips the stdout [LOG] chatter (and the log buffer entirely) —
    used by Monte Carlo, where hundreds of sims would spam the console.
    """
    bkr = PaperBroker()
    strategy = cls()
    if params:
        strategy.params = params

    ctx = StrategyContext(bkr, cache, symbols=[], backtest_df=df)
    ctx._quiet = quiet
    strategy.ctx = ctx

    bars_list = [
        Bar(
            symbol=symbol,
            timestamp=ts.to_pydatetime(),
            open=float(r["Open"]),
            high=float(r["High"]),
            low=float(r["Low"]),
            close=float(r["Close"]),
            volume=float(r["Volume"]),
        )
        for ts, r in df.iterrows()
    ]

    strategy.start()
    equity: list[float] = []
    bars_held = 0
    _t0 = time.monotonic()
    for bar in bars_list:
        ctx.set_backtest_asof(bar.timestamp)
        strategy.on_bar(bar)
        for order in bkr.get_pending_orders():
            if order.symbol == bar.symbol:
                _check_pending_order(bkr, order, bar)
        # Mark positions to market using the current close to build equity.
        held = [p.symbol for p in bkr.get_positions()]
        if held:
            bars_held += 1
            bkr.update_prices({s: bar.close for s in held})
        equity.append(round(bkr.get_portfolio().total_value, 2))
    runtime_ms = round((time.monotonic() - _t0) * 1000, 2)
    strategy.stop()

    logs = list(ctx._log_buffer) if not quiet else []
    return SimResult(
        equity=equity,
        bars_held=bars_held,
        bars_processed=len(bars_list),
        order_count=len(bkr._orders),
        trade_count=len(bkr.get_trades()),
        runtime_ms=runtime_ms,
        logs=logs,
        broker=bkr,
    )


def run_backtest(
    cls: type[Strategy],
    df: pd.DataFrame,
    symbol: str,
    interval: str,
    params: dict | None = None,
    cache=None,
) -> tuple[dict, PaperBroker]:
    """Full backtest for one strategy run — returns the API result dict plus
    the broker so the caller can serialise the account snapshot itself."""
    res = _simulate(cls, df, symbol, interval, params, cache)

    equity = [
        {"t": ts.isoformat(), "v": v, "c": round(float(r["Close"]), 2)}
        for (ts, r), v in zip(df.iterrows(), res.equity)
    ]
    equity_values = res.equity

    metrics: dict = {}
    if len(equity_values) >= 2:
        start_val = equity_values[0]
        end_val = equity_values[-1]
        total_return_pct = round((end_val / start_val - 1) * 100, 4) if start_val else 0.0

        daily_returns: list[float] = []
        for i in range(1, len(equity_values)):
            prev = equity_values[i - 1]
            daily_returns.append(equity_values[i] / prev - 1 if prev else 0.0)

        avg_ret = sum(daily_returns) / len(daily_returns) if daily_returns else 0.0
        var_ret = (
            sum((r - avg_ret) ** 2 for r in daily_returns) / (len(daily_returns) - 1)
            if len(daily_returns) > 1
            else 0.0
        )
        std_ret = math.sqrt(var_ret)
        sharpe_ratio = round((avg_ret / std_ret) * math.sqrt(252), 4) if std_ret > 0 else 0.0

        downside = [min(r, 0.0) for r in daily_returns]
        downside_var = (
            sum(d * d for d in downside) / (len(downside) - 1)
            if len(downside) > 1
            else 0.0
        )
        downside_std = math.sqrt(downside_var)
        sortino_ratio = (
            round((avg_ret / downside_std) * math.sqrt(252), 4) if downside_std > 0 else 0.0
        )

        peak = equity_values[0]
        max_dd = 0.0
        max_dd_duration = 0
        current_dd_duration = 0
        for val in equity_values:
            if val > peak:
                peak = val
                current_dd_duration = 0
            else:
                current_dd_duration += 1
                dd = (peak - val) / peak if peak else 0.0
                if dd > max_dd:
                    max_dd = dd
                    max_dd_duration = current_dd_duration
        max_drawdown_pct = round(max_dd * 100, 4)

        n_bars = len(equity_values)
        annualized_return_pct = 0.0
        if n_bars > 1 and start_val > 0:
            iv = interval.lower()
            if "min" in iv:
                minutes = (
                    int("".join(filter(str.isdigit, iv)))
                    if any(c.isdigit() for c in iv)
                    else 15
                )
                bars_per_year = 252 * 6.5 * 60 / minutes
            elif iv in ("1hour", "1h"):
                bars_per_year = 252 * 6.5
            else:
                bars_per_year = 252
            years = n_bars / bars_per_year
            if years > 0 and end_val > 0:
                annualized_return_pct = round(((end_val / start_val) ** (1 / years) - 1) * 100, 4)
    else:
        total_return_pct = 0.0
        sharpe_ratio = 0.0
        sortino_ratio = 0.0
        max_drawdown_pct = 0.0
        max_dd_duration = 0
        annualized_return_pct = 0.0

    # Pair sells against avg entries to bucket wins/losses.
    buys: dict[str, list[float]] = {}
    wins: list[float] = []
    losses: list[float] = []
    for t in res.broker.get_trades():
        sym = t.symbol
        if t.side.value == "buy":
            buys.setdefault(sym, []).append(t.price)
        elif t.side.value == "sell":
            entries = buys.get(sym, [])
            if entries:
                avg_entry = sum(entries) / len(entries)
                pnl = (t.price - avg_entry) * t.qty
                if pnl > 0:
                    wins.append(pnl)
                else:
                    losses.append(abs(pnl))
                shares_remaining = t.qty
                while shares_remaining > 0 and entries:
                    shares_remaining -= 1
                    if shares_remaining <= 0:
                        break

    total_trades = len(wins) + len(losses)
    win_rate = round(len(wins) / total_trades, 4) if total_trades else 0.0
    avg_win = round(sum(wins) / len(wins), 4) if wins else 0.0
    avg_loss = round(sum(losses) / len(losses), 4) if losses else 0.0
    gross_profit = sum(wins)
    gross_loss = sum(losses)
    if total_trades == 0:
        profit_factor = None
    elif gross_loss > 0:
        profit_factor = round(gross_profit / gross_loss, 4)
    elif gross_profit > 0:
        profit_factor = None
    else:
        profit_factor = 0.0
    avg_trade = round((gross_profit - gross_loss) / total_trades, 4) if total_trades else 0.0
    best_trade = round(max(wins), 4) if wins else 0.0
    worst_trade = round(-max(losses), 4) if losses else 0.0

    net_profit = round(equity_values[-1] - equity_values[0], 4) if equity_values else 0.0
    starting_value = round(equity_values[0], 2) if equity_values else 0.0
    ending_value = round(equity_values[-1], 2) if equity_values else 0.0
    exposure_pct = round(res.bars_held / res.bars_processed * 100, 4) if res.bars_processed else 0.0

    metrics = {
        "total_return_pct": total_return_pct,
        "annualized_return_pct": annualized_return_pct,
        "sharpe_ratio": sharpe_ratio,
        "sortino_ratio": sortino_ratio,
        "max_drawdown_pct": max_drawdown_pct,
        "max_drawdown_duration": max_dd_duration,
        "win_rate": win_rate,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "avg_trade": avg_trade,
        "best_trade": best_trade,
        "worst_trade": worst_trade,
        "profit_factor": profit_factor,
        "exposure_pct": exposure_pct,
        "net_profit": net_profit,
        "starting_value": starting_value,
        "ending_value": ending_value,
    }

    result = {
        "symbol": symbol,
        "interval": interval,
        "order_count": res.order_count,
        "trade_count": res.trade_count,
        "start": df.index[0].isoformat(),
        "end": df.index[-1].isoformat(),
        "equity": equity,
        "metrics": metrics,
        "runtime_ms": res.runtime_ms,
        "bars_processed": res.bars_processed,
        "logs": res.logs,
    }
    return result, res.broker