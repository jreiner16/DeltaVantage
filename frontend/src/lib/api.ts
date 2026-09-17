const BASE = "/api";

function detailMessage(err: { detail?: unknown } | string, fallback: string): string {
  const d = typeof err === "string" ? err : err?.detail;
  if (typeof d === "string" && d.trim()) return d;
  if (Array.isArray(d) && d.length > 0) {
    // FastAPI 422 validation errors: [{ loc, msg, type }, ...]
    const parts = d
      .map((e) =>
        typeof e === "object" && e !== null && "msg" in e
          ? String((e as { msg: unknown }).msg)
          : JSON.stringify(e)
      )
      .filter(Boolean);
    if (parts.length > 0) return parts.join("; ");
  }
  if (typeof d === "object" && d !== null && "message" in d) {
    return String((d as { message: unknown }).message);
  }
  return fallback;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(detailMessage(err as never, `POST ${path} failed: ${res.status}`));
  }
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(detailMessage(err as never, `PUT ${path} failed: ${res.status}`));
  }
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  return res.json();
}

export const api = {
  market: () => get<import("./types").MarketStatus>("/market"),
  portfolios: () => get<{ portfolios: import("./types").PortfolioEntry[] }>("/portfolios"),
  createPortfolio: (name: string, opts?: { starting_cash?: number; slippage?: number; share_increment?: number; min_order_qty?: number; max_order_qty?: number }) =>
    post<{ portfolio: import("./types").PortfolioEntry; portfolio_state: import("./types").Portfolio }>(
      "/portfolios",
      { name, ...opts }
    ),
  openPortfolio: (id: string) =>
    post<{ portfolio: import("./types").PortfolioEntry; portfolio_state: import("./types").Portfolio }>(
      `/portfolios/${encodeURIComponent(id)}/open`
    ),
  renamePortfolio: (id: string, name: string) =>
    put<{ portfolio: import("./types").PortfolioEntry }>(
      `/portfolios/${encodeURIComponent(id)}`,
      { name }
    ),
  deletePortfolio: (id: string) =>
    del<{ ok: boolean }>(`/portfolios/${encodeURIComponent(id)}`),
  exportPortfolio: (id: string) =>
    get<{ format: string; version: number; id: string; name: string; files: Record<string, unknown> }>(
      `/portfolios/${encodeURIComponent(id)}/export`
    ),
  importPortfolio: (payload: Record<string, unknown>, name?: string) =>
    post<{ portfolio: import("./types").PortfolioEntry; portfolio_state: import("./types").Portfolio }>(
      "/portfolios/import",
      name ? { payload, name } : { payload }
    ),
  symbols: (q = "") =>
    get<{ symbols: string[] }>(`/symbols${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  watchlist: () => get<{ symbols: string[]; max: number }>("/watchlist"),
  addWatchlist: (symbol: string) =>
    post<{ symbols: string[] }>("/watchlist", { symbol }),
  removeWatchlist: (symbol: string) =>
    del<{ symbols: string[] }>(`/watchlist/${encodeURIComponent(symbol)}`),
  reorderWatchlist: (symbols: string[]) =>
    put<{ symbols: string[] }>("/watchlist/order", { symbols }),
  quotes: () =>
    get<{
      quotes: Record<
        string,
        {
          last: number;
          prev_close: number;
          change: number;
          change_pct: number;
          spark: number[];
        }
      >;
    }>("/quotes"),
  bars: (symbol: string, interval = "15Min", days = 30) =>
    get<{
      symbol: string;
      interval: string;
      bars: Array<{
        time: string;
        time_ts: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }>;
    }>(`/bars/${encodeURIComponent(symbol)}?interval=${interval}&days=${days}`),

  // Trading
  portfolio: () => get<import("./types").Portfolio>("/portfolio"),
  performance: () =>
    get<import("./types").PerformanceResponse>("/performance"),
  orders: () => get<{ orders: import("./types").Order[] }>("/orders"),
  placeOrder: (req: {
    symbol: string;
    side: string;
    qty: number;
    order_type?: string;
    limit_price?: number | null;
    stop_price?: number | null;
  }) => post<import("./types").Order>("/orders", req),
  cancelOrder: (orderId: string) =>
    post<{ ok: boolean }>(`/orders/${encodeURIComponent(orderId)}/cancel`),

  // Strategies
  strategies: () =>
    get<{ strategies: import("./types").Strategy[] }>("/strategies"),
  strategySource: (name: string) =>
    get<{ name: string; source: string }>(
      `/strategies/${encodeURIComponent(name)}`
    ),
  uploadStrategy: (name: string, content: string) =>
    post<{ ok: boolean; name: string }>("/strategies/upload", { name, content }),
  deleteStrategy: (name: string) =>
    del<{ ok: boolean }>(`/strategies/${encodeURIComponent(name)}`),
  refreshStrategy: (name: string) =>
    post<{ ok: boolean }>(`/strategies/${encodeURIComponent(name)}/refresh`),
  runStrategy: (
    name: string,
    req: { symbol?: string; interval?: string; days?: number; params?: Record<string, unknown> }
  ) =>
    post<{ job_id: string }>(
      `/strategies/run?name=${encodeURIComponent(name)}`,
      req
    ),
  runMonteCarlo: (
    name: string,
    req: {
      symbol?: string;
      interval?: string;
      days?: number;
      sims?: number;
      seed?: number | null;
      block?: number | null;
      params?: Record<string, unknown>;
    }
  ) =>
    post<{ job_id: string }>(
      `/strategies/monte-carlo?name=${encodeURIComponent(name)}`,
      req
    ),
  job: <T>(jobId: string) =>
    get<import("./types").JobState<T>>(
      `/strategies/jobs/${encodeURIComponent(jobId)}`
    ),

  // Saved backtest runs (per-portfolio)
  backtests: (pid: string) =>
    get<{ backtests: import("./types").BacktestSummary[] }>(
      `/portfolios/${encodeURIComponent(pid)}/backtests`
    ),
  getBacktest: (pid: string, bid: string) =>
    get<import("./types").SavableBacktest>(
      `/portfolios/${encodeURIComponent(pid)}/backtests/${encodeURIComponent(bid)}`
    ),
  saveBacktest: (
    pid: string,
    req: { label?: string; strategy: string; config: Record<string, unknown>; result: unknown }
  ) =>
    post<import("./types").SavableBacktest>(
      `/portfolios/${encodeURIComponent(pid)}/backtests`,
      req
    ),
  deleteBacktest: (pid: string, bid: string) =>
    del<{ ok: boolean }>(`/portfolios/${encodeURIComponent(pid)}/backtests/${encodeURIComponent(bid)}`),

  // Saved backtest config presets (per-portfolio)
  presets: (pid: string) =>
    get<{ presets: Record<string, Record<string, unknown>> }>(
      `/portfolios/${encodeURIComponent(pid)}/backtest-presets`
    ),
  savePreset: (pid: string, name: string, config: Record<string, unknown>) =>
    post<{ ok: boolean }>(`/portfolios/${encodeURIComponent(pid)}/backtest-presets`, { name, config }),
  deletePreset: (pid: string, name: string) =>
    del<{ ok: boolean }>(`/portfolios/${encodeURIComponent(pid)}/backtest-presets/${encodeURIComponent(name)}`),

  // Live strategies
  liveStrategies: () =>
    get<{ strategies: import("./types").LiveStrategy[] }>("/live-strategies"),
  startLiveStrategy: (req: {
    strategy: string;
    symbol: string;
    interval: string;
    params?: Record<string, unknown>;
  }) =>
    post<import("./types").LiveStrategy>("/live-strategies", req),
  stopLiveStrategy: (key: string) =>
    del<{ ok: boolean }>(`/live-strategies/${encodeURIComponent(key)}`),
  stopAllLiveStrategies: () =>
    post<{ ok: boolean; stopped: number }>("/live-strategies/stop-all"),

  // Indicators
  indicators: (symbol: string, indicator: string, period: number, interval = "15Min", days = 30) =>
    get<{
      indicator: string;
      series: Array<{ time: number; value: number }>;
    }>(
      `/indicators/${encodeURIComponent(symbol)}?indicator=${indicator}&period=${period}&interval=${interval}&days=${days}`
    ),

  // Settings
  settings: () =>
    get<{ settings: import("./types").Settings }>("/settings"),
  updateSettings: (patch: Partial<import("./types").Settings>) =>
    put<{ settings: import("./types").Settings }>("/settings", patch),
  resetAccount: (startingCash?: number) =>
    post<{ ok: boolean; portfolio: import("./types").Portfolio }>(
      "/settings/reset",
      startingCash != null ? { starting_cash: startingCash } : undefined
    ),
};
