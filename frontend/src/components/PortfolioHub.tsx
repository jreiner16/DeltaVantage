import { useRef, useState } from "react";
import type { PortfolioEntry } from "../lib/types";

interface PortfolioHubProps {
  portfolios: PortfolioEntry[];
  onOpen: (id: string) => Promise<string | null>;
  onCreate: (name: string, opts?: { starting_cash?: number; slippage?: number; share_increment?: number; min_order_qty?: number; max_order_qty?: number }) => Promise<string | null>;
  onRename: (id: string, name: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
  onExport: (id: string) => Promise<Record<string, unknown> | null>;
  onImport: (payload: Record<string, unknown>, name?: string) => Promise<string | null>;
}

function fmtMoney(n?: number): string {
  if (n == null) return "--";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function EquityThumb({ points }: { points?: number[] }) {
  const W = 200;
  const H = 60;
  const vals = points && points.length > 0 ? points : [0];
  const first = vals[0];
  const last = vals[vals.length - 1];
  const up = last >= first;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 3;
  const stepX = W / Math.max(vals.length - 1, 1);
  const line = vals.map((v, i) => {
    const x = i * stepX;
    const y = H - pad - ((v - min) / range) * (H - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `0,${H} ${line} ${W},${H}`;
  const color = vals.length === 1 ? "var(--text-3)" : up ? "var(--up)" : "var(--down)";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
      <polygon points={area} fill={color} opacity="0.12" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.75" />
    </svg>
  );
}

export default function PortfolioHub({
  portfolios,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onExport,
  onImport,
}: PortfolioHubProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [cash, setCash] = useState(100000);
  const [slippage, setSlippage] = useState("0.1");
  const [shareIncrement, setShareIncrement] = useState("1");
  const [minQty, setMinQty] = useState("1");
  const [maxQty, setMaxQty] = useState("1000000");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sorted = [...portfolios].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return (b.last_opened || "").localeCompare(a.last_opened || "");
  });

  const totalEquity = portfolios.reduce((s, p) => s + (p.equity ?? p.starting_cash ?? 0), 0);
  const totalPnl = portfolios.reduce((s, p) => s + (p.realized_pnl ?? 0), 0);

  const handleOpen = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setError("");
    const err = await onOpen(id);
    if (err) setError(err);
    setBusyId(null);
  };

  const resetCreateForm = () => {
    setName("");
    setCash(100000);
    setSlippage("0.1");
    setShareIncrement("1");
    setMinQty("1");
    setMaxQty("1000000");
  };

  const handleCreate = async () => {
    if (!name.trim()) { setError("Enter a portfolio name"); return; }
    setCreating(true);
    setError("");
    const err = await onCreate(name.trim(), {
      starting_cash: cash > 0 ? cash : undefined,
      slippage: (parseFloat(slippage) || 0) / 100,
      share_increment: parseFloat(shareIncrement) || 1,
      min_order_qty: parseInt(minQty, 10) || 1,
      max_order_qty: parseInt(maxQty, 10) || 1000000,
    });
    if (err) setError(err);
    setCreating(false);
    setShowCreate(false);
    resetCreateForm();
  };

  const handleRename = async (id: string) => {
    if (!renameVal.trim()) { setRenaming(null); return; }
    setError("");
    const err = await onRename(id, renameVal.trim());
    if (err) setError(err);
    setRenaming(null);
    setRenameVal("");
  };

  const handleExport = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const payload = await onExport(id);
    if (!payload) { setError("Export failed"); return; }
    const exportName = (payload.name as string) || id;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}.dvport`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File) => {
    setError("");
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (!payload || payload.format !== "delta-vantage-portfolio") {
        setError("Not a valid portfolio file");
        return;
      }
      const err = await onImport(payload);
      if (err) setError(err);
    } catch {
      setError("Could not read that file");
    }
  };

  const needsCreateHint = sorted.length === 0;

  return (
    <div className="flex h-full w-full flex-col bg-app">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4">
        <span className="text-primary text-[11px] font-bold tracking-[0.3em]">PORTFOLIOS</span>
        <span className="text-tertiary text-[9px] tracking-widest">
          {portfolios.length} WORKSPACE{portfolios.length === 1 ? "" : "S"}
        </span>
        <div className="flex-1" />
        <span className="text-tertiary text-[9px] hidden items-center gap-1 sm:flex">
          drop a .dvport to import
        </span>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="border border-[var(--border)] bg-transparent px-2.5 py-1 text-[10px] font-bold text-secondary hover:text-primary"
        >
          IMPORT
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json,.dvport"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImportFile(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => setShowCreate(true)}
          className="border border-[var(--accent)] bg-transparent px-2.5 py-1 text-[10px] font-bold text-accent hover:bg-accent-soft"
        >
          + CREATE PORTFOLIO
        </button>
      </div>

      {/* Aggregate stats */}
      {portfolios.length > 0 && (
        <div className="flex shrink-0 items-center gap-5 border-b border-[var(--border)] px-4 py-1.5">
          <span className="text-secondary text-[9px]">
            TOTAL EQ <span className="font-mono text-primary font-bold">${fmtMoney(totalEquity)}</span>
          </span>
          <span className="text-secondary text-[9px]">
            TOTAL P&L <span className={`font-mono font-bold ${totalPnl >= 0 ? "text-up" : "text-down"}`}>
              {totalPnl >= 0 ? "+" : ""}${fmtMoney(totalPnl)}
            </span>
          </span>
          <span className="text-secondary text-[9px]">
            WORKSPACES <span className="font-mono text-tertiary">{portfolios.length}</span>
          </span>
        </div>
      )}

      {error && (
        <div className="border-b border-[var(--down)] bg-down-soft px-4 py-1 text-[10px] text-down">
          {error}
        </div>
      )}

      {/* Grid body with drag-and-drop import area */}
      <div
        className="min-h-0 flex-1 overflow-y-auto p-4"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleImportFile(f);
        }}
      >
        {needsCreateHint && (
          <div className="text-tertiary flex h-full flex-col items-center justify-center gap-3 text-[11px]">
            <div className="text-primary text-[13px] font-bold tracking-wider">DELTA VANTAGE</div>
            <div className="max-w-xs text-center text-[10px] leading-relaxed">
              Create a workspace to start trading with simulated capital.
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-px w-8 bg-[var(--border)]" />
              <span className="text-[8px] tracking-widest">GET STARTED</span>
              <div className="h-px w-8 bg-[var(--border)]" />
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="border border-[var(--accent)] bg-transparent px-4 py-1.5 text-[10px] font-bold text-accent hover:bg-accent-soft"
            >
              + CREATE PORTFOLIO
            </button>
            <span className="text-[9px]">or drag &amp; drop a .dvport file</span>
          </div>
        )}

        <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${dragOver ? "brightness-110" : ""}`}>
          {sorted.map((p) => (
            <div
              key={p.id}
              onDoubleClick={() => handleOpen(p.id)}
              title="Double-click to open"
              className={`group flex cursor-pointer flex-col border transition-colors ${
                p.current
                  ? "border-[var(--accent)] bg-accent-soft"
                  : "border-[var(--border)] bg-panel hover:bg-panel2"
              }`}
            >
              {/* Thumbnail */}
              <div className="h-20 shrink-0 border-b border-[var(--border)] relative">
                <EquityThumb points={p.equity_curve} />
                {p.current && (
                  <span className="bg-accent absolute top-1.5 right-1.5 rounded-sm px-1.5 py-0.5 text-[8px] font-bold tracking-widest" style={{ color: "var(--bg)" }}>
                    CURRENT
                  </span>
                )}
              </div>

              {/* Card body */}
              <div className="flex min-w-0 flex-1 flex-col p-3">
                <div className="flex items-start gap-2">
                  {renaming === p.id ? (
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      <input
                        autoFocus
                        value={renameVal}
                        onChange={(e) => setRenameVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleRename(p.id); if (e.key === "Escape") setRenaming(null); }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        className="w-full border border-[var(--border)] bg-editor px-1.5 py-0.5 text-[11px] text-primary outline-none"
                      />
                      <button onClick={() => handleRename(p.id)} className="border border-[var(--accent)] px-1.5 py-0.5 text-[9px] font-bold text-accent">OK</button>
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div className="text-primary truncate text-[12px] font-bold">{p.name}</div>
                      <div className="text-tertiary mt-0.5 text-[9px] font-mono">
                        EQ <span className="text-primary font-bold">${fmtMoney(p.equity ?? p.starting_cash)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[9px] font-mono">
                        <span className={(p.realized_pnl ?? 0) >= 0 ? "text-up" : "text-down"}>
                          P&L {(p.realized_pnl ?? 0) >= 0 ? "+" : ""}${fmtMoney(p.realized_pnl)}
                        </span>
                        <span className="text-quaternary">|</span>
                        <span className="text-tertiary">CASH ${fmtMoney(p.starting_cash)}</span>
                      </div>
                      <div className="text-tertiary mt-0.5 text-[8px] font-mono">
                        {p.last_opened ? `OPENED ${new Date(p.last_opened).toLocaleDateString()}` : "\u00A0"}
                      </div>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="mt-3 flex shrink-0 items-center gap-1 border-t border-[var(--border)] pt-2">
                  <button
                    onClick={() => handleOpen(p.id)}
                    className={`border px-2 py-0.5 text-[9px] font-bold ${
                      p.current
                        ? "border-[var(--accent)] text-accent bg-accent-soft"
                        : "border-[var(--border)] bg-transparent text-secondary hover:text-primary"
                    }`}
                  >
                    {p.current ? "ACTIVE" : "OPEN"}
                  </button>
                  <button
                    onClick={(e) => handleExport(e, p.id)}
                    className="border border-[var(--border)] bg-transparent px-2 py-0.5 text-[9px] font-semibold text-secondary hover:text-primary"
                    title="Export to file"
                  >
                    EXPORT
                  </button>
                  <button
                    onClick={() => { setRenaming(p.id); setRenameVal(p.name); }}
                    className="text-secondary hover:text-primary border-0 bg-transparent px-2 py-0.5 text-[9px] font-semibold"
                    title="Rename"
                  >
                    RENAME
                  </button>
                  <div className="flex-1" />
                  {!p.current && (
                    <button
                      onClick={() => {
                        if (confirmDelete === p.id) {
                          onDelete(p.id);
                          setConfirmDelete(null);
                        } else {
                          setConfirmDelete(p.id);
                          setTimeout(() => setConfirmDelete(null), 3000);
                        }
                      }}
                      className={`border-0 bg-transparent px-2 py-0.5 text-[9px] font-semibold ${
                        confirmDelete === p.id ? "text-down" : "text-tertiary hover:text-down"
                      }`}
                      title={confirmDelete === p.id ? "Click again to confirm" : "Delete"}
                    >
                      {confirmDelete === p.id ? "CONFIRM" : "DEL"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowCreate(false)}>
          <div
            className="bg-panel border border-[var(--border-strong)] w-[420px] max-w-[95vw] max-h-[85vh] flex flex-col shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2">
              <span className="text-primary text-[11px] font-bold tracking-widest">NEW PORTFOLIO</span>
              <button onClick={() => setShowCreate(false)} className="text-tertiary hover:text-primary border-0 bg-transparent text-[10px] font-bold">X</button>
            </div>

            {/* Modal body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-4">
              {/* Identity */}
              <div>
                <label className="text-tertiary mb-0.5 block text-[9px] font-semibold uppercase tracking-wider">Name</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowCreate(false); }}
                  placeholder="e.g. Aggressive Growth"
                  className="w-full border border-[var(--border)] bg-editor px-2 py-1.5 text-[11px] text-primary outline-none placeholder:text-tertiary"
                />
              </div>

              {/* Cash */}
              <div>
                <label className="text-tertiary mb-0.5 block text-[9px] font-semibold uppercase tracking-wider">Starting Cash (USD)</label>
                <input
                  type="number"
                  value={cash}
                  min={0}
                  onChange={(e) => setCash(parseInt(e.target.value, 10) || 0)}
                  className="w-full border border-[var(--border)] bg-editor px-2 py-1.5 text-[11px] font-mono text-primary outline-none"
                />
              </div>

              {/* Execution */}
              <div>
                <div className="text-secondary mb-1.5 border-0 border-b border-[var(--border)] pb-1 text-[9px] font-bold uppercase tracking-[0.12em]">
                  Execution
                </div>
                <div>
                  <label className="text-tertiary mb-0.5 block text-[9px] font-semibold uppercase tracking-wider">Slippage (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={slippage}
                    onChange={(e) => setSlippage(e.target.value)}
                    className="w-full border border-[var(--border)] bg-editor px-2 py-1.5 text-[10px] text-primary outline-none"
                  />
                  <p className="text-quaternary mt-0.5 text-[8px]">Adverse fill penalty on every order.</p>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <div>
                    <label className="text-tertiary mb-0.5 block text-[9px] font-semibold uppercase tracking-wider">Share Incr</label>
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={shareIncrement}
                      onChange={(e) => setShareIncrement(e.target.value)}
                      className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[10px] text-primary outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-tertiary mb-0.5 block text-[9px] font-semibold uppercase tracking-wider">Min Order Qty</label>
                    <input
                      type="number"
                      min="1"
                      value={minQty}
                      onChange={(e) => setMinQty(e.target.value)}
                      className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[10px] text-primary outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-tertiary mb-0.5 block text-[9px] font-semibold uppercase tracking-wider">Max Order Qty</label>
                    <input
                      type="number"
                      min="1"
                      value={maxQty}
                      onChange={(e) => setMaxQty(e.target.value)}
                      className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[10px] text-primary outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-2">
              <button
                onClick={() => setShowCreate(false)}
                className="border border-[var(--border)] bg-transparent px-3 py-1 text-[10px] text-secondary"
              >
                CANCEL
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !name.trim()}
                className="border border-[var(--accent)] bg-transparent px-3 py-1 text-[10px] font-bold text-accent disabled:opacity-40"
              >
                {creating ? "CREATING..." : "CREATE"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
