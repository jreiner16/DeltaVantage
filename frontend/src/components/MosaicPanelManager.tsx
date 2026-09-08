import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

// ── Panel definitions ──────────────────────────────────────────────────────

export type PanelType = "watchlist" | "chart" | "trade" | "strategy" | "performance" | "backtest";

// A panel instance id is `${type}-<n>` where <n> is a per-type counter
// (chart-1, chart-2, ...). Any panel type may appear multiple times.
export type PanelId = string;

export type SlotId = "left" | "center" | "right" | "rightBottom" | "bottom";

export const SLOT_IDS: SlotId[] = ["left", "center", "right", "rightBottom", "bottom"];

export const PANEL_TYPES: PanelType[] = [
  "watchlist", "chart", "trade", "strategy", "performance", "backtest",
];

export const PANEL_LABELS: Record<PanelType, string> = {
  watchlist: "Watchlist",
  chart: "Chart",
  trade: "Trade",
  strategy: "Strategy",
  performance: "Performance",
  backtest: "Backtest",
};

// Where a panel goes when it is added (or on first launch).
export const DEFAULT_BIN: Record<PanelType, SlotId> = {
  watchlist: "left",
  chart: "center",
  trade: "right",
  strategy: "rightBottom",
  performance: "bottom",
  backtest: "bottom",
};

export function panelTypeOf(id: PanelId): PanelType {
  return id.split("-")[0] as PanelType;
}

export function panelNum(id: PanelId): number {
  const n = Number(id.slice(id.indexOf("-") + 1));
  return Number.isFinite(n) ? n : 1;
}

export function panelLabel(id: PanelId): string {
  const base = PANEL_LABELS[panelTypeOf(id)];
  const n = panelNum(id);
  return n > 1 ? `${base} ${n}` : base;
}

// ── Mosaic state ──────────────────────────────────────────────────────────
// The layout is a set of dock "bins". Each bin holds zero or more panel
// instances as tabs; the active tab is shown. Empty bins simply take no space.

export interface MosaicState {
  bins: Record<SlotId, PanelId[]>;
  active: Record<SlotId, PanelId | null>;
  sizes: Record<SlotId, number>;
}

export const DEFAULT_MOSAIC: MosaicState = {
  bins: {
    left: ["watchlist-1"],
    center: ["chart-1"],
    right: ["trade-1"],
    rightBottom: ["strategy-1"],
    bottom: ["performance-1", "backtest-1"],
  },
  active: {
    left: "watchlist-1",
    center: "chart-1",
    right: "trade-1",
    rightBottom: "strategy-1",
    bottom: "performance-1",
  },
  sizes: { left: 220, center: 0, right: 280, rightBottom: 260, bottom: 220 },
};

// ── State helpers ──────────────────────────────────────────────────────────

export function mosaicFind(state: MosaicState, id: PanelId): SlotId | null {
  for (const b of SLOT_IDS) {
    if (state.bins[b].includes(id)) return b;
  }
  return null;
}

