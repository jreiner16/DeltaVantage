*Disclaimer: Generated with AI*
# Delta Vantage Tech Spec + API Reference

Use this document to understand how the pieces fit together, work against the
API directly, write your own strategies, and debug problems.

---

## 1. System overview

```
┌────────────────────────────────────────────────────────────────────┐
│  FRONTEND  (React 19 / TypeScript / Vite / Tailwind, Electron)      │
│  polls /api every few seconds, renders charts & panels              │
└───────────────┬────────────────────────────────────────────────────┘
                │  HTTP /api/*  (same-origin; CORS open)
┌───────────────▼────────────────────────────────────────────────────┐
│  BACKEND  (FastAPI, uvicorn, port 8000)                             │
│  server/main.py          routes, background loops, backtests        │
│  server/state.py         PortfolioManager: portfolios, persistence  │
│  server/live_strategies.py  live strategy manager + catch-up replay │
│  server/settings.py / watchlist.py / performance.py                 │
└───────────────┬────────────────────────────────────────────────────┘
                │
   ┌────────────┼───────────────────┬──────────────────────┐
   │            │                   │                      │
┌──▼─────────┐ ┌▼───────────────┐ ┌─▼──────────────────┐ ┌─▼──────────────────┐
│ DATA       │ │ TRADING        │ │ STRATEGY           │ │ PERSISTENCE        │
│ cache.py   │ │ paper.py       │ │ base.py            │ │ SQLite bars table  │
│ (SQLite)   │ │ PaperBroker    │ │ context.py         │ │ portfolios/ JSON   │
│ alpaca.py  │ │ models.py      │ │ engine.py          │ │ .dv-settings.json  │
│ yfinance.py│ │                │ │ technical.py (ind.)│ │                    │
└────────────┘ └────────────────┘ └────────────────────┘ └────────────────────┘
```

### Processes & background loops

| Loop | Interval | What it does |
|---|---|---|
| `_order_fill_loop` | 10 s | Fills pending orders (market at latest price, limit/stop vs a synthetic bar) and marks open positions to market so unrealized P&L stays fresh. |
| `_live_strategy_tick` | 15 s | Feeds new bars to running live strategies. Runs off the event loop via `asyncio.to_thread` so the API never stalls. |
| Frontend polling | ~5 s | `App.tsx` refresh loop (portfolio, quotes, live strategies). |

### Data flow

- Quotes come from the daily bar cache (last close vs prev close, plus a 30-point
  sparkline). Watchlist symbols are seeded on demand from yfinance.
- Charts request `/api/bars/{symbol}`; the server refreshes the newest cached
  bar (`_refresh_bars_tail`) before answering so chart keeps ticking during
  market hours instead of freezing at first fetch.
- Data providers: **Alpaca** (if `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` set) with
  **yfinance** as fallback. All bars are upserted into a local SQLite cache
  (`bars` table), so the app never re-downloads history it already has.
- Intervals: `1Min`, `5Min`, `15Min`, `30Min`, `1Hour`, `1Day`.

### Persistence layout

Default data dir is `~/.delta-vantage` (override with `DV_DATA_DIR`):

```
~/.delta-vantage/
  cache.db                    SQLite bar cache (symbol, interval, timestamp, OHLCV)
  portfolios/
    index.json                current portfolio + known portfolio ids
    <pid>/
      meta.json               name, created/last_opened, cached equity/pnl
      account.json            broker state: cash, positions, orders, trades, pnl
      performance.json        equity/cash samples (the live equity chart)
      watchlist.json          per-portfolio watchlist
      settings.json           per-portfolio trading settings
      backtests.json          saved backtest runs + config presets
      live_strategies.json    running live strategies + last processed bar
```

App-level defaults (`slippage`, `starting_cash`, etc.) live in
`.dv-settings.json` at the repo root. Env overrides load from a repo-root
`.env` (see `delta_vantage/config.py`). Strategy files load from
`strategies/` (override with `DV_STRATEGIES_DIR`).

### Repository layout

```
server/            FastAPI app: routes, portfolios, fill loop, live manager
delta_vantage/     core library (framework you import from)
  data/            providers + SQLite cache
  indicators/      sma, ema, bollinger, rsi, macd, atr, vwap, stochastic
  strategy/        Strategy base, StrategyContext, loader engine
  trading/         PaperBroker + domain models
strategies/        your strategy .py files (discovered at runtime)
frontend/          React app + Electron wrapper
tests/             pytest suite
dev.sh             runs backend (:8000) + Vite (:5173)
```

---

