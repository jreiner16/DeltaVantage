export interface BarData {
  time: string;
  time_ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface JobState<T = unknown> {
  job_id: string;
  kind: "backtest" | "monte_carlo";
  status: "pending" | "running" | "done" | "error";
  stage: string;
  progress: number;
  error: string | null;
  result: T | null;
  created_at: number;
}

export interface Position {
  symbol: string;
  qty: number;
  avg_entry_price: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
}

export interface Trade {
  order_id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  timestamp: string;
}

export interface Portfolio {
  cash: number;
  invested: number;
  total_value: number;
  unrealized_pnl: number;
  realized_pnl: number;
  num_positions: number;
  num_trades: number;
  buying_power: number;
  short_buying_power: number;
  positions: Record<string, Position>;
  trades: Trade[];
}

export interface Order {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  order_type: "market" | "limit" | "stop";
  qty: number;
  limit_price: number | null;
  stop_price: number | null;
  status: "pending" | "filled" | "cancelled" | "rejected";
  created_at: string | null;
  filled_at: string | null;
  fill_price: number | null;
}

export interface Strategy {
  name: string;
  path: string;
  modified: string;
  size?: number;
}

export interface LiveStrategy {
  key: string;
  strategy: string;
  symbol: string;
  interval: string;
  params: Record<string, unknown>;
  started_at: string;
  last_bar_at: string | null;
  bars_processed: number;
  logs: string[];
}

export interface BacktestResult {
  symbol: string;
  interval: string;
  days: number;
  portfolio: Portfolio;
  order_count: number;
  trade_count: number;
  start: string;
  end: string;
  equity: { t: string; v: number; c: number }[];
  logs: string[];
  runtime_ms: number;
  bars_processed: number;
  metrics: BacktestMetrics;
}

export interface MonteCarloStats {
  start_value: number;
  final_mean: number;
  final_median: number;
  final_std: number;
  final_best: number;
  final_worst: number;
  prob_profit: number;
  prob_loss: number;
  expected_return_pct: number;
  median_return_pct: number;
  p5_return_pct: number;
  p25_return_pct: number;
  p75_return_pct: number;
  p95_return_pct: number;
  avg_max_drawdown_pct: number;
  median_max_drawdown_pct: number;
  worst_max_drawdown_pct: number;
  actual_return_pct: number;
  actual_max_drawdown_pct: number;
}

export interface MonteCarloPercentiles {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface MonteCarloResult {
  symbol: string;
  interval: string;
  days: number;
  sims: number;
  seed: number | null;
  block: number;
  bars: number;
  failed_sims: number;
  start: string;
  end: string;
  runtime_ms: number;
  stats: MonteCarloStats;
  percentiles: MonteCarloPercentiles;
  fan: { t: string[]; p10: number[]; p25: number[]; p50: number[]; p75: number[]; p90: number[] };
  actual: { t: string[]; v: number[] };
}

export interface BacktestMetrics {
  total_return_pct: number;
  annualized_return_pct: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  max_drawdown_pct: number;
  max_drawdown_duration: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  avg_trade: number;
  best_trade: number;
  worst_trade: number;
  profit_factor: number | null;
  exposure_pct: number;
  net_profit: number;
  starting_value: number;
  ending_value: number;
}

export interface Settings {
  slippage: number;
  share_increment: number;
  min_order_qty: number;
  max_order_qty: number;
  starting_cash: number;
  theme: "light" | "dark" | "mid";
  default_interval: string;
  default_lookback_days: number;
}

export interface Quote {
  last: number;
  prev_close: number;
  change: number;
  change_pct: number;
  spark: number[];
}

export interface PerfPoint {
  t: number;
  equity: number;
  cash: number;
}

export interface MarketStatus {
  exchange: string;
  status: "open" | "closed" | "pre" | "post";
  reason: string;
  next_open: string;
  time: string;
  local_time: string;
  crypto: string;
}

export interface PortfolioEntry {
  id: string;
  name: string;
  created?: string;
  last_opened?: string;
  starting_cash: number;
  equity?: number;
  realized_pnl?: number;
  equity_curve?: number[];
  current: boolean;
}

export interface PerformanceResponse {
  points: PerfPoint[];
  current_equity: number;
  current_cash: number;
}

export interface BacktestSummary {
  id: string;
  label: string;
  strategy: string;
  symbol: string;
  interval: string;
  days: number;
  ts: string;
  total_return_pct: number | null;
  sharpe_ratio: number | null;
  win_rate: number | null;
  trade_count: number;
}

export interface SavableBacktest {
  id: string;
  label?: string;
  strategy: string;
  symbol: string;
  interval: string;
  days: number;
  params: Record<string, unknown>;
  ts: string;
  portfolio: Record<string, never>;
  trade_count: number;
  equity: { t: string; v: number; c: number }[];
  metrics: BacktestMetrics;
  logs: string[];
  runtime_ms: number;
  bars_processed: number;
}
