# DELTA VANTAGE


Paper trading and quantitative research. Watch charts live, place simulated orders, backtest Python strategies and run monte carlo simulations all before touching real capital. 

## Workings

- Server — Python FastAPI. Serves the API endpoints for the frontend and basically does all the trading/backtest logic.
- Frontend — React webapp (TS, Vite). Runs as an electron dekstop app or in browser (desktop reccomended) 
- Data — Alpaca for live prices, yfinance as a fallback. Bars get cached locally in SQLite. to prevent overpolling the APIs. 
- Strategies — plain Python files. Drop one in the strategies panel in the app and backtest it with a button or drag it on a ticker to go live. You can also drag strategies into the ./strategies folder. 

## Dependencies

Python 3.11+ and Node 20+.

## Getting it running

```bash
# Python side one time
python3 -m venv .venv
.venv/bin/pip install -e .

# Frontend one time
cd frontend
npm install
```

If you want to use Alpaca for better data, create an Alpaca account and set `ALPACA_API_KEY` and
`ALPACA_SECRET_KEY`. otherwise it falls back to yfinance for data.

## Running it

Browser (dev server):

```bash
./dev.sh
```

Desktop app:

```bash
cd frontend
npm run dev:electron
```

Packaged desktop build outputs to frontend/release/:

```bash
cd frontend
npm run build:electron
```

API docs (for writing strategies) are at http://localhost:8000/docs once the server's up. Check TECHSPEC.md for information as well.

## Where things live

```
server/            API, portfolios, ordering loop
delta_vantage/      core library (data, indicators, trading)
strategies/        your strategy files, loaded at runtime (or drag them into the frontend)
frontend/          React app + Electron bits
tests/             tests suite
```

## Docs

TechSpec.md — architecture overview, full API reference, and how to write strategies, live-paper trading semantics, and debugging.