## 2. Strategy framework

### The base class

```python
# delta_vantage/strategy/base.py
class Bar:  symbol, timestamp, open, high, low, close, volume
class Tick: symbol, timestamp, price, size

class Strategy:
    ctx: StrategyContext
    params: dict
    def start(self) -> None            # once, before the first bar
    def on_bar(self, bar: Bar)         # each new completed candle
    def on_tick(self, tick: Tick)      # per-tick (live streaming; not wired up yet)
    def on_order_filled(self, order)   # on fill
    def stop(self) -> None             # shutdown/cleanup
```

### The context (`ctx`)

The only bridge between a strategy and the outside world:

| Method | Purpose |
|---|---|
| `ctx.get_data(symbol, interval="15Min", lookback=100)` | OHLCV `DataFrame` (columns `Open High Low Close Volume`, DatetimeIndex). In a backtest it only returns bars **up to** the current bar; live it reads the SQLite cache. |
| `ctx.get_indicator(symbol, name, lookback=100, **kwargs)` | Compute an indicator on the same data window. |
| `ctx.place_order(symbol, side, qty, order_type="market", limit_price=None, stop_price=None)` | Submit an order; returns an `Order`. |
| `ctx.cancel_order(order_id)` | Cancel a pending order. |
| `ctx.get_position(symbol)` | Position (signed qty, short = negative) or `None`. |
| `ctx.get_portfolio()` | Account snapshot (cash, buying power, open P&L, trades). |
| `ctx.log(msg)` | Append to the strategy log (shown in backtest logs / live panel). |

### Params

`strategy.params` is a plain dict set from the UI (backtest runner or live
modal). The framework does **not** auto-map it to attributes — merge it in
`start()` yourself:

```python
class MyStrategy(Strategy):
    period = 20  # default

    def start(self):
        self.period = int(self.params.get("period", self.period))
```

### Indicators

Import from `delta_vantage.indicators.technical` or via `ctx.get_indicator`.
Most take `(df, period=…)`; `vwap` takes only `(df)`. Available:
`sma`, `ema`, `bollinger`, `rsi`, `macd`, `atr`, `vwap`, `stochastic`.

### Minimal strategy

```python
"""Crossing SMAs — buys when fast crosses above slow, exits on the reverse."""
from delta_vantage.strategy.base import Strategy
from delta_vantage.indicators.technical import sma


class SMACross(Strategy):
    fast = 10
    slow = 30

    def start(self):
        self.fast = int(self.params.get("fast", self.fast))
        self.slow = int(self.params.get("slow", self.slow))
        self.flat = True
        self.ctx.log(f"ready: {self.fast}/{self.slow}")

    def on_bar(self, bar):
        df = self.ctx.get_data(bar.symbol, lookback=self.slow + 10)
        if len(df) < self.slow:
            return  # not enough warm-up yet
        f = sma(df, self.fast)
        s = sma(df, self.slow)
        above = f.iloc[-1] > s.iloc[-1]

        if above and self.flat:
            self.ctx.place_order(bar.symbol, "buy", 10, "market")
            self.flat = False
            self.ctx.log(f"BUY {bar.symbol} @ {bar.close:.2f}")
        elif not above and not self.flat:
            self.ctx.place_order(bar.symbol, "sell", 10, "market")
            self.flat = True
            self.ctx.log(f"SELL {bar.symbol} @ {bar.close:.2f}")

    def stop(self):
        self.ctx.log(f"final position: flat={self.flat}")
```

Rules of thumb:

- Always **check warm-up length** (`len(df) < your_longest_period`) before
  acting; indicators are NaN until they have enough bars.
- The installed strategy loader picks the *single* `Strategy` subclass in the
  file (`load_strategy` in `delta_vantage/strategy/engine.py`).
- `ctx.log()`, not `print()`, if you want output to show up in the UI.

---

## 3. API reference

All endpoints are under `/api`. FastAPI auto-docs live at
`http://localhost:8000/docs`. Errors return `{"detail": "<message>"}` with a
4xx/5xx status. Symbols are case-insensitive; crypto uses slash notation
(`BTC/USD`) everywhere except yfinance lookups, which swap to `BTC-USD`.

### System

| Method & path | Notes |
|---|---|
| `GET /api/health` | `{"status": "ok"}` |
| `GET /api/market` | US market session (`open`/`pre`/`closed`), NYSE 09:30–16:00 ET weekdays, crypto flagged 24/7. |

