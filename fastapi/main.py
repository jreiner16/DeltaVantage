"""FastAPI server"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time as _time
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.config import ALPACA_API_KEY, ALPACA_SECRET_KEY
from backend.strategy.base import Bar
from backend.trading.models import OrderStatus, Portfolio
from server.performance import performance
from server.settings import settings
from server.state import broker, cache, live_manager, manager
from server.watchlist import SEARCH_UNIVERSE, watchlist

logger = logging.getLogger(__name__)

_FILL_INTERVAL = 10  # seconds between order-fill sweeps
_LIVE_TICK_INTERVAL = 15  # seconds between live strategy bar sweeps

_INTERVAL_SECONDS = {
    "1Min": 60,
    "5Min": 300,
    "15Min": 900,
    "30Min": 1800,
    "1Hour": 3600,
    "1Day": 86400,
}

# Throttle cache refreshes per (symbol, interval) so we don't hammer the
# provider on every chart render / bar-boundary refresh.
_last_bar_refresh: dict[tuple[str, str], float] = {}


def _refresh_bars_tail(symbol: str, interval: str, now: datetime) -> None:
    """Keep fetching bars to keep charts updated to latest interval
    """
    latest = cache.get_latest_timestamp(symbol, interval)
    if latest is None:
        return
    step = _INTERVAL_SECONDS.get(interval, 60)
    if (now - latest).total_seconds() <= step:
        return
    key = (symbol, interval)
    now_ts = now.timestamp()
    throttle = max(min(step / 2, 30.0), 5.0)
    if now_ts - _last_bar_refresh.get(key, 0.0) < throttle:
        return
    _last_bar_refresh[key] = now_ts

    start = now - timedelta(days=2 if step < 86400 else 5)
    try:
        from backend.data.alpaca import AlpacaProvider

        provider = AlpacaProvider()
        df = provider.get_bars(symbol, interval, start, now)
        if df is not None and not df.empty:
            cache.upsert_bars(symbol, interval, df)
            return
    except Exception:
        pass
    _seed_from_yfinance(symbol, interval, start, now)


async def _order_fill_loop() -> None:
    from backend.strategy.engine import _check_pending_order

    while True:
        await asyncio.sleep(_FILL_INTERVAL)
        try:
            pending = broker.get_pending_orders()
            # Mark every open position to market so unrealized P&L stays live,
            # not just the symbols with pending orders.
            held = {p.symbol for p in broker.get_positions()}
            symbols = {o.symbol for o in pending} | held
            if not symbols:
                continue
            # Fetch latest market prices for all pending + held symbols
            prices: dict[str, float] = {}
            for symbol in symbols:
                try:
                    from backend.data.alpaca import AlpacaProvider

                    provider = AlpacaProvider()
                    prices[symbol] = provider.get_latest_price(symbol)
                except Exception:
                    pass
            if not prices:
                continue
            now = datetime.now(UTC)
            filled_any = False
            for order in broker.get_pending_orders():
                price = prices.get(order.symbol)
                if price is None:
                    continue
                if order.order_type.value == "market":
                    try:
                        broker.fill_order(order, price)
                        filled_any = True
                    except ValueError:
                        pass
                else:
                    bar = Bar(
                        symbol=order.symbol,
                        timestamp=now,
                        open=price,
                        high=price,
                        low=price,
                        close=price,
                        volume=0.0,
                    )
                    try:
                        _check_pending_order(broker, order, bar)
                        if order.status != OrderStatus.PENDING:
                            filled_any = True
                    except ValueError:
                        pass
            # Update current prices of all held positions (including shorts).
            broker.update_prices(prices)
            if filled_any or held:
                manager.save_current()
        except Exception as exc:
            logger.debug("Order fill sweep error: %s", exc)


async def _live_strategy_tick() -> None:
    while True:
        await asyncio.sleep(_LIVE_TICK_INTERVAL)
        try:
            # yfinance/Alpaca calls are blocking, so run the sweep off the
            # event loop to keep the API responsive.
            await asyncio.to_thread(live_manager.tick)
            if live_manager.get_running():
                manager.save_current()
        except Exception as exc:
            logger.debug("Live strategy tick error: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(_order_fill_loop())
    live_task = asyncio.create_task(_live_strategy_tick())
    yield
    task.cancel()
    live_task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    try:
        await live_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Delta Vantage API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STRATEGIES_DIR = Path(__file__).resolve().parent.parent / "strategies"
STRATEGIES_DIR.mkdir(parents=True, exist_ok=True)


# ── Serialization helpers ────────────────────────────────────────────────────


def _order_dict(o) -> dict:
    return {
        "id": o.id,
        "symbol": o.symbol,
        "side": o.side.value,
        "order_type": o.order_type.value,
        "qty": o.qty,
        "limit_price": o.limit_price,
        "stop_price": o.stop_price,
        "status": o.status.value,
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "filled_at": o.filled_at.isoformat() if o.filled_at else None,
        "fill_price": o.fill_price,
    }


def _position_dict(p) -> dict:
    return {
        "symbol": p.symbol,
        "qty": p.qty,
        "avg_entry_price": p.avg_entry_price,
        "current_price": p.current_price,
        "market_value": p.market_value,
        "unrealized_pnl": p.unrealized_pnl,
        "unrealized_pnl_pct": p.unrealized_pnl_pct,
    }


def _portfolio_dict(p: Portfolio) -> dict:
    return {
        "cash": p.cash,
        "invested": p.invested,
        "total_value": p.total_value,
        "unrealized_pnl": p.unrealized_pnl,
        "realized_pnl": p.realized_pnl,
        "num_positions": p.num_positions,
        "num_trades": p.num_trades,
        "buying_power": p.buying_power,
        "short_buying_power": p.short_buying_power,
        "positions": {sym: _position_dict(pos) for sym, pos in p.positions.items()},
        "trades": [
            {
                "order_id": t.order_id,
                "symbol": t.symbol,
                "side": t.side.value,
                "qty": t.qty,
                "price": t.price,
                "timestamp": t.timestamp.isoformat(),
            }
            for t in p.trades
        ],
    }


# ── Request/response models ──────────────────────────────────────────────────


class OrderRequest(BaseModel):
    symbol: str
    side: str
    qty: float
    order_type: str = "market"
    limit_price: float | None = None
    stop_price: float | None = None


class StrategyRunRequest(BaseModel):
    symbol: str = "AAPL"
    interval: str = "15Min"
    days: int = 30
    params: dict = Field(default_factory=dict)


class StrategyJobState(BaseModel):
    job_id: str
    kind: str  # "backtest" | "monte_carlo"
    status: str = "pending"  # pending | running | done | error
    stage: str = "queued"
    progress: float = 0.0
    error: str | None = None
    result: dict | None = None
    created_at: float = 0.0


_JOBS: dict[str, StrategyJobState] = {}
_JOBS_LOCK = threading.Lock()


def _update_job(job: StrategyJobState, *, stage: str | None = None, progress: float | None = None) -> None:
    with _JOBS_LOCK:
        if stage is not None:
            job.stage = stage
        if progress is not None:
            job.progress = progress


def _start_job(kind: str, func) -> dict:
    job = StrategyJobState(
        job_id=uuid.uuid4().hex,
        kind=kind,
        status="pending",
        stage="queued",
        progress=0.0,
        created_at=_time.time(),
    )
    with _JOBS_LOCK:
        _JOBS[job.job_id] = job
        while len(_JOBS) > 50:
            _JOBS.pop(next(iter(_JOBS)))

    def _run() -> None:
        try:
            job.status = "running"
            job.result = func(job)
            job.status = "done"
            job.progress = 1.0
        except Exception as e:
            job.status = "error"
            detail = getattr(e, "detail", None)
            job.error = detail if isinstance(detail, str) and detail else str(e)

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job.job_id}


class SettingsUpdate(BaseModel):
    slippage: float | None = None
    share_increment: float | None = None
    min_order_qty: int | None = None
    max_order_qty: int | None = None
    starting_cash: float | None = None
    short_leverage: float | None = None
    theme: str | None = None
    default_interval: str | None = None
    default_lookback_days: int | None = None


class SymbolRequest(BaseModel):
    symbol: str


class ResetRequest(BaseModel):
    starting_cash: float | None = None


# ── Data endpoints ───────────────────────────────────────────────────────────


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/market")
def market_status() -> dict:
    now_utc = datetime.now(UTC)
    # US equity market: 09:30 - 16:00 ET, Mon-Fri. Compute in America/New_York.
    try:
        from zoneinfo import ZoneInfo

        et = now_utc.astimezone(ZoneInfo("America/New_York"))
    except Exception:
        et = now_utc
    wd = et.weekday()  # Monday=0 .. Sunday=6
    open_t = et.replace(hour=9, minute=30, second=0, microsecond=0)
    close_t = et.replace(hour=16, minute=0, second=0, microsecond=0)
    if wd >= 5:
        status = "closed"
        reason = "weekend"
        next_open = "next weekday 09:30 ET"
    elif et < open_t:
        status = "pre"
        reason = "pre-market"
        next_open = "09:30 ET today"
    elif et >= close_t:
        status = "closed"
        reason = "after close"
        next_open = "next weekday 09:30 ET"
    else:
        status = "open"
        reason = "regular session"
        next_open = "16:00 ET close"
    return {
        "exchange": "NYSE",
        "status": status,
        "reason": reason,
        "next_open": next_open,
        "time": now_utc.isoformat(),
        "local_time": et.isoformat(),
        "crypto": "24/7",
    }


@app.get("/api/symbols")
def symbols(q: str = "") -> dict:
    universe = SEARCH_UNIVERSE
    if q:
        query = q.strip().upper()
        universe = sorted(
            set(
                [query]  # allow typing any ticker
                + [s for s in universe if query in s.upper()]
            )
        )
    return {"symbols": universe}


@app.get("/api/watchlist")
def get_watchlist() -> dict:
    return {"symbols": watchlist.all()}


def _symbol_exists(symbol: str, interval: str = "1Day") -> bool:
    try:
        # Try the cache first — if we have any cached bars for it, it's valid.
        now = datetime.now(UTC)
        df = cache.get_bars(symbol, interval, now - timedelta(days=7), now)
        if df is not None and not df.empty:
            return True
        # Otherwise seed from yfinance and see if anything comes back.
        seeded = _seed_from_yfinance(symbol, interval, now - timedelta(days=30), now)
        if seeded is not None and not seeded.empty:
            return True
        # Try Alpaca directly as a final source.
        from backend.data.alpaca import AlpacaProvider

        provider = AlpacaProvider()
        if ALPACA_API_KEY and ALPACA_SECRET_KEY:
            df = provider.get_bars(symbol, interval, now - timedelta(days=7), now)
            return df is not None and not df.empty
    except Exception:
        return False
    return False


@app.post("/api/watchlist")
def add_watchlist(req: SymbolRequest) -> dict:
    symbol = req.symbol.upper().strip()
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbol is required")
    if not _symbol_exists(symbol):
        raise HTTPException(
            status_code=400,
            detail=f"No market data found for '{symbol}'. Verify the ticker.",
        )
    return {"symbols": watchlist.add(symbol)}


@app.delete("/api/watchlist/{symbol}")
def remove_watchlist(symbol: str) -> dict:
    return {"symbols": watchlist.remove(symbol)}


class WatchlistReorderRequest(BaseModel):
    symbols: list[str]


@app.put("/api/watchlist/order")
def reorder_watchlist(req: WatchlistReorderRequest) -> dict:
    return {"symbols": watchlist.reorder(req.symbols)}


@app.get("/api/quotes")
def quotes() -> dict:
    now = datetime.now(UTC)
    start = now - timedelta(days=120)
    result: dict[str, Any] = {}
    for symbol in sorted(set(watchlist.all())):
        df = cache.get_bars(symbol, "1Day", start, now)
        if df is None or df.empty:
            df = _seed_from_yfinance(symbol, "1Day", start, now)
        if df is None or df.empty:
            continue
        closes = [float(r["Close"]) for _, r in df.iterrows()]
        if not closes:
            continue
        last = closes[-1]
        prev_close = closes[-2] if len(closes) >= 2 else last
        result[symbol] = {
            "last": round(last, 2),
            "prev_close": round(prev_close, 2),
            "change": round(last - prev_close, 2),
            "change_pct": round((last / prev_close - 1) * 100, 2) if prev_close else 0.0,
            "spark": [round(c, 2) for c in closes[-30:]],
        }
    return {"quotes": result}


@app.get("/api/bars/{symbol}")
def bars(symbol: str, interval: str = "15Min", days: int = 30) -> dict:
    return _bars(symbol, interval, days)


@app.get("/api/bars/{symbol:path}")
def bars_path(symbol: str, interval: str = "15Min", days: int = 30) -> dict:
    return _bars(symbol, interval, days)


def _bars(symbol: str, interval: str = "15Min", days: int = 30) -> dict:
    now = datetime.now(UTC)
    # Keep the most recent bar current so charts tick forward during market
    # hours instead of freezing at whatever was first cached.
    _refresh_bars_tail(symbol, interval, now)
    start = now - timedelta(days=days)
    df = cache.get_bars(symbol, interval, start, now)
    # If cache doesn't fully cover the requested range, extend it from yfinance.
    # But only seed if the cache is significantly short — avoid re-fetching when
    # we already have most of the data.
    needs_seed = df is None or df.empty or df.index[0] > start + timedelta(days=min(days * 0.05, 7))
    if needs_seed:
        seeded = _seed_from_yfinance(symbol, interval, start, now)
        if seeded is not None and not seeded.empty:
            fresh = cache.get_bars(symbol, interval, start, now)
            df = fresh if fresh is not None and not fresh.empty else seeded
    if df is None or df.empty:
        raise HTTPException(status_code=404, detail=f"No data for {symbol} at {interval}")
    bars = [
        {
            "time": ts.isoformat(),
            "time_ts": int(ts.timestamp()),
            "open": round(float(r["Open"]), 2),
            "high": round(float(r["High"]), 2),
            "low": round(float(r["Low"]), 2),
            "close": round(float(r["Close"]), 2),
            "volume": float(r["Volume"]),
        }
        for ts, r in df.iterrows()
    ]
    return {
        "symbol": symbol,
        "interval": interval,
        "bars": bars,
    }


def _seed_from_yfinance(symbol: str, interval: str, start: datetime, end: datetime):
    try:
        from backend.data.yfinance import YFinanceProvider

        provider = YFinanceProvider()
        df = provider.get_bars(_yf_symbol(symbol), interval, start, end)
        if df is not None and not df.empty:
            cache.upsert_bars(symbol, interval, df)
            return df
    except Exception:
        return None
    return None


def _yf_symbol(symbol: str) -> str:
    if "/" in symbol:
        return symbol.replace("/", "-")
    return symbol


@app.get("/api/indicators/{symbol}")
def indicator_series(
    symbol: str,
    indicator: str = "",
    period: int = 20,
    interval: str = "15Min",
    days: int = 30,
) -> dict:
    from backend.indicators.technical import INDICATORS

    if not indicator:
        raise HTTPException(status_code=400, detail="query param 'indicator' is required")

    func = INDICATORS.get(indicator.lower())
    if func is None:
        available = sorted(INDICATORS.keys())
        raise HTTPException(
            status_code=400,
            detail=f"Unknown indicator '{indicator}'. Available: {available}",
        )

    now = datetime.now(UTC)
    start = now - timedelta(days=days)
    df = cache.get_bars(symbol, interval, start, now)
    if df is None or df.empty:
        df = _seed_from_yfinance(symbol, interval, start, now)
    if df is None or df.empty:
        raise HTTPException(status_code=404, detail=f"No data for {symbol} at {interval}")

    # Call the indicator function — most accept (df, period=…)
    try:
        result = func(df, period=period)
    except TypeError:
        # Some indicators (vwap) don't accept a period arg
        result = func(df)

    # Normalise to a single series if the indicator returns a DataFrame
    if isinstance(result, pd.DataFrame):
        # Return the first column for the simple endpoint
        series_col = result.iloc[:, 0]
    else:
        series_col = result

    series = [
        {"time": int(ts.timestamp()), "value": round(float(v), 6)}
        for ts, v in series_col.items()
        if pd.notna(v)
    ]
    return {"indicator": indicator.lower(), "series": series}


@app.get("/api/indicators/{symbol:path}")
def indicator_series_path(
    symbol: str,
    indicator: str = "",
    period: int = 20,
    interval: str = "15Min",
    days: int = 30,
) -> dict:
    # Handles crypto tickers like BTC/USD — uvicorn decodes %2F before
    # routing, so a single-segment {symbol} route never matches those.
    return indicator_series(symbol, indicator, period, interval, days)


# ── Trading endpoints ────────────────────────────────────────────────────────


@app.get("/api/portfolio")
def portfolio() -> dict:
    return _portfolio_dict(broker.get_portfolio())


@app.get("/api/performance")
def performance_curve() -> dict:
    p = broker.get_portfolio()
    performance.sample(p.total_value, p.cash)
    points = performance.points()
    return {
        "points": points,
        "current_equity": p.total_value,
        "current_cash": p.cash,
    }


@app.get("/api/positions")
def positions() -> dict:
    return {"positions": [_position_dict(p) for p in broker.get_positions()]}


@app.get("/api/orders")
def orders() -> dict:
    return {"orders": [_order_dict(o) for o in broker._orders.values()]}


@app.post("/api/orders")
def place_order(req: OrderRequest) -> dict:
    symbol = req.symbol.upper()
    try:
        order = broker.place_order(
            symbol,
            req.side,
            req.qty,
            req.order_type,
            req.limit_price,
            req.stop_price,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    manager.save_current()
    return _order_dict(order)


@app.post("/api/orders/{order_id}/cancel")
def cancel_order(order_id: str) -> dict:
    ok = broker.cancel_order(order_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Order not found or already filled")
    manager.save_current()
    return {"ok": True}


# ── Settings & account endpoints ─────────────────────────────────────────────


@app.get("/api/settings")
def get_settings() -> dict:
    return {"settings": settings.all()}


@app.put("/api/settings")
def update_settings(req: SettingsUpdate) -> dict:
    data = settings.update(req.model_dump(exclude_none=True))
    # Push runtime config into the live broker so changes take effect immediately.
    broker.apply_settings(
        slippage=data["slippage"],
        share_increment=data.get("share_increment"),
        min_order_qty=data.get("min_order_qty"),
        max_order_qty=data.get("max_order_qty"),
        short_leverage=data.get("short_leverage"),
    )
    return {"settings": data}


@app.post("/api/settings/reset")
def reset_account(req: ResetRequest) -> dict:
    """Reset the paper account: clear positions/trades/pnl and restore cash."""
    cash = req.starting_cash if req.starting_cash is not None else settings.get("starting_cash")
    broker.reset(initial_cash=cash)
    performance.reset()
    manager.save_current()
    return {"ok": True, "portfolio": _portfolio_dict(broker.get_portfolio())}


# ── Portfolio endpoints ─────────────────────────────────────────────────────


class PortfolioCreateRequest(BaseModel):
    name: str
    starting_cash: float | None = None
    slippage: float | None = None
    share_increment: float | None = None
    min_order_qty: int | None = None
    max_order_qty: int | None = None
    default_interval: str | None = None
    default_lookback_days: int | None = None


class PortfolioRenameRequest(BaseModel):
    name: str


@app.get("/api/portfolios")
def portfolios() -> dict:
    return {"portfolios": manager.list()}


@app.post("/api/portfolios")
async def create_portfolio(req: PortfolioCreateRequest) -> dict:
    extra = {}
    if req.slippage is not None:
        extra["slippage"] = req.slippage
    if req.share_increment is not None:
        extra["share_increment"] = req.share_increment
    if req.min_order_qty is not None:
        extra["min_order_qty"] = req.min_order_qty
    if req.max_order_qty is not None:
        extra["max_order_qty"] = req.max_order_qty
    if req.default_interval is not None:
        extra["default_interval"] = req.default_interval
    if req.default_lookback_days is not None:
        extra["default_lookback_days"] = req.default_lookback_days
    try:
        entry = await asyncio.to_thread(
            manager.create, req.name, req.starting_cash, extra
        )
        state = await asyncio.to_thread(broker.get_portfolio)
        return {"portfolio": entry, "portfolio_state": _portfolio_dict(state)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("create_portfolio failed")
        raise HTTPException(status_code=500, detail=f"Failed to create portfolio: {e}")


@app.post("/api/portfolios/{pid}/open")
def open_portfolio(pid: str) -> dict:
    try:
        entry = manager.open(pid)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"portfolio": entry, "portfolio_state": _portfolio_dict(broker.get_portfolio())}


@app.put("/api/portfolios/{pid}")
def rename_portfolio(pid: str, req: PortfolioRenameRequest) -> dict:
    try:
        return {"portfolio": manager.rename(pid, req.name)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/portfolios/{pid}")
def delete_portfolio(pid: str) -> dict:
    manager.delete(pid)
    return {"ok": True}


@app.get("/api/portfolios/{pid}/export")
def export_portfolio(pid: str) -> dict:
    try:
        return manager.export(pid)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


class PortfolioImportRequest(BaseModel):
    payload: dict
    name: str | None = None


@app.post("/api/portfolios/import")
def import_portfolio(req: PortfolioImportRequest) -> dict:
    try:
        entry = manager.import_payload(req.payload, req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"portfolio": entry, "portfolio_state": _portfolio_dict(broker.get_portfolio())}


# ── Backtest persistence ─────────────────────────────────────────────────────


class BacktestSaveRequest(BaseModel):
    label: str = ""
    strategy: str
    config: dict = Field(default_factory=dict)
    result: dict = Field(default_factory=dict)


@app.get("/api/portfolios/{pid}/backtests")
def list_backtests(pid: str) -> dict:
    return {"backtests": manager.list_backtests(pid)}


@app.get("/api/portfolios/{pid}/backtests/{bid}")
def get_backtest(pid: str, bid: str) -> dict:
    run = manager.get_backtest(pid, bid)
    if run is None:
        raise HTTPException(status_code=404, detail="Backtest run not found")
    return run


@app.post("/api/portfolios/{pid}/backtests")
def save_backtest(pid: str, req: BacktestSaveRequest) -> dict:
    run = manager.save_backtest(pid, req.label, req.strategy, req.config, req.result)
    return run


@app.delete("/api/portfolios/{pid}/backtests/{bid}")
def delete_backtest(pid: str, bid: str) -> dict:
    manager.delete_backtest(pid, bid)
    return {"ok": True}


@app.get("/api/portfolios/{pid}/backtest-presets")
def list_presets(pid: str) -> dict:
    return {"presets": manager.list_presets(pid)}


class PresetSaveRequest(BaseModel):
    name: str
    config: dict = Field(default_factory=dict)


@app.post("/api/portfolios/{pid}/backtest-presets")
def save_preset(pid: str, req: PresetSaveRequest) -> dict:
    manager.save_preset(pid, req.name, req.config)
    return {"ok": True}


@app.delete("/api/portfolios/{pid}/backtest-presets/{name}")
def delete_preset(pid: str, name: str) -> dict:
    manager.delete_preset(pid, name)
    return {"ok": True}


# ── Strategy endpoints ───────────────────────────────────────────────────────


@app.get("/api/strategies")
def strategies() -> dict:
    files = [p for p in sorted(STRATEGIES_DIR.glob("*.py")) if p.name != "__init__.py"]
    result = []
    for p in files:
        result.append(
            {
                "name": p.stem,
                "path": str(p),
                "size": p.stat().st_size,
                "modified": datetime.fromtimestamp(p.stat().st_mtime, tz=UTC).isoformat(),
            }
        )
    return {"strategies": result}


@app.get("/api/strategies/{name}")
def strategy_source(name: str) -> dict:
    path = _require_strategy_path(name)
    return {"name": name, "source": path.read_text()}


class StrategySaveRequest(BaseModel):
    name: str
    source: str


@app.post("/api/strategies")
def save_strategy(req: StrategySaveRequest) -> dict:
    safe = Path(req.name).name
    if not safe or safe in (".", "..") or any(c in safe for c in "/\\"):
        raise HTTPException(status_code=400, detail="Invalid strategy name")
    path = STRATEGIES_DIR / f"{safe}.py"
    path.write_text(req.source)
    # Validate it imports and yields a Strategy subclass on the next load
    _require_strategy_path(safe)
    return {"ok": True, "name": safe}


class StrategyUploadRequest(BaseModel):
    name: str
    content: str


@app.post("/api/strategies/upload")
def upload_strategy(req: StrategyUploadRequest) -> dict:
    """Upload a strategy file's raw content. Submits the full file as a string."""
    safe = Path(req.name).name
    if not safe or safe in (".", "..") or any(c in safe for c in "/\\"):
        raise HTTPException(status_code=400, detail="Invalid strategy name")
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="Strategy file is empty")
    path = STRATEGIES_DIR / f"{safe}.py"
    path.write_text(req.content)
    # Validate it imports and yields a Strategy subclass on the next load
    try:
        _require_strategy_path(safe)
    except Exception as e:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Strategy failed to import: {e}")
    return {"ok": True, "name": safe}