// Largest existing `${type}-<n>` plus one, so new instances never collide.
export function nextPanelId(type: PanelType, state: MosaicState): PanelId {
  let max = 0;
  for (const b of SLOT_IDS) {
    for (const id of state.bins[b]) {
      if (id.startsWith(type + "-")) {
        const n = Number(id.slice(type.length + 1));
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
    }
  }
  return `${type}-${max + 1}`;
}

// Move `id` into `bin`, inserting before `before` (or appending if null).
// If the panel was already docked it is removed from its old bin first.
export function mosaicMoveBefore(
  state: MosaicState,
  id: PanelId,
  bin: SlotId,
  before: PanelId | null
): MosaicState {
  const bins: Record<SlotId, PanelId[]> = { ...state.bins };
  const active: Record<SlotId, PanelId | null> = { ...state.active };

  for (const b of SLOT_IDS) {
    if (bins[b].includes(id)) {
      const next = bins[b].filter((p) => p !== id);
      bins[b] = next;
      if (active[b] === id) active[b] = next[0] ?? null;
    }
  }

  const alreadyHere = bins[bin].includes(id);
  if (before === id && alreadyHere) {
    const found = SLOT_IDS.find((b) => bins[b].includes(id)) ?? bin;
    return { ...state, active: { ...active, [found]: id } };
  }

  const list = [...bins[bin]];
  const idx = before ? list.indexOf(before) : -1;
  const at = idx === -1 ? list.length : idx;
  list.splice(at, 0, id);
  bins[bin] = list;
  active[bin] = id;

  return { ...state, bins, active };
}

export function mosaicActivate(state: MosaicState, bin: SlotId, id: PanelId): MosaicState {
  if (!state.bins[bin].includes(id)) return state;
  return { ...state, active: { ...state.active, [bin]: id } };
}

// Dock a new (or re-docked) instance into `bin` and activate it. Any prior
// occurrence elsewhere is moved.
export function mosaicAddPanel(state: MosaicState, id: PanelId, bin: SlotId): MosaicState {
  const bins: Record<SlotId, PanelId[]> = { ...state.bins };
  for (const b of SLOT_IDS) bins[b] = bins[b].filter((p) => p !== id);
  bins[bin] = [...bins[bin], id];
  return { ...state, bins, active: { ...state.active, [bin]: id } };
}

// Remove a panel instance from the dock entirely. Empty bins simply shrink.
export function mosaicClose(state: MosaicState, id: PanelId): MosaicState {
  const b = mosaicFind(state, id);
  if (!b) return state;
  const bins: Record<SlotId, PanelId[]> = { ...state.bins };
  const next = bins[b].filter((p) => p !== id);
  if (next.length === bins[b].length) return state;
  bins[b] = next;
  const active: Record<SlotId, PanelId | null> = { ...state.active };
  if (active[b] === id) active[b] = next[0] ?? null;
  return { ...state, bins, active };
}

// If a panel of `type` exists, activate it; otherwise dock a fresh instance.
export function mosaicEnsurePanelOfType(state: MosaicState, type: PanelType): MosaicState {
  for (const b of SLOT_IDS) {
    const found = state.bins[b].find((id) => panelTypeOf(id) === type);
    if (found) return mosaicActivate(state, b, found);
  }
  return mosaicAddPanel(state, nextPanelId(type, state), DEFAULT_BIN[type]);
}

export function mosaicSetBinSize(state: MosaicState, bin: SlotId, size: number): MosaicState {
  return { ...state, sizes: { ...state.sizes, [bin]: size } };
}

// ── Drag context ──────────────────────────────────────────────────────────
// Exposed so widget headers (e.g. the watchlist column header) can act as
// drag handles for moving a panel to another bin or out of the window.

const DRAG_DATA = "application/x-dv-mosaic-panel";

interface MosaicDragApi {
  dragging: PanelId | null;
  startDrag: (id: PanelId, e: React.DragEvent) => void;
  endDrag: () => void;
}

const MosaicDragCtx = createContext<MosaicDragApi | null>(null);

export function useMosaicDrag(): MosaicDragApi | null {
  return useContext(MosaicDragCtx);
}

// ── Drag divider ──────────────────────────────────────────────────────────
// A single visible 1px separator that also serves as the resize handle.
// `dir` flips the drag direction: +1 grows the sized bin when dragging along
// the positive axis (right for vertical, down for horizontal). A divider
// sitting at the TOP edge of a lower/higher bin (bottom / right-bottom) must
// use dir=-1 so dragging DOWN shrinks that bin.

function DragDivider({
  vertical,
  size,
  min,
  max,
  dir = 1,
  apply,
  reset,
}: {
  vertical?: boolean;
  size: number;
  min: number;
  max: number;
  dir?: 1 | -1;
  apply: (next: number) => void;
  reset?: number;
}) {
  const start = useRef<{ pointer: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const pointer = vertical ? e.clientX : e.clientY;
    start.current = { pointer, size };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const cur = vertical ? e.clientX : e.clientY;
    const delta = cur - start.current.pointer;
    const next = Math.max(min, Math.min(max, Math.round(start.current.size + dir * delta)));
    apply(next);
  };
  const onPointerUp = () => {
    start.current = null;
    setDragging(false);
  };
  const onDbl = () => {
    if (reset != null) apply(reset);
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDbl}
      className={`group relative z-10 shrink-0 touch-none ${
        vertical ? "w-[6px] cursor-col-resize" : "h-[6px] cursor-row-resize"
      }`}
    >
      <div
        className={`absolute ${
          vertical
            ? "inset-y-0 left-1/2 -translate-x-1/2 w-px"
            : "inset-x-0 top-1/2 -translate-y-1/2 h-px"
        } ${dragging ? "bg-accent" : "bg-[var(--border)] group-hover:bg-accent"}`}
      />
    </div>
  );
}

// ── Tab ────────────────────────────────────────────────────────────────────
// A single tab in a bin's tab strip. It is the drag handle for its panel and
// a drop target for reordering other panels before it.