### Watchlist & symbols

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/symbols?q=` | fuzzy search on built-in universe + the literal query | `{symbols: []}` |
| `GET /api/watchlist` | — | `{symbols: []}` |
| `POST /api/watchlist` | `{symbol}` | `{symbols: []}` (400 if no market data found) |
| `DELETE /api/watchlist/{symbol}` | — | `{symbols: []}` |
| `PUT /api/watchlist/order` | `{symbols: [...new order]}` | `{symbols: []}` |

### Market data

| Method & path | Params | Returns |
|---|---|---|
| `GET /api/quotes` | — | `{quotes: {SYM: {last, prev_close, change, change_pct, spark}}}` |
| `GET /api/bars/{symbol}` | `interval` (15Min), `days` (30) | `{symbol, interval, bars: [{time, time_ts, open, high, low, close, volume}]}` |
| `GET /api/indicators/{symbol}` | `indicator` (required), `period` (20), `interval`, `days` | `{indicator, series: [{time, value}]}` |

`indicator` is one of `sma | ema | bollinger | rsi | macd | atr | vwap | stochastic`.
For `BTC/USD`, percent-encode the slash: `/api/bars/BTC%2FUSD`.

### Trading

| Method & path | Body / params | Returns |
|---|---|---|
| `GET /api/portfolio` | — | full account snapshot (below) |
| `GET /api/performance` | — | `{points, current_equity, current_cash}`; also records a fresh sample |
| `GET /api/positions` | — | `{positions: [...]}` |
| `GET /api/orders` | — | `{orders: [...]}` |
| `POST /api/orders` | `{symbol, side, qty, order_type?, limit_price?, stop_price?}` | the created `Order` (400 on validation) |
| `POST /api/orders/{id}/cancel` | — | `{ok: true}` |

Order object:
```
{id, symbol, side: buy|sell, order_type: market|limit|stop, qty,
 limit_price, stop_price, status: pending|filled|cancelled|rejected,
 created_at, filled_at, fill_price}
```

Portfolio snapshot:
```
{cash, invested, total_value, unrealized_pnl, realized_pnl,
 num_positions, num_trades, buying_power, short_buying_power,
 positions: {SYM: {symbol, qty, avg_entry_price, current_price,
                    market_value, unrealized_pnl, unrealized_pnl_pct}},
 trades: [...]}
```

### Settings & account

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/settings` | — | server defaults + overrides |
| `PUT /api/settings` | partial patch | whitelisted keys only, each clamped |
| `POST /api/settings/reset` | `{starting_cash?}` | wipes positions/trades/orders/pnl, defaults to the account's initial cash |

Settings keys: `slippage` (default 0.001 = 0.1%), `share_increment` (1),
`min_order_qty` (1), `max_order_qty` (1 000 000), `starting_cash` (100 000),
`short_leverage` (1.0), `theme` (dark|light|mid), `default_interval` (1Min),
`default_lookback_days` (7).

### Portfolios

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/portfolios` | — | list, most-recently-opened first |
| `POST /api/portfolios` | `{name, starting_cash?, slippage?, ...}` | creates + opens |
| `POST /api/portfolios/{pid}/open` | — | hot-swaps broker/cache-adjacent state in place; restores the portfolio's live strategies |
| `PUT /api/portfolios/{pid}` | `{name}` | rename |
| `DELETE /api/portfolios/{pid}` | — | deletes the folder |
| `GET /api/portfolios/{pid}/export` | — | single JSON payload of all portfolio files |
| `POST /api/portfolios/import` | `{payload, name?}` | round-trips an export |

Think of a *portfolio* as a full account: cash, positions, watchlist, saved
backtests, live strategies. Switching portfolios swaps everything.

### Strategies (files)

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/strategies` | — | `{strategies: [{name, path, size, modified}]}` |
| `GET /api/strategies/{name}` | — | `{name, source}` (raw file text) |
| `POST /api/strategies` | `{name, source}` | save/overwrite a file |
| `POST /api/strategies/upload` | `{name, content}` | same, but validated: file is **deleted** if it fails to import |
| `POST /api/strategies/{name}/refresh` | — | clears the import cache so edits take effect |
| `DELETE /api/strategies/{name}` | — | 400 for the bundled `sma_crossover` example |

