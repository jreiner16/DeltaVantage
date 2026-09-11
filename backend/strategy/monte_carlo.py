"""Monte Carlo simulation — stationary block bootstrap on bar shapes.

Each synthetic path is built by resampling short blocks of the original bars
(open/close ratios chained multiplicatively so the price path is continuous),
then re-running the real strategy on it. Spreading sims across worker processes
keeps 200+ paths fast; a serial fallback covers tiny runs and spawn issues.
"""

from __future__ import annotations

import inspect
import multiprocessing as mp
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from time import monotonic

import numpy as np
import pandas as pd

from backend.strategy.base import Strategy
from backend.strategy.engine import _simulate, load_strategy

MC_FAN_BARS = 240  # points per band after downsampling
MC_MAX_BARS = 20_000  # above this, sims are throttled to keep responses snappy
MC_MIN_BARS = 20  # below this the bootstrap and strategy warmup get meaningless
_SERIAL_THRESHOLD = 30  # below this, process-spawn overhead isn't worth it
_MC_WORKERS = max(1, min(8, (os.cpu_count() or 4) - 1))


def _factors(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    o = df["Open"].to_numpy(dtype=float)
    h = df["High"].to_numpy(dtype=float)
    l = df["Low"].to_numpy(dtype=float)
    c = df["Close"].to_numpy(dtype=float)
    v = df["Volume"].to_numpy(dtype=float)

    n = len(df)
    prev = np.empty(n)
    prev[0] = c[0]
    prev[1:] = c[:-1]

    with np.errstate(divide="ignore", invalid="ignore"):
        gap = np.where(prev > 0, o / prev, 1.0)  # open vs prev close
        cc = np.where(o > 0, c / o, 1.0)          # close vs open
        hi = np.where(np.maximum(o, c) > 0, h / np.maximum(o, c), 1.0)  # >= 1
        lo = np.where(np.minimum(o, c) > 0, l / np.minimum(o, c), 1.0)  # <= 1

    hi = np.maximum(hi, 1.0)
    lo = np.minimum(lo, 1.0)

    valid = (
        np.isfinite(gap) & np.isfinite(cc) & (gap > 0) & (cc > 0)
        & np.isfinite(hi) & np.isfinite(lo)
    )
    if valid.sum() < n * 0.9:
        raise ValueError("Bars contain too many invalid OHLC rows for Monte Carlo")

    F = np.column_stack([gap, cc, hi, lo])
    volume = np.where(np.isfinite(v), v, 0.0)
    return F, volume


def _block_indices(n: int, rng: np.random.Generator, block: int) -> np.ndarray:
    p = 1.0 / max(block, 1)
    nblocks = int(n / max(block, 1)) + 3
    lengths = rng.geometric(p, size=nblocks)
    starts = rng.integers(0, n, size=nblocks)
    idx = np.empty(n, dtype=np.int64)
    filled = 0
    for length, start in zip(lengths, starts):
        take = min(int(length), n - filled)
        if take <= 0:
            break
        idx[filled : filled + take] = (start + np.arange(take)) % n
        filled += take
        if filled >= n:
            break
    if filled < n:
        idx[filled:] = rng.integers(0, n, size=n - filled)
    return idx


def simulate_path(
    df: pd.DataFrame,
    rng: np.random.Generator,
    block: int,
    F: np.ndarray,
    volume: np.ndarray,
) -> pd.DataFrame:
    """One synthetic OHLCV series, block-bootstrapped from the real bars."""
    n = len(df)
    idx = _block_indices(n, rng, block)
    gap, cc, hi, lo = F[idx, 0], F[idx, 1], F[idx, 2], F[idx, 3]

    # Multiplicative factors chain in closed form from the last real close.
    seed = float(df["Close"].iloc[-1])
    close = seed * np.cumprod(gap * cc)
    open_ = close / cc
    high = np.maximum(open_, close) * hi
    low = np.minimum(open_, close) * lo

    return pd.DataFrame(
        {
            "Open": open_,
            "High": high,
            "Low": low,
            "Close": close,
            "Volume": volume[idx],
        },
        index=df.index,
    )


def _max_dd_pct(values: np.ndarray) -> float:
    peak = np.maximum.accumulate(values)
    dd = (peak - values) / np.where(peak > 0, peak, 1.0)
    return float(dd.max() * 100.0)


def _mc_worker(args: tuple) -> list[tuple[np.ndarray, float]]:
    """Runs a chunk of sims in a worker process. Reloads the strategy from its
    file path so no class gets pickled."""
    path, symbol, interval, params, df, F, volume, block, seed, n = args
    cls = load_strategy(Path(path))
    rng = np.random.default_rng(seed)
    out: list[tuple[np.ndarray, float]] = []
    for _ in range(n):
        synth = simulate_path(df, rng, block, F, volume)
        eq = _simulate(cls, synth, symbol, interval, params, quiet=True).equity
        arr = np.asarray(eq, dtype=float)
        out.append((arr, _max_dd_pct(arr)))
    return out


def _strategy_path(cls: type[Strategy]) -> str | None:
    try:
        return str(Path(inspect.getfile(cls)).resolve())
    except Exception:
        return None


def run_monte_carlo(
    cls: type[Strategy],
    df: pd.DataFrame,
    symbol: str,
    interval: str,
    days: int,
    params: dict | None = None,
    sims: int = 200,
    seed: int | None = None,
    block: int | None = None,
    progress=None,
) -> dict:
    n = len(df)
    if n < MC_MIN_BARS:
        raise ValueError(f"Not enough bars for Monte Carlo (need at least {MC_MIN_BARS})")

    sims = int(min(500, max(10, sims)))
    # Very long histories explode the loop cost — drop sims proportionally.
    if n > MC_MAX_BARS:
        sims = max(25, int(sims * MC_MAX_BARS / n))
    if block is None:
        block = int(min(60, max(10, int(n ** 0.5))))

    F, volume = _factors(df)
    rng = np.random.default_rng(seed)

    real = _simulate(cls, df, symbol, interval, params, quiet=True)
    real_equity = np.asarray(real.equity, dtype=float)

    t0 = monotonic()
    paths: list[np.ndarray] = []
    drawdowns: list[float] = []
    failed = 0

    # Parallel when worthwhile — children fork from the live process (spawn is
    # a no-go: it re-executes the main module, which under `python -m uvicorn`
    # would try to rebind the port). Serial fallback if fork isn't available.
    strat_path = _strategy_path(cls)
    use_pool = strat_path is not None and sims >= _SERIAL_THRESHOLD
    if use_pool:
        workers = min(_MC_WORKERS, sims)
        if workers > 1:
            try:
                ctx = mp.get_context("fork")  # raises on platforms without fork
                seeds = [int(s) for s in rng.integers(0, 2**31 - 1, size=workers)]
                counts = [sims // workers] * workers
                for i in range(sims % workers):
                    counts[i] += 1
                tasks = [
                    (strat_path, symbol, interval, params, df, F, volume, block, seeds[i], counts[i])
                    for i in range(workers)
                ]
                with ProcessPoolExecutor(max_workers=workers, mp_context=ctx) as ex:
                    for fut in ex.map(_mc_worker, tasks):
                        for arr, dd in fut:
                            paths.append(arr)
                            drawdowns.append(dd)
                        if progress is not None:
                            progress(len(paths), sims)
            except Exception:
                paths, drawdowns = [], []

    if not paths:
        for _ in range(sims):
            try:
                synth = simulate_path(df, rng, block, F, volume)
                eq = _simulate(cls, synth, symbol, interval, params, quiet=True).equity
                arr = np.asarray(eq, dtype=float)
                paths.append(arr)
                drawdowns.append(_max_dd_pct(arr))
                if progress is not None:
                    progress(len(paths), sims)
            except Exception:
                failed += 1
    runtime_ms = round((monotonic() - t0) * 1000, 2)

    if not paths:
        raise ValueError("Strategy errored on every simulation — nothing to report")

    matrix = np.stack(paths)  # (sims, bars)
    drawdowns_arr = np.asarray(drawdowns, dtype=float)
    finals = matrix[:, -1]

    start_value = float(real_equity[0])

    def _pct(v: float) -> float:
        return (v / start_value - 1) * 100.0

    q = np.percentile(finals, [5, 10, 25, 50, 75, 90, 95, 99])
    percentiles = {
        "p5": round(float(q[0]), 2),
        "p10": round(float(q[1]), 2),
        "p25": round(float(q[2]), 2),
        "p50": round(float(q[3]), 2),
        "p75": round(float(q[4]), 2),
        "p90": round(float(q[5]), 2),
        "p95": round(float(q[6]), 2),
        "p99": round(float(q[7]), 2),
    }

    win_share = float(np.mean(finals > start_value))

    stats = {
        "start_value": round(start_value, 2),
        "final_mean": round(float(finals.mean()), 2),
        "final_median": round(float(np.median(finals)), 2),
        "final_std": round(float(finals.std(ddof=1)), 2),
        "final_best": round(float(finals.max()), 2),
        "final_worst": round(float(finals.min()), 2),
        "prob_profit": round(win_share, 4),
        "prob_loss": round(1.0 - win_share, 4),
        "expected_return_pct": round(float(_pct(finals.mean())), 4),
        "median_return_pct": round(float(_pct(np.median(finals))), 4),
        "p5_return_pct": round(float(_pct(np.percentile(finals, 5))), 4),
        "p25_return_pct": round(float(_pct(np.percentile(finals, 25))), 4),
        "p75_return_pct": round(float(_pct(np.percentile(finals, 75))), 4),
        "p95_return_pct": round(float(_pct(np.percentile(finals, 95))), 4),
        "avg_max_drawdown_pct": round(float(drawdowns_arr.mean()), 4),
        "median_max_drawdown_pct": round(float(np.median(drawdowns_arr)), 4),
        "worst_max_drawdown_pct": round(float(drawdowns_arr.max()), 4),
        "actual_return_pct": round(float(_pct(real_equity[-1])), 4),
        "actual_max_drawdown_pct": round(float(_max_dd_pct(real_equity)), 4),
    }

    # Pointwise percentile bands across all paths, downsampled for the chart.
    fan_idx = np.unique(np.linspace(0, n - 1, MC_FAN_BARS).astype(int))
    sub = matrix[:, fan_idx]
    bands = [np.percentile(sub, qq, axis=0) for qq in (10, 25, 50, 75, 90)]
    fan = {
        "t": [df.index[i].isoformat() for i in fan_idx],
        "p10": [round(float(v), 2) for v in bands[0]],
        "p25": [round(float(v), 2) for v in bands[1]],
        "p50": [round(float(v), 2) for v in bands[2]],
        "p75": [round(float(v), 2) for v in bands[3]],
        "p90": [round(float(v), 2) for v in bands[4]],
    }
    actual = {
        "t": [df.index[i].isoformat() for i in fan_idx],
        "v": [round(float(v), 2) for v in real_equity[fan_idx]],
    }

    return {
        "symbol": symbol,
        "interval": interval,
        "days": days,
        "sims": len(paths),
        "seed": seed,
        "block": block,
        "bars": n,
        "failed_sims": failed,
        "start": df.index[0].isoformat(),
        "end": df.index[-1].isoformat(),
        "runtime_ms": runtime_ms,
        "stats": stats,
        "percentiles": percentiles,
        "fan": fan,
        "actual": actual,
    }