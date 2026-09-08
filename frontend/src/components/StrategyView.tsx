import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { BacktestResult, LiveStrategy, Strategy } from "../lib/types";

interface StrategyViewProps {
  refreshPortfolio: () => void;
  onBacktestComplete?: (result: BacktestResult, label?: string) => void;
  portfolioId?: string | null;
  runSignal?: number;
  liveStrategies?: LiveStrategy[];
  onStopLiveStrategy?: (key: string) => void;
}

interface BacktestConfig {
  symbol: string;
  interval: string;
  days: number;
  params: Record<string, unknown>;
  startingCash?: number;
}

const INTERVALS = ["1Min", "5Min", "15Min", "1Hour", "1Day"] as const;
const RANGE_PRESETS = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
] as const;

export default function StrategyView({
  refreshPortfolio,
  onBacktestComplete,
  portfolioId,
  runSignal,
  liveStrategies = [],
  onStopLiveStrategy,
}: StrategyViewProps) {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selected, setSelected] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState("");

  const [btSymbol, setBtSymbol] = useState("AAPL");
  const [btDays, setBtDays] = useState(60);
  const [btInterval, setBtInterval] = useState("1Day");
  const [btParamsText, setBtParamsText] = useState("");
  const [btRunning, setBtRunning] = useState(false);
  const [btName, setBtName] = useState("");
  const [presets, setPresets] = useState<Record<string, BacktestConfig>>({});
  const [presetName, setPresetName] = useState("");
  const [runnerOpen, setRunnerOpen] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadContent, setUploadContent] = useState("");
  const [showUpload, setShowUpload] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await api.strategies();
      setStrategies(d.strategies);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Open the runner when App signals a "run new" from the bottom panel.
  useEffect(() => {
    if (runSignal && runSignal > 0) setRunnerOpen(true);
  }, [runSignal]);

  const select = async (name: string) => {
    setSelected(name);
    setError("");
    try {
      const d = await api.strategySource(name);
      setSource(d.source);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  };

  const handleFile = (file: File) => {
    const name = file.name.replace(/\.py$/i, "");
    const reader = new FileReader();
    reader.onload = () => {
      setUploadName(name);
      setUploadContent(String(reader.result ?? ""));
      setShowUpload(true);
      setError("");
    };
    reader.readAsText(file);
  };

  const confirmUpload = async () => {
    const name = uploadName.trim();
    if (!name) { setError("Enter a strategy name"); return; }
    setUploading(true);
    setError("");
    try {
      await api.uploadStrategy(name, uploadContent);
      await refresh();
      setShowUpload(false);
      setUploadName("");
      setUploadContent("");
      await select(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const deleteStrategy = async (name: string) => {
    try {
      await api.deleteStrategy(name);
      if (selected === name) {
        setSelected("");
        setSource("");
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
    setConfirmDelete(null);
  };

  const parseParams = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const line of btParamsText.split("\n")) {
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

  const runBacktest = async () => {
    if (!selected) { setError("Select a strategy to backtest"); return; }
    setBtRunning(true);
    setError("");
    try {
      await api.refreshStrategy(selected).catch(() => {});
      const res = await api.runStrategy(selected, {
        symbol: btSymbol, interval: btInterval, days: btDays,
        params: parseParams(),
      });
      refreshPortfolio();
      onBacktestComplete?.(res, btName.trim() || undefined);
      setBtName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backtest failed");
    } finally {
      setBtRunning(false);
    }
  };

  const loadPresets = useCallback(async () => {
    if (!portfolioId) { setPresets({}); return; }
    try {
      const d = await api.presets(portfolioId);
      setPresets((d.presets || {}) as unknown as Record<string, BacktestConfig>);
    } catch { /* ignore */ }
  }, [portfolioId]);

  useEffect(() => { loadPresets(); }, [loadPresets]);

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name || !portfolioId) return;
    try {
      await api.savePreset(portfolioId, name, {
        symbol: btSymbol, interval: btInterval, days: btDays, params: parseParams(),
      });
      setPresetName("");
      await loadPresets();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save preset failed");
    }
  };

  const applyPreset = async (name: string) => {
    const cfg = presets[name];
    if (!cfg) return;
    setBtSymbol(cfg.symbol || "AAPL");
    setBtInterval(cfg.interval || "1Day");
    setBtDays(cfg.days || 30);
    setBtParamsText(
      Object.entries(cfg.params || {}).map(([k, v]) => `${k}=${v}`).join("\n")
    );
  };

  const removePreset = async (name: string) => {
    if (!portfolioId) return;
    try { await api.deletePreset(portfolioId, name); await loadPresets(); }
    catch { /* ignore */ }
  };

  const sorted = [...strategies].sort((a, b) => a.name.localeCompare(b.name));
  const fmtSize = (n?: number) => {
    if (n == null) return "";
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
  };
  const activePresetCount = Object.keys(presets).length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-1 border-b border-[var(--border)] bg-panel px-2 py-1">
        <span className="text-secondary text-[9px] font-semibold uppercase tracking-widest">
          Strategies
        </span>
        <div className="flex-1" />
        <button
          onClick={() => { if (selected) setRunnerOpen(true); }}
          disabled={!selected}
          className="border border-[var(--accent)] bg-transparent px-2 py-0.5 text-[9px] font-semibold text-[var(--accent)] hover:bg-accent-soft disabled:opacity-40"
          title={selected ? `Backtest ${selected}` : "Select a strategy first"}
        >
          BACKTEST
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="border border-[var(--accent)] bg-transparent px-2 py-0.5 text-[9px] font-semibold text-[var(--accent)] hover:bg-accent-soft disabled:opacity-40"
        >
          {uploading ? "..." : "UPLOAD"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".py"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {/* Upload preview */}
      {showUpload && (
        <div className="border-b border-[var(--accent)] bg-panel2 p-2">
          <div className="mb-1 flex items-center gap-1">
            <input
              value={uploadName}
              onChange={(e) => setUploadName(e.target.value)}
              placeholder="strategy_name"
              className="w-full border border-[var(--border)] bg-editor px-1.5 py-0.5 text-[10px] font-semibold text-primary outline-none"
            />
          </div>
          <div className="mb-2 text-tertiary text-[8px]">
            {uploadContent.split("\n").length} lines · {fmtSize(uploadContent.length)}
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setShowUpload(false)}
              className="flex-1 border border-[var(--border)] bg-transparent py-1 text-[9px] text-secondary"
            >
              CANCEL
            </button>
            <button
              onClick={confirmUpload}
              disabled={uploading || !uploadName.trim()}
              className="flex-1 border border-[var(--accent)] bg-transparent py-1 text-[9px] font-bold text-[var(--accent)] disabled:opacity-40"
            >
              {uploading ? "..." : "ADD"}
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="border-b border-[var(--down)] bg-down-soft px-2 py-1 text-[9px] text-down">
          {error}
        </div>
      )}

      {/* File list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sorted.length === 0 && (
          <p className="text-tertiary px-2 py-4 text-center text-[10px]">No strategies</p>
        )}
        {sorted.map((s) => {
          const live = liveStrategies.filter((l) => l.strategy === s.name);
          return (
            <div
              key={s.name}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("application/x-dv-strategy", s.name);
                e.dataTransfer.setData("text/plain", s.name);
              }}
              className={`group flex cursor-grab items-center border-b border-[var(--border)] px-2 py-2 active:cursor-grabbing ${
                selected === s.name ? "bg-accent-soft" : "hover:bg-panel2"
              }`}
              onClick={() => select(s.name)}
              title="Select · drag onto a watchlist symbol to run live"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {live.length > 0 && (
                    <span
                      className="flex h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--up)]"
                      title={`Live on ${live.map((l) => l.symbol).join(", ")}`}
                    />
                  )}
                  <span className={`truncate text-[10px] font-semibold ${
                    selected === s.name ? "text-accent" : "text-primary"
                  }`}>
                    {s.name}.py
                  </span>
                  {live.length > 0 && (
                    <span className="shrink-0 text-[8px] font-bold uppercase tracking-widest text-accent">
                      LIVE {live.map((l) => l.symbol).join(", ")}
                    </span>
                  )}
                </div>
                <div className="text-tertiary mt-0.5 flex gap-2 text-[8px]">
                  <span>{fmtSize(s.size)}</span>
                  <span>{new Date(s.modified).toLocaleDateString()}</span>
                  <span className="text-accent hidden group-hover:inline">
                    drag to symbol →
                  </span>
                </div>
              </div>
              {live.length > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    live.forEach((l) => onStopLiveStrategy?.(l.key));
                  }}
                  className="border border-[var(--down)] bg-transparent px-1.5 py-0.5 text-[8px] font-bold text-[var(--down)] hover:bg-down-soft"
                  title={`Stop ${s.name} everywhere`}
                >
                  STOP
                </button>
              )}
              {s.name !== "sma_crossover" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirmDelete === s.name) deleteStrategy(s.name);
                    else {
                      setConfirmDelete(s.name);
                      setTimeout(() => setConfirmDelete(null), 3000);
                    }
                  }}
                  className={`ml-1 hidden shrink-0 border-none bg-transparent px-1 py-0 text-[9px] uppercase group-hover:block ${
                    confirmDelete === s.name ? "text-down" : "text-tertiary hover:text-down"
                  }`}
                  title={confirmDelete === s.name ? "Click again to confirm" : "Delete"}
                >
                  {confirmDelete === s.name ? "DEL?" : "x"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Source viewer */}
      {selected && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--border)]">
          <div className="flex items-center gap-1 border-b border-[var(--border)] bg-panel px-2 py-1">
            <span className="text-primary text-[10px] font-semibold">{selected}.py</span>
            <span className="text-tertiary text-[8px]">READ-ONLY</span>
            <div className="flex-1" />
            <button
              onClick={() => setRunnerOpen(true)}
              className="border border-[var(--accent)] bg-transparent px-2 py-0.5 text-[9px] font-bold text-accent hover:bg-accent-soft"
            >
              RUN BACKTEST
            </button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto bg-editor p-2 font-mono text-[9px] leading-relaxed text-primary">
            {source}
          </pre>
        </div>
      )}

      {/* Backtest Runner modal */}
      {runnerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="bg-panel border border-[var(--border-strong)] flex max-h-[92vh] w-[640px] max-w-[95vw] flex-col shadow-xl">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
              <span className="text-primary text-[11px] font-bold tracking-widest">
                BACKTEST RUNNER
              </span>
              {selected ? (
                <span className="text-tertiary text-[9px] font-mono">{selected}.py</span>
              ) : (
                <span className="text-secondary text-[9px]">no strategy selected</span>
              )}
              {btRunning && (
                <span className="text-accent text-[9px] font-bold tracking-widest animate-pulse">
                  RUNNING...
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => setRunnerOpen(false)}
                className="text-secondary hover:text-primary border-0 bg-transparent px-1 py-0 text-[12px]"
                title="Close"
              >
                x
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {/* Run name (optional label for the saved run) */}
              <div className="mb-4">
                <label className="text-tertiary mb-1 block text-[9px] font-semibold uppercase tracking-widest">
                  Run Name <span className="normal-case">(optional)</span>
                </label>
                <input
                  value={btName}
                  onChange={(e) => setBtName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") runBacktest(); }}
                  placeholder="e.g. first daily SMA cross"
                  className="w-full border border-[var(--border)] bg-editor px-2 py-1.5 text-[12px] text-primary outline-none placeholder:text-tertiary"
                />
                <span className="text-tertiary mt-0.5 block text-[8px]">
                  Shown in the Backtest tab instead of a hash. Leave blank to auto-name.
                </span>
              </div>

              {/* Symbol + lookback */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-tertiary mb-1 block text-[9px] font-semibold uppercase tracking-widest">
                    Symbol
                  </label>
                  <input
                    value={btSymbol}
                    onChange={(e) => setBtSymbol(e.target.value.toUpperCase())}
                    placeholder="TICKER"
                    className="w-full border border-[var(--border)] bg-editor px-2 py-1.5 text-[12px] font-bold text-primary outline-none"
                  />
                  <label className="text-tertiary mt-3 mb-1 block text-[9px] font-semibold uppercase tracking-widest">
                    Lookback
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="flex shrink-0 overflow-hidden border border-[var(--border)]">
                      {RANGE_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          onClick={() => setBtDays(p.days)}
                          className={`border-0 px-2 py-1.5 text-[10px] font-semibold ${
                            btDays === p.days
                              ? "bg-accent-soft text-accent"
                              : "bg-transparent text-secondary hover:text-primary"
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      value={btDays}
                      min="1"
                      onChange={(e) => setBtDays(parseInt(e.target.value, 10) || 30)}
                      className="w-20 border border-[var(--border)] bg-editor px-2 py-1.5 text-[11px] font-mono text-primary outline-none"
                    />
                    <span className="text-tertiary text-[9px]">days</span>
                  </div>
                </div>

                <div>
                  <label className="text-tertiary mb-1 block text-[9px] font-semibold uppercase tracking-widest">
                    Interval
                  </label>
                  <div className="flex overflow-hidden border border-[var(--border)]">
                    {INTERVALS.map((iv) => (
                      <button
                        key={iv}
                        onClick={() => setBtInterval(iv)}
                        className={`flex-1 border-0 px-1 py-1.5 text-[10px] font-semibold ${
                          btInterval === iv
                            ? "bg-accent-soft text-accent"
                            : "bg-transparent text-secondary hover:text-primary"
                        }`}
                      >
                        {iv.replace("Min", "M").replace("Hour", "H").replace("Day", "D")}
                      </button>
                    ))}
                  </div>
                  <label className="text-tertiary mt-3 mb-1 block text-[9px] font-semibold uppercase tracking-widest">
                    Presets {activePresetCount > 0 && `(${activePresetCount})`}
                  </label>
                  <div className="flex items-center gap-1">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-y-auto">
                      {activePresetCount === 0 && (
                        <span className="text-tertiary text-[9px]">none saved</span>
                      )}
                      {Object.keys(presets).map((name) => (
                        <span
                          key={name}
                          className="flex shrink-0 items-center gap-1 border border-[var(--border)] px-1.5 py-0.5 text-[9px] text-secondary"
                          title={`Apply ${name}`}
                        >
                          <button
                            onClick={() => applyPreset(name)}
                            className="border-0 bg-transparent text-secondary hover:text-primary"
                          >
                            {name}
                          </button>
                          <button
                            onClick={() => removePreset(name)}
                            className="border-0 bg-transparent px-0 text-tertiary hover:text-down"
                          >
                            x
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    <input
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") savePreset(); }}
                      placeholder="save config as..."
                      className="min-w-0 flex-1 border border-[var(--border)] bg-editor px-2 py-1 text-[9px] text-primary outline-none placeholder:text-tertiary"
                    />
                    <button
                      onClick={savePreset}
                      disabled={!presetName.trim() || !portfolioId}
                      className="shrink-0 border border-[var(--border)] px-2 py-1 text-[9px] text-secondary hover:text-primary disabled:opacity-40"
                    >
                      SAVE
                    </button>
                  </div>
                </div>
              </div>

              {/* Strategy params */}
              <div className="mt-4">
                <label className="text-tertiary mb-1 block text-[9px] font-semibold uppercase tracking-widest">
                  Strategy Params <span className="normal-case">(key=value, one per line)</span>
                </label>
                <textarea
                  value={btParamsText}
                  onChange={(e) => setBtParamsText(e.target.value)}
                  rows={3}
                  placeholder={"fast=10\nslow=30"}
                  className="w-full border border-[var(--border)] bg-editor px-2 py-1.5 font-mono text-[10px] text-primary outline-none placeholder:text-tertiary"
                />
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-4 py-2.5">
              <span className="text-tertiary text-[9px] min-w-0 truncate">
                {selected
                  ? `RUN ${selected}.py ON ${btSymbol} / ${btInterval} / ${btDays}d`
                  : "Select a strategy from the list to run a backtest"}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => setRunnerOpen(false)}
                className="border border-[var(--border)] bg-transparent px-3 py-1.5 text-[10px] text-secondary"
              >
                CLOSE
              </button>
              <button
                onClick={runBacktest}
                disabled={btRunning || !selected}
                className={`border px-4 py-1.5 text-[11px] font-bold ${
                  btRunning
                    ? "border-[var(--border)] text-secondary"
                    : selected
                      ? "border-[var(--accent)] text-[var(--accent)] hover:bg-accent-soft"
                      : "border-[var(--border)] text-secondary"
                } disabled:opacity-40`}
              >
                {btRunning ? "RUNNING..." : "RUN BACKTEST"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
