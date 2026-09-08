import { useState } from "react";

interface LiveStrategyModalProps {
  strategy: string;
  symbol: string;
  open: boolean;
  busy?: boolean;
  error?: string;
  defaultInterval?: string;
  onCancel: () => void;
  onStart: (interval: string, params: Record<string, unknown>) => void;
}

const INTERVALS = ["1Min", "5Min", "15Min", "1Hour", "1Day"] as const;
const INTERVAL_FREQ: Record<string, string> = {
  "1Min": "every minute",
  "5Min": "every 5 minutes",
  "15Min": "every 15 minutes",
  "1Hour": "every hour",
  "1Day": "once a day",
};

export default function LiveStrategyModal({
  strategy,
  symbol,
  open,
  busy,
  error,
  defaultInterval = "15Min",
  onCancel,
  onStart,
}: LiveStrategyModalProps) {
  const [interval, setInterval] = useState(defaultInterval);
  const [paramsText, setParamsText] = useState("");

  const parseParams = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const line of paramsText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const raw = trimmed.slice(eq + 1).trim();
      if (!key) continue;
      const lower = raw.toLowerCase();
      if (lower === "true" || lower === "false") out[key] = lower === "true";
      else if (/^-?\d+$/.test(raw)) out[key] = parseInt(raw, 10);
      else if (/^-?\d*\.\d+$/.test(raw)) out[key] = parseFloat(raw);
      else out[key] = raw;
    }
    return out;
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={() => !busy && onCancel()}
    >
      <div
        className="bg-panel border border-[var(--border-strong)] w-[420px] max-w-[95vw] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
          <span className="flex h-2 w-2 animate-pulse rounded-full bg-[var(--up)]" />
          <span className="text-accent text-[11px] font-bold tracking-widest">
            GO LIVE
          </span>
          <span className="text-tertiary text-[9px] font-mono">
            {strategy}.py
          </span>
          <div className="flex-1" />
          <span className="text-primary text-[11px] font-bold tracking-wider">
            {symbol}
          </span>
        </div>

        <div className="space-y-4 px-4 py-4">
          <p className="text-tertiary text-[9px] leading-relaxed">
            Runs on live paper trading — it sees each new {INTERVAL_FREQ[interval] || "bar"}
            as it prints and trades with your real buying power.
          </p>

          {/* Interval */}
          <div>
            <label className="text-tertiary mb-1 block text-[9px] font-semibold uppercase tracking-widest">
              Bar Interval
            </label>
            <div className="flex overflow-hidden border border-[var(--border)]">
              {INTERVALS.map((iv) => (
                <button
                  key={iv}
                  onClick={() => setInterval(iv)}
                  className={`flex-1 border-0 px-1 py-1.5 text-[10px] font-semibold ${
                    interval === iv
                      ? "bg-accent-soft text-accent"
                      : "bg-transparent text-secondary hover:text-primary"
                  }`}
                >
                  {iv.replace("Min", "M").replace("Hour", "H").replace("Day", "D")}
                </button>
              ))}
            </div>
          </div>

          {/* Params */}
          <div>
            <label className="text-tertiary mb-1 block text-[9px] font-semibold uppercase tracking-widest">
              Strategy Params <span className="normal-case">(key=value, one per line)</span>
            </label>
            <textarea
              value={paramsText}
              onChange={(e) => setParamsText(e.target.value)}
              rows={3}
              placeholder={"fast=10\nslow=30"}
              className="w-full border border-[var(--border)] bg-editor px-2 py-1.5 font-mono text-[10px] text-primary outline-none placeholder:text-tertiary"
            />
          </div>

          {error && (
            <div className="border border-[var(--down)] bg-down-soft px-2 py-1.5 text-[9px] font-semibold text-down">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2.5">
          <div className="flex-1" />
          <button
            onClick={onCancel}
            disabled={busy}
            className="border border-[var(--border)] bg-transparent px-3 py-1.5 text-[10px] text-secondary disabled:opacity-40"
          >
            CANCEL
          </button>
          <button
            onClick={() => onStart(interval, parseParams())}
            disabled={busy}
            className={`border px-4 py-1.5 text-[11px] font-bold ${
              busy
                ? "border-[var(--border)] text-secondary"
                : "border-[var(--up)] text-[var(--up)] hover:bg-up-soft"
            } disabled:opacity-40`}
          >
            {busy ? "STARTING..." : `START ${strategy.toUpperCase()} LIVE`}
          </button>
        </div>
      </div>
    </div>
  );
}