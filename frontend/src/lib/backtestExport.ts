import type { BacktestResult } from "./types";

function escapeCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(escapeCell).join(",")).join("\n");
}

function baseName(result: BacktestResult): string {
  const sym = result.symbol.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  return `backtest-${sym}-${result.interval}-${result.days}d`;
}

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface ExportPayload {
  filename: string;
  content: string;
  mime: string;
  label: string;
}

export function buildTradesCsv(result: BacktestResult): ExportPayload {
  const rows: unknown[][] = [[
    "time", "symbol", "side", "qty", "price", "value",
  ]];
  for (const t of result.portfolio.trades) {
    rows.push([t.timestamp, t.symbol, t.side, t.qty, t.price, +(t.qty * t.price).toFixed(2)]);
  }
  return {
    filename: `${baseName(result)}-trades.csv`,
    content: toCsv(rows),
    mime: "text/csv",
    label: "CSV (trades)",
  };
}

export function buildEquityCsv(result: BacktestResult): ExportPayload {
  const rows: unknown[][] = [["time", "equity", "close_price"]];
  for (const e of result.equity) {
    rows.push([e.t, e.v, e.c]);
  }
  return {
    filename: `${baseName(result)}-equity.csv`,
    content: toCsv(rows),
    mime: "text/csv",
    label: "CSV (equity curve)",
  };
}

export function buildJsonExport(result: BacktestResult): ExportPayload {
  const payload = {
    symbol: result.symbol,
    interval: result.interval,
    days: result.days,
    start: result.start,
    end: result.end,
    bars_processed: result.bars_processed,
    runtime_ms: result.runtime_ms,
    metrics: result.metrics,
    portfolio: {
      cash: result.portfolio.cash,
      invested: result.portfolio.invested,
      total_value: result.portfolio.total_value,
      realized_pnl: result.portfolio.realized_pnl,
      unrealized_pnl: result.portfolio.unrealized_pnl,
      num_trades: result.portfolio.num_trades,
      trades: result.portfolio.trades,
    },
    equity: result.equity,
    logs: result.logs,
  };
  return {
    filename: `${baseName(result)}.json`,
    content: JSON.stringify(payload, null, 2),
    mime: "application/json",
    label: "JSON (full run)",
  };
}

export function downloadExport(payload: ExportPayload): void {
  downloadFile(payload.filename, payload.content, payload.mime);
}

export function buildExports(result: BacktestResult): Record<string, ExportPayload> {
  return {
    json: buildJsonExport(result),
    trades: buildTradesCsv(result),
    equity: buildEquityCsv(result),
  };
}