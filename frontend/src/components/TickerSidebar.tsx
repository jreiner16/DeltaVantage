import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { LiveStrategy, Quote } from "../lib/types";
import { useMosaicDrag } from "./MosaicPanelManager";

interface TickerSidebarProps {
  symbols: string[];
  active: string;
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onAdd: (symbol: string) => Promise<string | null>;
  onReorder: (symbols: string[]) => void;
  quotes: Record<string, Quote>;
  maxSymbols?: number;
  dragId?: string;
  liveStrategies?: LiveStrategy[];
  onDropStrategy?: (strategy: string, symbol: string) => void;
}

export default function TickerSidebar({
  symbols,
  active,
  onSelect,
  onRemove,
  onAdd,
  onReorder,
  quotes,
  maxSymbols = 0,
  dragId,
  liveStrategies = [],
  onDropStrategy,
}: TickerSidebarProps) {
  const full = maxSymbols > 0 && symbols.length >= maxSymbols;
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [addError, setAddError] = useState("");
  const [dragSym, setDragSym] = useState<string | null>(null);
  const [overSym, setOverSym] = useState<string | null>(null);
  const [strategyOverSym, setStrategyOverSym] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useMosaicDrag();

  useEffect(() => {
    if (!adding || !query) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const d = await api.symbols(query);
        if (!cancelled) {
          setMatches(d.symbols.filter((s) => !symbols.includes(s)).slice(0, 14));
          setDone(true);
        }
      } catch {
        if (!cancelled) setDone(true);
      }
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, adding, symbols]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setAdding(false);
        setQuery("");
        setMatches([]);
        setDone(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const closeAdd = () => {
    setAdding(false);
    setQuery("");
    setMatches([]);
    setDone(false);
    setAddError("");
  };
  const add = async (sym: string) => {
    const err = await onAdd(sym);
    if (err) {
      setAddError(err);
      setQuery("");
      setMatches([]);
      setDone(false);
    } else {
      closeAdd();
    }
  };

  const dropOn = (target: string) => {
    const from = dragSym;
    setDragSym(null);
    setOverSym(null);
    if (!from || from === target) return;
    const i = symbols.indexOf(from);
    const j = symbols.indexOf(target);
    if (i < 0 || j < 0) return;
    const next = [...symbols];
    next.splice(i, 1);
    next.splice(j, 0, from);
    onReorder(next);
  };

  return (
    <aside className="bg-panel flex h-full w-full flex-col">
      {/* Column header: doubles as the drag handle for moving the panel. */}
      <div
        {...(drag && dragId
          ? {
              draggable: true,
              onDragStart: (e: React.DragEvent) => drag.startDrag(dragId, e),
              onDragEnd: drag.endDrag,
              title: "Drag to move panel",
            }
          : {})}
        className={`flex cursor-grab items-center border-0 border-b border-[var(--border)] px-2 py-0.5 active:cursor-grabbing ${
          drag && dragId ? "" : "cursor-default active:cursor-default"
        }`}
      >
        <span className="text-secondary flex-1 text-[8px] font-bold uppercase tracking-[0.12em]">
          Symbol
        </span>
        <span className="text-secondary text-right text-[8px] font-bold uppercase tracking-[0.12em]">
          Chg%
        </span>
        <button
          onClick={() => { setAdding(true); setQuery(""); setMatches([]); setDone(false); }}
          disabled={full}
          className={`ml-1 flex h-4 w-4 shrink-0 items-center justify-center border-0 bg-transparent ${
            full ? "text-tertiary cursor-not-allowed" : "text-secondary hover:text-accent"
          }`}
          title={full ? `Watchlist full (${maxSymbols} max) — remove one to add another` : "Add symbol"}
        >
          <svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor">
            <path d="M5.5 2v6.5M2 5.5h7" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>

      {full && (
        <div className="text-tertiary border-0 border-b border-[var(--border)] px-2 py-1 text-[9px]">
          Watchlist full · {symbols.length}/{maxSymbols}
        </div>
      )}

      {/* Inline search */}
      {adding && (
        <div ref={boxRef} className="relative border-0 border-b border-[var(--border)] px-2 py-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            placeholder="SEARCH..."
            className="border border-[var(--border)] bg-editor w-full px-2 py-1 text-[11px] text-primary outline-none placeholder:text-tertiary"
          />
          {query && (
            <div className="bg-panel border border-[var(--border-strong)] absolute left-2 right-2 top-full z-20">
              {done && matches.length === 0 && (
                <p className="text-tertiary px-2 py-1.5 text-[10px]">No matches</p>
              )}
              {matches.map((sym) => (
                <button
                  key={sym}
                  onClick={() => add(sym)}
                  className="text-primary hover:bg-panel2 flex w-full items-center justify-between border-0 border-b border-[var(--border)] px-2 py-1 text-left text-[11px]"
                >
                  <span>{sym}</span>
                  <span className="text-accent text-[9px]">ADD</span>
                </button>
              ))}
            </div>
          )}
          {addError && (
            <div className="border border-[var(--down)] bg-down-soft mt-1 px-2 py-1 text-[9px] text-down">
              {addError}
            </div>
          )}
        </div>
      )}

      {/* Rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {symbols.length === 0 && (
          <p className="text-tertiary px-2 py-4 text-center text-[10px]">
            Empty
          </p>
        )}
        {symbols.map((sym) => {
          const q = quotes[sym];
          const isActive = sym === active;
          const up = (q?.change ?? 0) >= 0;
          const dragging = dragSym === sym;
          const dropTarget = dragSym && dragSym !== sym && overSym === sym;
          const strategyDropTarget = strategyOverSym === sym;
          const symbolLive = liveStrategies.filter((l) => l.symbol === sym);
          const canDropStrategy = onDropStrategy != null;
          return (
            <div
              key={sym}
              draggable
              onClick={() => onSelect(sym)}
              onDragStart={(e) => {
                setDragSym(sym);
                setOverSym(null);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", sym);
              }}
              onDragEnter={(e) => {
                if (e.dataTransfer.types.includes("application/x-dv-strategy")) {
                  if (canDropStrategy) {
                    setStrategyOverSym(sym);
                    setOverSym(null);
                  }
                } else if (dragSym) {
                  setOverSym(sym);
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer.types.includes("application/x-dv-strategy")) {
                  if (canDropStrategy && strategyOverSym !== sym) setStrategyOverSym(sym);
                } else if (dragSym && dragSym !== sym && overSym !== sym) {
                  setOverSym(sym);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer.types.includes("application/x-dv-strategy")) {
                  const name = e.dataTransfer.getData("application/x-dv-strategy") || e.dataTransfer.getData("text/plain");
                  setStrategyOverSym(null);
                  if (name && canDropStrategy) onDropStrategy(name, sym);
                  return;
                }
                dropOn(sym);
              }}
              onDragEnd={() => {
                setDragSym(null);
                setOverSym(null);
                setStrategyOverSym(null);
              }}
              title={isActive
                ? `Selected — drag to reorder${symbolLive.length ? ` · live: ${symbolLive.map((l) => l.strategy).join(", ")}` : ""}`
                : `Select ${sym} — drag to reorder${canDropStrategy ? " · drop a strategy here to run live" : ""}`}
              className={`group relative flex h-20 cursor-grab flex-col justify-center border-0 border-b border-[var(--border)] px-2.5 py-1.5 active:cursor-grabbing ${
                isActive ? "bg-accent-soft" : "hover:bg-panel2"
              } ${strategyDropTarget ? "shadow-[inset_0_0_0_2px_var(--up)] bg-up-soft/30" : ""} ${
                dragging ? "opacity-40" : ""
              } ${dropTarget ? "shadow-[inset_0_2px_0_0_var(--accent)]" : ""}`}
            >
              <div className="flex items-baseline gap-1.5 pr-5">
                {symbolLive.length > 0 && (
                  <span
                    className="flex h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--up)]"
                    title={`Live strategies: ${symbolLive.map((l) => l.strategy).join(", ")}`}
                  />
                )}
                <span
                  className={`shrink-0 text-[12px] font-bold tracking-wider ${
                    isActive ? "text-accent" : "text-primary"
                  }`}
                >
                  {sym}
                </span>
                <span className="text-tertiary flex-1 truncate text-right font-mono text-[11px]">
                  {q ? q.last.toFixed(2) : "--"}
                </span>
              </div>

              {(symbolLive.length > 0 || strategyDropTarget) && (
                <div className="mt-0.5 flex items-center gap-1.5">
                  {symbolLive.length > 0 && (
                    <span className="text-accent truncate text-[8px] font-bold uppercase tracking-widest">
                      LIVE · {symbolLive.map((l) => l.strategy).join(", ")}
                    </span>
                  )}
                  {strategyDropTarget && (
                    <span className="shrink-0 animate-pulse text-[8px] font-bold uppercase tracking-widest text-[var(--up)]">
                      DROP TO RUN LIVE
                    </span>
                  )}
                </div>
              )}

              <div className="mt-1 flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center">
                  <Sparkline data={q?.spark} up={up} active={isActive} />
                </div>
                <span
                  className={`w-16 shrink-0 text-right font-mono text-[11px] font-bold ${
                    isActive ? "text-accent" : up ? "text-up" : "text-down"
                  }`}
                >
                  {q ? `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%` : "--"}
                </span>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(sym);
                }}
                title={`Remove ${sym}`}
                className="text-tertiary hover:text-down absolute right-1 top-1.5 z-10 hidden border-0 bg-transparent px-0.5 group-hover:block"
              >
                <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function Sparkline({
  data,
  up,
  active,
}: {
  data?: number[];
  up: boolean;
  active: boolean;
}) {
  if (!data || data.length < 2) return null;
  const W = 100;
  const H = 18;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = W / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = i * step;
    const y = H - 1 - ((v - min) / range) * (H - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = active ? "var(--accent)" : up ? "var(--up)" : "var(--down)";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[18px] w-full">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1"
      />
    </svg>
  );
}