function Tab({
  id,
  active,
  drag,
  onSelect,
  onClose,
  onDropBefore,
}: {
  id: PanelId;
  active: boolean;
  drag: MosaicDragApi;
  onSelect: () => void;
  onClose: () => void;
  onDropBefore: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => drag.startDrag(id, e)}
      onDragEnd={drag.endDrag}
      onDragOver={(e) => {
        if (drag.dragging && drag.dragging !== id) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        if (drag.dragging && drag.dragging !== id) {
          e.preventDefault();
          e.stopPropagation();
          onDropBefore();
        }
      }}
      onClick={onSelect}
      title={`${panelLabel(id)} — click to view, drag to move or out of the window`}
      className={`group flex h-7 min-w-0 max-w-44 shrink-0 cursor-grab items-center gap-1 border-0 border-b-2 px-2 active:cursor-grabbing ${
        active
          ? "border-b-[var(--accent)] text-accent"
          : "border-transparent text-secondary hover:text-primary"
      } ${drag.dragging === id ? "opacity-50" : ""}`}
    >
      <span className="truncate text-[9px] font-bold uppercase tracking-wider">{panelLabel(id)}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title={`Remove ${panelLabel(id)} from layout`}
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent text-tertiary opacity-0 transition-opacity hover:!opacity-100 hover:text-down group-hover:opacity-70 ${
          active ? "opacity-50" : ""
        }`}
      >
        <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
    </div>
  );
}

// ── Bin (dock cell) ────────────────────────────────────────────────────────
// One dock slot: tab strip + active view body. Also a drop target.

function BinCell({
  bin,
  state,
  render,
  drag,
  onMoveBefore,
  onSelect,
  onClose,
}: {
  bin: SlotId;
  state: MosaicState;
  render: (id: PanelId) => { toolbar?: React.ReactNode; body: React.ReactNode } | null;
  drag: MosaicDragApi;
  onMoveBefore: (id: PanelId, before: PanelId | null) => void;
  onSelect: (id: PanelId) => void;
  onClose: (id: PanelId) => void;
}) {
  const bins = state.bins[bin];
  const active = state.active[bin];
  const view = active ? render(active) : null;
  const [over, setOver] = useState(false);
  const acceptDrop = drag.dragging != null;

  return (
    <div
      className={`relative flex min-h-0 flex-1 flex-col ${
        acceptDrop && drag.dragging !== active && over
          ? "outline outline-1 outline-dashed outline-[var(--accent)] bg-[var(--accent-soft)]"
          : ""
      }`}
      onDragOver={(e) => {
        if (!acceptDrop) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!e.currentTarget.contains(el)) setOver(false);
      }}
      onDrop={(e) => {
        if (!acceptDrop) return;
        e.preventDefault();
        setOver(false);
        if (drag.dragging !== active) onMoveBefore(drag.dragging!, null);
      }}
    >
      {/* Tab strip */}
      <div className="bg-panel flex h-8 shrink-0 items-center gap-px border-0 border-b border-[var(--border)] px-1">
        {bins.map((id) => (
          <Tab
            key={id}
            id={id}
            active={id === active}
            drag={drag}
            onSelect={() => onSelect(id)}
            onClose={() => onClose(id)}
            onDropBefore={() => onMoveBefore(drag.dragging!, id)}
          />
        ))}
        {bins.length === 0 && (
          <span className="text-tertiary px-2 text-[9px]">Drag a tab here</span>
        )}
      </div>

      {/* Active view */}
      {view && (
        <div className="flex min-h-0 flex-1 flex-col">
          {view.toolbar && (
            <div className="shrink-0">{view.toolbar}</div>
          )}
          <div className="min-h-0 flex-1 overflow-auto">{view.body}</div>
        </div>
      )}
    </div>
  );
}

// ── Mosaic layout component ───────────────────────────────────────────────

interface MosaicLayoutProps {
  state: MosaicState;
  onStateChange: React.Dispatch<React.SetStateAction<MosaicState>>;
  renderPanel: (id: PanelId) => { toolbar?: React.ReactNode; body: React.ReactNode } | null;
  onDetachPanel: (id: PanelId) => void;
}

export function MosaicLayout({ state, onStateChange, renderPanel, onDetachPanel }: MosaicLayoutProps) {
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const detachPanelRef = useRef(onDetachPanel);
  const draggingRef = useRef<PanelId | null>(null);

  useEffect(() => {
    detachPanelRef.current = onDetachPanel;
  }, [onDetachPanel]);

  useEffect(() => {
    draggingRef.current = dragging;
  }, [dragging]);

  const dragApi = useMemo<MosaicDragApi>(
    () => ({
      dragging,
      startDrag: (id, e) => {
        e.dataTransfer.setData(DRAG_DATA, id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(id);
      },
      endDrag: () => setDragging(null),
    }),
    [dragging]
  );

  // While a panel is being dragged, watch the window edge: HTML5 drag events
  // stop at the window, so a dragleave with `relatedTarget == null` means the
  // user dragged the tab out of the window entirely -> detach it there.
  useEffect(() => {
    if (!dragging) return;
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget == null) {
        const id = draggingRef.current;
        setDragging(null);
        if (id) detachPanelRef.current(id);
      }
    };
    const onDragEnd = () => setDragging(null);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [dragging]);

  const apply = useCallback(
    (fn: (m: MosaicState) => MosaicState) => onStateChange(fn),
    [onStateChange]
  );

  const moveBefore = useCallback(
    (id: PanelId, bin: SlotId, before: PanelId | null) => {
      setDragging(null);
      apply((m) => mosaicMoveBefore(m, id, bin, before));
    },
    [apply]
  );

  const closePanel = useCallback((id: PanelId) => apply((m) => mosaicClose(m, id)), [apply]);
  const selectPanel = useCallback(
    (bin: SlotId, id: PanelId) => apply((m) => mosaicActivate(m, bin, id)),
    [apply]
  );
  const setBinSize = useCallback(
    (bin: SlotId, size: number) => apply((m) => mosaicSetBinSize(m, bin, size)),
    [apply]
  );

  const { bins, sizes } = state;
  const showLeft = bins.left.length > 0;
  const showRight = bins.right.length > 0;
  const showRightBottom = bins.rightBottom.length > 0;
  const showBottom = bins.bottom.length > 0;
  const showCenter = bins.center.length > 0;
  const showRightCol = showRight || showRightBottom;

  const binProps = (bin: SlotId) => ({
    bin,
    state,
    render: renderPanel,
    drag: dragApi,
    onMoveBefore: (id: PanelId, before: PanelId | null) => moveBefore(id, bin, before),
    onSelect: (id: PanelId) => selectPanel(bin, id),
    onClose: (id: PanelId) => closePanel(id),
  });

  return (
    <MosaicDragCtx.Provider value={dragApi}>
      <div className="flex min-h-0 flex-1">
        {/* ── Left slot ─────────────────────────────────────────────── */}
        {showLeft && (
          <div className="flex shrink-0 flex-col" style={{ width: sizes.left }}>
            <BinCell {...binProps("left")} />
          </div>
        )}
        {showLeft && (
          <DragDivider
            vertical
            size={sizes.left}
            min={140}
            max={340}
            dir={1}
            apply={(s) => setBinSize("left", s)}
            reset={220}
          />
        )}

        {/* ── Center column (center slot + bottom slot) ─────────────── */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {showCenter ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <BinCell {...binProps("center")} />
            </div>
          ) : (
            <div className="text-tertiary flex min-h-0 flex-1 items-center justify-center text-[10px]">
              Empty — add a Chart from the + menu
            </div>
          )}

          {showBottom && (
            <DragDivider
              size={sizes.bottom}
              min={120}
              max={480}
              dir={-1}
              apply={(s) => setBinSize("bottom", s)}
              reset={220}
            />
          )}
          {showBottom && (
            <div className="flex shrink-0 flex-col" style={{ height: sizes.bottom }}>
              <BinCell {...binProps("bottom")} />
            </div>
          )}
        </div>

        {/* ── Right column (right slot + right-bottom slot) ─────────── */}
        {showRightCol && (
          <DragDivider
            vertical
            size={sizes.right}
            min={220}
            max={460}
            dir={-1}
            apply={(s) => setBinSize("right", s)}
            reset={280}
          />
        )}
        {showRightCol && (
          <div className="flex min-h-0 shrink-0 flex-col" style={{ width: sizes.right }}>
            {showRight ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <BinCell {...binProps("right")} />
              </div>
            ) : (
              <div className="min-h-0 flex-1" />
            )}
            {showRightBottom && (
              <DragDivider
                size={sizes.rightBottom}
                min={120}
                max={440}
                dir={-1}
                apply={(s) => setBinSize("rightBottom", s)}
                reset={260}
              />
            )}
            {showRightBottom && (
              <div className="flex shrink-0 flex-col" style={{ height: sizes.rightBottom }}>
                <BinCell {...binProps("rightBottom")} />
              </div>
            )}
          </div>
        )}
      </div>
    </MosaicDragCtx.Provider>
  );
}