@app.post("/api/strategies/{name}/refresh")
def refresh_strategy_cache(name: str) -> dict:
    """Clear import cache so edits to a strategy file take effect."""
    for mod_name in list(sys.modules):
        if mod_name == f"strategies.{name}" or mod_name.startswith(f"strategies.{name}."):
            del sys.modules[mod_name]
    # also force-dump the dynamic module loaded by load_strategy
    for mod_name in list(sys.modules):
        if mod_name == name:
            del sys.modules[mod_name]
    return {"ok": True}


@app.delete("/api/strategies/{name}")
def delete_strategy(name: str) -> dict:
    path = _require_strategy_path(name)
    if name == "sma_crossover":
        raise HTTPException(status_code=400, detail="Cannot delete the bundled example")
    path.unlink(missing_ok=True)
    return {"ok": True}


def _require_strategy_path(name: str) -> Path:
    safe = Path(name).name
    path = STRATEGIES_DIR / f"{safe}.py"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Strategy '{safe}' not found")
    return path


@app.post("/api/strategies/run")
def run_strategy(name: str, req: StrategyRunRequest) -> dict:
    return _start_job("backtest", lambda job: _run_backtest(name, req, job))


class MonteCarloRequest(BaseModel):
    symbol: str = "AAPL"
    interval: str = "15Min"
    days: int = 30
    sims: int = 200
    seed: int | None = None
    block: int | None = None
    params: dict = Field(default_factory=dict)