### Backtests

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /api/strategies/run?name=sma_crossover` | `{symbol?, interval?, days?, params?}` | full result (below) |
| `POST /api/strategies/monte-carlo?name=sma_crossover` | `{symbol?, interval?, days?, sims?, seed?, block?, params?}` | distribution result (below) |

The run uses a **fresh `PaperBroker()` starting at $100k** — it never touches
your live portfolio/account. Flow per bar: `strategy.on_bar(bar)` →
`_fill_pending(broker, bar)` → positions marked to market at bar close →
equity point appended.

Monte Carlo re-runs the same strategy on **synthetic paths** built by a
stationary block bootstrap: the bar shape-factors (gap=open/prev_close,
close/open, high ≥ max(o,c), low ≤ min(o,c), volume scaled) are resampled in
blind blocks and chained multiplicatively from the last real close, so every
path shares the original bar time axis. Sims run across process workers (fork
context) with a serial fallback. `sims` is clamped to `[10, 500]` (200 default),
`block` defaults to `~sqrt(n)` clamped `[10, 60]`; above 20k bars sims are
thinned to keep responses snappy. Per-path exceptions are skipped and counted
in `failed_sims`.

Result shape:
```
{symbol, interval, days,
 portfolio: {...},            # same snapshot shape
 order_count, trade_count,
 start, end,
 equity: [{t, v, c}, ...],    # t=bar time, v=account value, c=bar close
 metrics: {...},
 runtime_ms, bars_processed,
 logs: [strategy ctx.log lines]}
```

Metrics: `total_return_pct`, `annualized_return_pct`, `sharpe_ratio`,
`sortino_ratio`, `max_drawdown_pct`, `max_drawdown_duration`, `win_rate`,
`avg_win`, `avg_loss`, `avg_trade`, `best_trade`, `worst_trade`,
`profit_factor`, `exposure_pct`, `net_profit`, `starting_value`,
`ending_value`.

Monte Carlo result shape:
```
{symbol, interval, days, sims, seed, block, bars, failed_sims,
 start, end, runtime_ms,
 stats: {start_value, final_mean/median/std/best/worst,
         prob_profit, prob_loss,
         expected_return_pct, median_return_pct,
         p5/p25/p75/p95_return_pct,
         avg/median/worst_max_drawdown_pct,
         actual_return_pct, actual_max_drawdown_pct},
 percentiles: {p5, p10, p25, p50, p75, p90, p95, p99},  # final equity
 fan: {t: [bar times], p10, p25, p50, p75, p90},        # ≤240 pts each
 actual: {t, v}}                                        # real run, downsampled
```
`stats.actual_*` compare the strategy's real run on the true bars against the
synthetic distribution. `seed` fixes reproducibility (default: random).

### Saved backtests & presets (per portfolio)

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/portfolios/{pid}/backtests` | — | summaries |
| `GET /api/portfolios/{pid}/backtests/{bid}` | — | full saved result |
| `POST /api/portfolios/{pid}/backtests` | `{label?, strategy, config, result}` | save a run |
| `DELETE /api/portfolios/{pid}/backtests/{bid}` | — | delete |
| `GET /api/portfolios/{pid}/backtest-presets` | — | named configs |
| `POST /api/portfolios/{pid}/backtest-presets` | `{name, config}` | save a config |
| `DELETE /api/portfolios/{pid}/backtest-presets/{name}` | — | delete |

### Live strategies

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/live-strategies` | — | all running strategies |
| `POST /api/live-strategies` | `{strategy, symbol, interval?, params?}` | start one; 400 duplicate `strategy:symbol` or unknown strategy |
| `POST /api/live-strategies/stop-all` | — | stop everything |
| `DELETE /api/live-strategies/{key}` | — | key is `strategy:symbol` (colon is URL-safe) |

Live strategy object:
```
{key, strategy, symbol, interval, params, started_at, last_bar_at,
 bars_processed, logs}
