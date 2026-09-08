import { useState } from "react";
import type { LiveStrategy } from "../lib/types";

interface LiveStrategiesBarProps {
  strategies: LiveStrategy[];
  onStop: (key: string) => void;
  onStopAll: () => void;
}

const fmtTime = (iso: string | null) => {
  if (!iso) return "waiting for first bar";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};

export default function LiveStrategiesBar({ strategies, onStop, onStopAll }: LiveStrategiesBarProps) {
  const [showLogs, setShowLogs] = useState<string | null>(null);
  if (strategies.length === 0) return null;

  return (
    <div className="border-0 border-b border-[var(--border)] bg-accent-soft/30">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <span className="flex h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--up)]" />
        <span className="text-accent text-[9px] font-bold uppercase tracking-[0.12em]">
          Live Strategies ({strategies.length})
        </span>
        <div className="flex-1" />
        {strategies.length > 1 && (
          <button
            onClick={onStopAll}
            className="border border-[var(--down)] bg-transparent px-1.5 py-0.5 text-[8px] font-bold text-[var(--down)] hover:bg-down-soft"
            title="Stop all live strategies on this symbol"
          >
            STOP ALL
          </button>
        )}
      </div>

      <div className="space-y-0.5 px-3 pb-2">
        {strategies.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5 border border-[var(--border)] bg-panel px-1.5 py-1">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[9px] font-semibold text-primary">
                {s.strategy}.py
                <span className="text-tertiary ml-1 font-normal">
                  · {s.interval.replace("Min", "M").replace("Hour", "H").replace("Day", "D")}
                </span>
              </span>
              <span className="text-tertiary block text-[8px]">
                bars processed: {s.bars_processed} · last: {fmtTime(s.last_bar_at)}
              </span>
            </span>
            <button
              onClick={() => setShowLogs(showLogs === s.key ? null : s.key)}
              className="border border-[var(--border)] bg-transparent px-1 py-0.5 text-[8px] font-semibold text-secondary hover:text-primary"
              title={s.logs.length ? "Show logs" : "No logs yet"}
            >
              LOGS {s.logs.length > 0 ? `(${s.logs.length})` : ""}
            </button>
            <button
              onClick={() => onStop(s.key)}
              className="border border-[var(--down)] bg-transparent px-1 py-0.5 text-[8px] font-bold text-[var(--down)] hover:bg-down-soft"
              title={`Stop ${s.strategy} on this symbol`}
            >
              STOP
            </button>
          </div>
        ))}

        {/* log expansion — IIFE because this is render, not a function body */}
        {showLogs != null && (() => {
          const s = strategies.find((x) => x.key === showLogs);
          if (!s) return null;
          return (
            <div className="border border-[var(--border)] bg-editor p-2">
              <div className="text-tertiary mb-1 text-[8px] font-semibold uppercase tracking-widest">
                {s.strategy}.py logs
              </div>
              {s.logs.length === 0 ? (
                <p className="text-tertiary text-[9px]">No signals yet — waiting for the next bar.</p>
              ) : (
                <pre className="max-h-24 overflow-y-auto font-mono text-[9px] leading-relaxed text-primary whitespace-pre-wrap">
                  {s.logs.join("\n")}
                </pre>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}