@app.post("/api/strategies/monte-carlo")
def strategies_monte_carlo(name: str, req: MonteCarloRequest) -> dict:
    return _start_job("monte_carlo", lambda job: _run_monte_carlo(name, req, job))


@app.get("/api/strategies/jobs/{job_id}")
def strategy_job(job_id: str) -> StrategyJobState:
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _run_monte_carlo(name: str, req: MonteCarloRequest, job: StrategyJobState | None = None) -> dict:
    from backend.strategy.monte_carlo import run_monte_carlo

    def set(stage: str, frac: float) -> None:
        if job is not None:
            _update_job(job, stage=stage, progress=frac)

    set("Loading strategy", 0.0)
    cls = _load_strategy_class(name)
    days = _cap_lookback_days(req.interval, req.days)
    set(f"Fetching {req.symbol} / {req.interval} ({days}d)", 0.05)
    df = _fetch_backtest_bars(req.symbol, req.interval, days)
    try:
        return run_monte_carlo(
            cls,
            df,
            req.symbol,
            req.interval,
            days,
            req.params,
            req.sims,
            req.seed,
            req.block,
            progress=lambda done, total: set(f"Simulating {done:,} / {total:,} paths", 0.08 + 0.9 * (done / total)),
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def _load_strategy_class(name: str):
    try:
        from backend.strategy.engine import load_strategy
    except Exception:
        raise HTTPException(status_code=500, detail="Engine import failed")
    return load_strategy(_require_strategy_path(name))


def _run_backtest(name: str, req: StrategyRunRequest, job: StrategyJobState | None = None) -> dict:
    from backend.strategy.engine import run_backtest

    def set(stage: str, frac: float) -> None:
        if job is not None:
            _update_job(job, stage=stage, progress=frac)

    days = _cap_lookback_days(req.interval, req.days)
    set("Loading strategy", 0.0)
    cls = _load_strategy_class(name)
    set(f"Fetching {req.symbol} / {req.interval} ({days}d)", 0.05)
    df = _fetch_backtest_bars(req.symbol, req.interval, days)
    set("Running bars", 0.1)
    result, bkr = run_backtest(
        cls,
        df,
        req.symbol,
        req.interval,
        req.params,
        cache,
        progress=lambda done, total: set(f"Running {done:,} / {total:,} bars", 0.1 + 0.85 * (done / total)),
    )
    result["days"] = days
    result["portfolio"] = _portfolio_dict(bkr.get_portfolio())
    set("Finalizing", 0.98)
    return result


# Match YFinanceProvider's intraday lookback caps so the UI never waits on a
# request Yahoo can't actually serve (e.g. 1Min has only 7 days of history).
_INTRADAY_LOOKBACK_DAYS = {
    "1Min": 7,
    "5Min": 30,
    "15Min": 45,
    "30Min": 45,
    "1Hour": 730,
}


def _cap_lookback_days(interval: str, days: int) -> int:
    return min(days, _INTRADAY_LOOKBACK_DAYS.get(interval, days))


def _fetch_backtest_bars(symbol: str, interval: str, days: int) -> pd.DataFrame:
    now = datetime.now(UTC)
    start = now - timedelta(days=days)
    df = cache.get_bars(symbol, interval, start, now)
    if df is None or df.empty:
        df = _seed_from_yfinance(symbol, interval, start, now)
    if df is None or df.empty:
        raise HTTPException(status_code=404, detail=f"No data for {symbol}")
    return df


# ── Live strategy endpoints ─────────────────────────────────────────────────


class LiveStrategyStartRequest(BaseModel):
    strategy: str
    symbol: str
    interval: str = "15Min"
    params: dict = Field(default_factory=dict)


@app.get("/api/live-strategies")
def list_live_strategies() -> dict:
    return {"strategies": [r.to_dict() for r in live_manager.get_running()]}


@app.post("/api/live-strategies")
def start_live_strategy(req: LiveStrategyStartRequest) -> dict:
    symbol = req.symbol.upper().strip()
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbol is required")
    try:
        entry = live_manager.start(
            strategy_name=req.strategy,
            symbol=symbol,
            interval=req.interval,
            params=req.params,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    manager.save_current()
    return entry.to_dict()


@app.post("/api/live-strategies/stop-all")
def stop_all_live_strategies() -> dict:
    count = live_manager.stop_all()
    manager.save_current()
    return {"ok": True, "stopped": count}


@app.delete("/api/live-strategies/{key}")
def stop_live_strategy(key: str) -> dict:
    ok = live_manager.stop(key)
    if not ok:
        raise HTTPException(status_code=404, detail="Live strategy not found")
    manager.save_current()
    return {"ok": True}


# ── WebSocket for live streaming ─────────────────────────────────────────────


class ConnectionManager:
    def __init__(self) -> None:
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict) -> None:
        for ws in list(self.active):
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect(ws)


connections = ConnectionManager()


@app.websocket("/api/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await connections.connect(ws)
    try:
        while True:
            data = await ws.receive_json()
            # Client requests a symbol to follow — acknowledge
            await ws.send_json({"type": "ack", "subscribe": data.get("subscribe")})
    except WebSocketDisconnect:
        connections.disconnect(ws)


# ── Serve the built frontend (production mode) ──────────────────────────────
#
# In Electron the built app is loaded from disk, so this only matters for
# browser-based deployments. Vite builds to /tmp/dv-frontend-dist (see
# frontend/vite.config.ts) — the project root is cloud-synced, which mangles
# writes into frontend/dist/.
_DIST = Path("/tmp/dv-frontend-dist")

if _DIST.exists():
    from fastapi.staticfiles import StaticFiles
    from starlette.responses import FileResponse

    # Serve the built React app for any non-API path (SPA fallback)
    app.mount("/assets", StaticFiles(directory=str(_DIST / "assets")), name="static-assets")

    @app.get("/{path:path}")
    async def serve_spa(path: str = "") -> FileResponse:
        # If a matching static file exists, serve it; otherwise return index.html (SPA)
        file = _DIST / path
        if path and file.is_file():
            return FileResponse(str(file))
        return FileResponse(str(_DIST / "index.html"))