```

Live strategies trade through the **same shared paper broker** as the open
portfolio — same cash, same positions, same buying power as your manual orders.

### WebSocket

`WS /api/ws` currently just acks `{"type":"ack","subscribe":...}` messages. The
frontend is polling-based today; this is the future streaming hook.

---

## 4. Live strategies & the paper broker

### How execution works

- Order validation happens at submit (`qty > 0`, min/max qty, share-increment
  multiple). The broker short-circuits impossible orders with a 400.
- **Market** orders fill at availability: the 10-second fill loop uses the
  latest provider price; inside a backtest or a live bar sweep they fill at the
  bar's close. **Limit/stop** orders fill against the bar's high/low range
  (`_check_pending_order` in `delta_vantage/strategy/engine.py`).
- Slippage is applied adversarially on fill (buy pays up, sell receives less).
- Insufficient buying power → order `REJECTED`, never partially executed into
  thin air. Shorts must satisfy `short_leverage × equity` and be backed by
  reserved cash.

### Live tick lifecycle (`server/live_strategies.py`)

1. `start()` loads the strategy file, builds a `StrategyContext` bound to the
   shared portfolio broker, calls `start()`, registers `key = strategy:symbol`.
2. Every 15 s, `tick()` fetches recent bars (Alpaca, else yfinance), upserts
   them into the SQLite cache, then drives `on_bar` for every bar **newer than
   `last_bar_at`** — with `ctx` pinned to that bar so indicators can't look
   ahead.
3. On the **very first tick** of a fresh start, `last_bar_at` is baselined to
   the newest cached bar, so it joins live without replaying history.
4. Your strategy's orders are filled against the same bar via
   `_check_pending_order`.

### Restart / catch-up

When you close the app, live strategies **stop** — no bars are fetched or
traded while the server is down. Account state (`account.json`) and each
strategy's `last_bar_at`/`bars_processed` are persisted.

On reopen the strategies restore automatically and the first tick **replays**
every bar that printed while the app was down (catch-up), bounded by how much
history the provider returns (~2 days intraday, ~5 days daily). Missed bars are
filled at their historical close/range, exactly as if the app had been running.

Two honest caveats:

- A strategy is **re-created fresh on restore**, so any state it kept on
  *itself* (e.g. `self.flat = True`) is reset. Broker-level truth (positions,
  cash) survives; self-tracked beliefs do not. If a strategy held a position
  before shutdown, replay starts from its `start()` state, not its old one.
- Both live strategies **and** manual trades share one account. Two strategies
  on the same symbol can fight: their internal position counters don't see each
  other (the account just sees one aggregate position), and whoever's buy runs
  first wins the cash — the later one gets `REJECTED` and continues.

### Live strategy failure semantics

- Exception thrown from `start()` → logged to the strategy log, strategy keeps
  running with whatever state it had.
- Exception thrown from `on_bar()` → the strategy is flagged `_errored` and
  **stopped** so the bug surfaces instead of looping forever.

---

## 5. Development & debugging

### Running things directly

```bash
# Backend alone (isolated data, custom port):
DV_DATA_DIR=/tmp/dv-dev .venv/bin/python -m uvicorn server.main:app --port 8731
#   docs: http://localhost:8731/docs

# Full stack:
./dev.sh   # backend :8000 + frontend :5173

# Frontend alone (points at whatever /api serves on the same origin):
cd frontend && npx vite --port 5173
```

### Verifying an endpoint by hand

```bash
curl -s http://localhost:8000/api/health
curl -s "http://localhost:8000/api/bars/AAPL?interval=15Min&days=5"
curl -s -X POST http://localhost:8000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"AAPL","side":"buy","qty":10,"order_type":"market"}'
curl -s -X POST http://localhost:8000/api/live-strategies \
  -H 'Content-Type: application/json' \
  -d '{"strategy":"sma_crossover","symbol":"AAPL","interval":"15Min"}'
```

### Tests & static checks

```bash
.venv/bin/python -m pytest tests/ -v          # backend suite
.venv/bin/python -m py_compile server/*.py    # quick syntax gate
cd frontend && npx tsc -b                      # type check
cd frontend && npx oxlint                      # lint (warnings only)
```

Two tests in `tests/test_paper.py` (`test_insufficient_cash`,
`test_insufficient_position`) fail today because the broker's rejection
messages changed — the behavior they assert (orders reject instead of
overdrawing) is correct.

### Common pitfalls

- **Not enough warm-up.** Indicators are NaN until they've seen `period` bars;
  guard with `len(df) < period` or you'll trade on nothing.
- **Lookahead in backtests.** Don't touch bars after the current one. In the
  sandbox context this is enforced (`_asof` pinning); don't defeat it by
  reading the raw cache directly.
- **Fixed cash assumptions.** Live capacity is shared with everything else. A
  strategy that assumes the whole account is spendable gets `REJECTED` the
  moment a sibling or a manual order takes cash first.
- **Edits not taking effect.** After changing `strategies/*.py` by hand, hit
  `POST /api/strategies/{name}/refresh` (or restart the server) to drop the
  import cache.
- **Crypto tickers.** Alpaca/yfinance expect `BTC-USD`; the platform's
  canonical form is `BTC/USD`. Watch for the swap in URLs (`%2F`) and in
  strategy code accept either.
- **Flat equity curves.** A backtest that barely trades (e.g. 10 shares of a
  $200 stock in $100k) will look like a flat line next to buy-and-hold — the
  frontend scales the two curves independently, so $ moves in the equity curve
  are tiny by construction. Size up or check the numbers in the legend.