import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/api";
import type {
  BacktestResult, BarData, LiveStrategy, MarketStatus, Order, PerfPoint, Portfolio, PortfolioEntry, Position, Quote, Settings, Trade,
} from "./lib/types";
import type { IndicatorOverlay } from "./components/PriceChart";
import TickerSidebar from "./components/TickerSidebar";
import PriceChart from "./components/PriceChart";
import OrderPanel from "./components/OrderPanel";
import StrategyView from "./components/StrategyView";
import SettingsModal from "./components/SettingsModal";
import PortfolioHub from "./components/PortfolioHub";
import LiveStrategyModal from "./components/LiveStrategyModal";
import { computeRoundTrips, type RoundTrip } from "./lib/roundTrips";
import { useWindowContext } from "./lib/windowContext.tsx";
import { buildExports, downloadExport } from "./lib/backtestExport";
import {
  MosaicLayout,
  mosaicAddPanel,
  mosaicClose,
  mosaicEnsurePanelOfType,
  nextPanelId,
  panelTypeOf,
  PANEL_LABELS,
  PANEL_TYPES,
  SLOT_IDS,
  type MosaicState,
  type PanelId,
  type PanelType,
  DEFAULT_BIN,
  DEFAULT_MOSAIC,
} from "./components/MosaicPanelManager";

const INTERVALS = ["1Min", "5Min", "15Min", "1Hour", "1Day"] as const;
// Collapse long backtest sections once they exceed this many rows.
const MAX_BACKTEST_ROWS = 20;
const DEFAULT_LOOKBACK: Record<string, number> = {
  "1Min": 7,
  "5Min": 60,
  "15Min": 180,
  "1Hour": 365,
  "1Day": 1825,
};
type Theme = "light" | "dark" | "mid";

// The primary chart is the one the watchlist stays in sync with and that the
// Trade panel quotes.
const PRIMARY_CHART_ID = "chart-1";

interface ChartInstance {
  symbol: string;
  interval: string;
  bars: BarData[];
  loading: boolean;
  chartError: string;
  lookbackDays: number;
  noMoreHistory: boolean;
  loadingMore: boolean;
  indicators: IndicatorOverlay[];
}

function makeChartInstance(symbol: string, interval: string, lookbackDays?: number): ChartInstance {
  return {
    symbol,
    interval,
    bars: [],
    loading: false,
    chartError: "",
    lookbackDays: lookbackDays ?? DEFAULT_LOOKBACK[interval] ?? 180,
    noMoreHistory: false,
    loadingMore: false,
    indicators: [],
  };
}

export default function App() {
  const { windowType, isElectron, electronAPI } = useWindowContext();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);

  // Mosaic panel layout state
  const [mosaic, setMosaic] = useState<MosaicState>(DEFAULT_MOSAIC);

  // Watchlist
  const [symbols, setSymbols] = useState<string[]>([]);
  const [active, setActive] = useState("AAPL");
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});

  // Per-instance chart data
  const [charts, setCharts] = useState<Record<PanelId, ChartInstance>>({});
  const [defaultInterval, setDefaultInterval] = useState<string>("1Min");
  const loadingMoreRef = useRef<Record<string, boolean>>({});
  const barTargetRef = useRef<Record<string, number | null>>({});
  const chartKeyRef = useRef<Record<string, string>>({});
  const chartIntervalRef = useRef<Record<string, string>>({});

  // Orders
  const [orders, setOrders] = useState<Order[]>([]);

  // Live strategies
  const [liveStrategies, setLiveStrategies] = useState<LiveStrategy[]>([]);
  const [liveModal, setLiveModal] = useState<{ strategy: string; symbol: string } | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveError, setLiveError] = useState("");

  // Performance history
  const [perfPoints, setPerfPoints] = useState<PerfPoint[]>([]);

  // Backtest report
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [savedBacktests, setSavedBacktests] = useState<import("./lib/types").BacktestSummary[]>([]);

  // Panel visibility
  const [runSignal, setRunSignal] = useState(0);

  // Settings
  const [theme, setTheme] = useState<Theme>("dark");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  // Market status + live clock
  const [market, setMarket] = useState<MarketStatus | null>(null);
  const [clock, setClock] = useState<Date>(new Date());

  // Portfolio hub
  const [portfolios, setPortfolios] = useState<PortfolioEntry[]>([]);
  const [hubOpen, setHubOpen] = useState(true);

  // Backend boot overlay (Electron hub window only)
  const [booting, setBooting] = useState(() => !!window.electronAPI && windowType === "hub");
  const [bootStatus, setBootStatus] = useState("starting backend");

  const refreshPortfolios = useCallback(async () => {
    try {
      const d = await api.portfolios();
      setPortfolios(d.portfolios);
    } catch { /* backend not up */ }
  }, []);

  useEffect(() => {
    refreshPortfolios();
  }, [refreshPortfolios]);

  useEffect(() => {
    const tick = () => setClock(new Date());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchMarket = async () => {
      try {
        const d = await api.market();
        if (!cancelled) setMarket(d);
      } catch { /* backend not up */ }
    };
    fetchMarket();
    const id = setInterval(fetchMarket, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
  }, [theme]);

  const handleDetach = useCallback((id: PanelId) => {
    if (!electronAPI) return;
    // Drag-out: pop the panel into its own Electron window and undock it here.
    setMosaic((m) => mosaicClose(m, id));
    const type = panelTypeOf(id);
    const view = type === "trade" ? "orders" : type;
    electronAPI.detachPanel(view);
  }, [electronAPI]);

  // Focus an existing panel of the type, or dock a fresh instance.
  const ensurePanelOfType = useCallback((type: PanelType) => {
    setMosaic((m) => mosaicEnsurePanelOfType(m, type));
  }, []);

  // Add a brand-new instance of a panel type from the Panels menu.
  const handleAddPanel = useCallback((type: PanelType) => {
    const id = nextPanelId(type, mosaic);
    setMosaic((m) => mosaicAddPanel(m, id, DEFAULT_BIN[type]));
  }, [mosaic]);

  // How many instances of each panel type are currently docked.
  const panelCounts = useMemo(() => {
    const c: Record<PanelType, number> = { watchlist: 0, chart: 0, trade: 0, strategy: 0, performance: 0, backtest: 0 };
    for (const b of SLOT_IDS) {
      for (const id of mosaic.bins[b]) c[panelTypeOf(id)] += 1;
    }
    return c;
  }, [mosaic]);

  // Data fetching
  const refreshPortfolio = useCallback(async () => {
    try { setPortfolio(await api.portfolio()); } catch { /* backend not up */ }
  }, []);

  const refreshOrders = useCallback(async () => {
    try { const d = await api.orders(); setOrders(d.orders); } catch { /* ignore */ }
  }, []);

  const refreshQuotes = useCallback(async () => {
    try { const d = await api.quotes(); setQuotes(d.quotes); } catch { /* ignore */ }
  }, []);

  const refreshPerformance = useCallback(async () => {
    try { const d = await api.performance(); setPerfPoints(d.points); } catch { /* ignore */ }
  }, []);

  const refreshLiveStrategies = useCallback(async () => {
    try { const d = await api.liveStrategies(); setLiveStrategies(d.strategies); } catch { /* ignore */ }
  }, []);

  const handleStartLiveStrategy = useCallback(async (interval: string, params: Record<string, unknown>) => {
    if (!liveModal) return;
    setLiveBusy(true);
    setLiveError("");
    try {
      await api.startLiveStrategy({
        strategy: liveModal.strategy,
        symbol: liveModal.symbol,
        interval,
        params,
      });
      setLiveModal(null);
      await refreshLiveStrategies();
      refreshPortfolio();
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : "Failed to start live strategy");
    } finally {
      setLiveBusy(false);
    }
  }, [liveModal, refreshLiveStrategies, refreshPortfolio]);

  const handleStopLiveStrategy = useCallback(async (key: string) => {
    try {
      await api.stopLiveStrategy(key);
      await refreshLiveStrategies();
    } catch { /* ignore */ }
  }, [refreshLiveStrategies]);

  const handleStopAllLiveStrategies = useCallback(async () => {
    try {
      await api.stopAllLiveStrategies();
      await refreshLiveStrategies();
    } catch { /* ignore */ }
  }, [refreshLiveStrategies]);

  const refreshWatchlist = useCallback(async () => {
    try {
      const d = await api.watchlist();
      setSymbols(d.symbols);
      setActive((prev) => (d.symbols.includes(prev) ? prev : d.symbols[0] || "AAPL"));
    } catch { /* ignore */ }
  }, []);

  const applyPortfolioState = useCallback((ps: Portfolio) => {
    setPortfolio(ps);
    refreshOrders();
    refreshPerformance();
    refreshWatchlist();
    refreshLiveStrategies();
    setHubOpen(false);
  }, [refreshOrders, refreshPerformance, refreshWatchlist, refreshLiveStrategies]);

  // Load the *currently active* portfolio's settings (theme, interval, etc.)
  // from the backend and apply them to the UI. Settings are scoped per
  // portfolio on the server, so this must be re-run whenever the active
  // portfolio changes.
  const loadSettings = useCallback(async () => {
    try {
      const d = await api.settings();
      setSettings(d.settings);
      setTheme(d.settings.theme === "light" ? "light" : d.settings.theme === "mid" ? "mid" : "dark");
      setDefaultInterval(d.settings.default_interval);
    } catch { /* backend not up */ }
  }, []);

  // ── Electron IPC listeners ─────────────────────────────────────────────
  useEffect(() => {
    if (!electronAPI) return;
    electronAPI.onOpenPortfolio((pid) => {
      api.openPortfolio(pid).then((d) => {
        applyPortfolioState(d.portfolio_state);
        loadSettings();
      }).catch(() => {});
    });
    electronAPI.onBootStatus((msg) => setBootStatus(msg));
    electronAPI.onBootComplete(() => setBooting(false));
  }, [electronAPI, applyPortfolioState, loadSettings]);

  // Guarantee the boot overlay clears once the backend is healthy, even if
  // an IPC event fired before the renderer registered its listeners.
  useEffect(() => {
    if (!booting) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/health");
        if (!cancelled && res.ok) setBooting(false);
      } catch { /* backend not ready yet */ }
    };
    poll();
    const id = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(id); };
  }, [booting]);

  // Once the overlay clears, pull data that failed to load during boot.
  useEffect(() => {
    if (booting) return;
    refreshPortfolios();
    refreshPortfolio();
    refreshOrders();
    refreshPerformance();
    refreshLiveStrategies();
    refreshWatchlist();
    refreshQuotes();
  }, [booting, refreshPortfolios, refreshPortfolio, refreshOrders, refreshPerformance, refreshLiveStrategies, refreshWatchlist, refreshQuotes]);

  const handleOpenPortfolio = useCallback(async (pid: string): Promise<string | null> => {
    try {
      const d = await api.openPortfolio(pid);
      setPortfolios((prev) => prev.map((p) => ({ ...p, current: p.id === pid })));
      await loadSettings();
      // In Electron: open portfolio in a new window
      if (isElectron && electronAPI) {
        electronAPI.openPortfolio(pid);
        return null;
      }
      applyPortfolioState(d.portfolio_state);
      return null;
    } catch (e) {
      return (e as Error).message || "Failed to open portfolio";
    }
  }, [applyPortfolioState, loadSettings, isElectron, electronAPI]);

  const handleCreatePortfolio = useCallback(async (name: string, opts?: { starting_cash?: number; slippage?: number; min_order_qty?: number; max_order_qty?: number }): Promise<string | null> => {
    try {
      const d = await api.createPortfolio(name, opts);
      setPortfolios((prev) => [...prev, d.portfolio]);
      applyPortfolioState(d.portfolio_state);
      await loadSettings();
      return null;
    } catch (e) {
      return (e as Error).message || "Failed to create portfolio";
    }
  }, [applyPortfolioState, loadSettings]);

  const handleRenamePortfolio = useCallback(async (pid: string, name: string): Promise<string | null> => {
    try {
      const d = await api.renamePortfolio(pid, name);
      setPortfolios((prev) => prev.map((p) => (p.id === pid ? d.portfolio : p)));
      return null;
    } catch (e) {
      return (e as Error).message || "Failed to rename portfolio";
    }
  }, []);

  const handleDeletePortfolio = useCallback(async (pid: string): Promise<string | null> => {
    try {
      await api.deletePortfolio(pid);
      setPortfolios((prev) => prev.filter((p) => p.id !== pid));
      return null;
    } catch (e) {
      return (e as Error).message || "Failed to delete portfolio";
    }
  }, []);

  const handleExportPortfolio = useCallback(async (pid: string): Promise<Record<string, unknown> | null> => {
    try {
      return await api.exportPortfolio(pid);
    } catch {
      return null;
    }
  }, []);

  const handleImportPortfolio = useCallback(async (payload: Record<string, unknown>, name?: string): Promise<string | null> => {
    try {
      const d = await api.importPortfolio(payload, name);
      setPortfolios((prev) => [...prev, d.portfolio]);
      await refreshPortfolios();
      return null;
    } catch (e) {
      return (e as Error).message || "Failed to import portfolio";
    }
  }, [refreshPortfolios]);

  const currentPortfolioName = useCallback(() => {
    const cur = portfolios.find((p) => p.current);
    return cur ? cur.name : "Untitled";
  }, [portfolios]);

  const currentPortfolioId = useCallback(() => {
    return portfolios.find((p) => p.current)?.id ?? null;
  }, [portfolios]);

  const refreshSavedBacktests = useCallback(async () => {
    const pid = portfolios.find((p) => p.current)?.id;
    if (!pid) return;
    try {
      const d = await api.backtests(pid);
      setSavedBacktests(d.backtests);
    } catch { /* ignore */ }
  }, [portfolios]);

  const handleBacktestComplete = useCallback((res: BacktestResult, label?: string) => {
    setBacktest(res);
    setMosaic((m) => mosaicEnsurePanelOfType(m, "backtest"));
    const pid = portfolios.find((p) => p.current)?.id;
    if (pid) {
      api.saveBacktest(pid, {
        label: label ?? defaultBacktestLabel(res),
        strategy: res.symbol || "strategy",
        config: { symbol: res.symbol, interval: res.interval, days: res.days },
        result: res,
      }).then(refreshSavedBacktests).catch(() => {});
    }
  }, [portfolios, refreshSavedBacktests]);

  const handleLoadSavedRun = useCallback(async (bid: string) => {
    const pid = portfolios.find((p) => p.current)?.id;
    if (!pid) return;
    try {
      const run = await api.getBacktest(pid, bid);
      setBacktest(run as unknown as BacktestResult);
      setMosaic((m) => mosaicEnsurePanelOfType(m, "backtest"));
    } catch { /* ignore */ }
  }, [portfolios]);

  const handleDeleteSavedRun = useCallback(async (bid: string) => {
    const pid = portfolios.find((p) => p.current)?.id;
    if (!pid) return;
    try {
      await api.deleteBacktest(pid, bid);
      await refreshSavedBacktests();
    } catch { /* ignore */ }
  }, [portfolios, refreshSavedBacktests]);

  useEffect(() => { refreshSavedBacktests(); }, [refreshSavedBacktests]);

  useEffect(() => {
    refreshPortfolio();
    refreshOrders();
    refreshPerformance();
    refreshLiveStrategies();
    const id = setInterval(() => {
      refreshPortfolio();
      refreshPerformance();
      refreshOrders();
      refreshLiveStrategies();
    }, 5000);
    return () => clearInterval(id);
  }, [refreshPortfolio, refreshOrders, refreshPerformance, refreshLiveStrategies]);

  useEffect(() => {
    refreshWatchlist();
    refreshQuotes();
    const id = setInterval(refreshQuotes, 30000);
    return () => clearInterval(id);
  }, [refreshWatchlist, refreshQuotes]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const loadChartBars = useCallback(async (id: PanelId, symbol: string, interval: string, days: number, showSpinner = true) => {
    if (showSpinner) {
      setCharts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], loading: true } } : prev));
    }
    setCharts((prev) =>
      prev[id] ? { ...prev, [id]: { ...prev[id], chartError: "", noMoreHistory: false } } : prev
    );
    try {
      const d = await api.bars(symbol, interval, days);
      setCharts((prev) =>
        prev[id] ? { ...prev, [id]: { ...prev[id], bars: d.bars, lookbackDays: days } } : prev
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load bars";
      setCharts((prev) =>
        prev[id]
          ? { ...prev, [id]: { ...prev[id], chartError: msg, bars: showSpinner ? [] : prev[id].bars } }
          : prev
      );
    } finally {
      if (showSpinner) {
        setCharts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], loading: false } } : prev));
      }
    }
  }, []);

  // Seed chart state for any docked chart instance and prune state for ones
  // that have since been closed.
  useEffect(() => {
    setCharts((prev) => {
      const ids: PanelId[] = [];
      for (const b of SLOT_IDS) {
        for (const id of mosaic.bins[b]) if (panelTypeOf(id) === "chart") ids.push(id);
      }
      let changed = false;
      const next: Record<PanelId, ChartInstance> = { ...prev };
      for (const id of Object.keys(next)) if (!ids.includes(id)) { delete next[id]; changed = true; }
      for (const id of ids) if (!next[id]) { next[id] = makeChartInstance(active, defaultInterval, settings?.default_lookback_days); changed = true; }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mosaic, defaultInterval]);

  // Reload a chart whenever its symbol or interval changes.
  useEffect(() => {
    for (const [id, c] of Object.entries(charts)) {
      const key = `${c.symbol}:${c.interval}`;
      if (chartKeyRef.current[id] !== key) {
        const firstLoad = !chartKeyRef.current[id];
        const intervalChanged = chartIntervalRef.current[id] !== c.interval;
        chartIntervalRef.current[id] = c.interval;
        chartKeyRef.current[id] = key;
        // Respect the seeded (settings-default) lookback on first load / symbol
        // change; on interval change use the per-interval sensible default.
        loadChartBars(
          id,
          c.symbol,
          c.interval,
          firstLoad || !intervalChanged
            ? c.lookbackDays || (DEFAULT_LOOKBACK[c.interval] ?? 180)
            : DEFAULT_LOOKBACK[c.interval] ?? 180,
          true
        );
      }
    }
  }, [charts, loadChartBars]);

  // When a bar boundary passes, refresh each chart so the new bar appears.
  useEffect(() => {
    for (const [id, c] of Object.entries(charts)) {
      const target = nextBarTarget(c.interval, clock, market, c.symbol.includes("/"));
      const prev = barTargetRef.current[id];
      barTargetRef.current[id] = target;
      if (prev != null && target != null && !loadingMoreRef.current[id] && clock.getTime() >= prev) {
        loadChartBars(id, c.symbol, c.interval, DEFAULT_LOOKBACK[c.interval] ?? 180, false);
      }
    }
  }, [clock, market, charts, loadChartBars]);

  const handleNeedOlder = useCallback((id: PanelId) => {
    const c = charts[id];
    if (!c || loadingMoreRef.current[id] || c.noMoreHistory) return;
    loadingMoreRef.current[id] = true;
    setCharts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], loadingMore: true } } : prev));
    const next = Math.min(c.lookbackDays * 3, 3650);
    api.bars(c.symbol, c.interval, next)
      .then((d) => {
        setCharts((prev) => {
          const cur = prev[id];
          if (!cur) return prev;
          if (d.bars.length === 0) {
            return { ...prev, [id]: { ...cur, noMoreHistory: true } };
          }
          const map = new Map<number, BarData>();
          for (const b of d.bars) map.set(b.time_ts, b);
          for (const b of cur.bars) map.set(b.time_ts, b);
          const merged = Array.from(map.values()).sort((a, b) => a.time_ts - b.time_ts);
          const earliest = d.bars.length > 0 ? Math.min(...d.bars.map((b) => b.time_ts)) : null;
          const oldestPrev = cur.bars.length > 0 ? cur.bars[0].time_ts : null;
          return {
            ...prev,
            [id]: {
              ...cur,
              bars: merged,
              lookbackDays: next,
              noMoreHistory: earliest != null && oldestPrev != null && earliest >= oldestPrev,
            },
          };
        });
      })
      .catch(() => {
        setCharts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], noMoreHistory: true } } : prev));
      })
      .finally(() => {
        loadingMoreRef.current[id] = false;
        setCharts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], loadingMore: false } } : prev));
      });
  }, [charts]);

  const handleEdgeCleared = useCallback((id: PanelId) => {
    setCharts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], noMoreHistory: false } } : prev));
  }, []);

  const setChartSymbol = useCallback((id: PanelId, symbol: string) => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setCharts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], symbol: sym } } : prev));
    if (id === PRIMARY_CHART_ID) setActive(sym);
  }, []);

  const setChartInterval = useCallback((id: PanelId, interval: string) => {
    setCharts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], interval } } : prev));
  }, []);

  // Selecting a symbol in the watchlist drives the primary chart.
  const handleSelectSymbol = useCallback((sym: string) => {
    setActive(sym);
    setCharts((prev) =>
      prev[PRIMARY_CHART_ID] ? { ...prev, [PRIMARY_CHART_ID]: { ...prev[PRIMARY_CHART_ID], symbol: sym } } : prev
    );
  }, []);

  // Indicator management (per chart instance)
  const addIndicator = useCallback(async (id: PanelId, type: string, period: number, color: string) => {
    const c = charts[id];
    if (!c) return;
    try {
      const d = await api.indicators(c.symbol, type, period, c.interval, 60);
      const ind: IndicatorOverlay = {
        id: `${type}-${period}-${Date.now()}`,
        type: type as IndicatorOverlay["type"],
        period,
        data: d.series,
        color: color || "#ffffff",
      };
      setCharts((prev) =>
        prev[id]
          ? { ...prev, [id]: { ...prev[id], indicators: [...prev[id].indicators, ind], chartError: "" } }
          : prev
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to add indicator";
      setCharts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], chartError: msg } } : prev));
    }
  }, [charts]);

  const removeIndicator = useCallback((id: PanelId, indId: string) => {
    setCharts((prev) =>
      prev[id]
        ? { ...prev, [id]: { ...prev[id], indicators: prev[id].indicators.filter((i) => i.id !== indId) } }
        : prev
    );
  }, []);

  const handlePlaceOrder = useCallback(async (req: {
    symbol: string; side: string; qty: number;
    order_type?: string; limit_price?: number | null; stop_price?: number | null;
  }) => {
    const placed = await api.placeOrder(req);
    await refreshOrders();
    await refreshPortfolio();
    return placed;
  }, [refreshOrders, refreshPortfolio]);

  const handleCancelOrder = useCallback(async (orderId: string) => {
    await api.cancelOrder(orderId);
    await refreshOrders();
  }, [refreshOrders]);

  const handleAddSymbol = useCallback(async (sym: string): Promise<string | null> => {
    try {
      const d = await api.addWatchlist(sym);
      setSymbols(d.symbols);
      refreshQuotes();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Failed to add symbol";
    }
  }, [refreshQuotes]);

  const handleRemoveSymbol = useCallback(async (sym: string) => {
    try { const d = await api.removeWatchlist(sym); setSymbols(d.symbols); } catch { /* ignore */ }
  }, []);

  const handleReorderSymbols = useCallback(async (order: string[]) => {
    setSymbols(order);
    try { const d = await api.reorderWatchlist(order); setSymbols(d.symbols); } catch { /* keep local order */ }
  }, []);

  const handleReset = useCallback(async () => {
    await refreshPortfolio();
    await refreshOrders();
    setBacktest(null);
  }, [refreshPortfolio, refreshOrders]);

  const primaryChart = charts[PRIMARY_CHART_ID];
  const latestPrice =
    primaryChart && primaryChart.bars.length > 0
      ? primaryChart.bars[primaryChart.bars.length - 1].close
      : null;
  const positions = portfolio ? Object.values(portfolio.positions) : [];
  const trades = portfolio ? [...portfolio.trades].reverse() : [];

  // ── Hub view ──────────────────────────────────────────────────────────────
  if (windowType === "hub" || (windowType !== "detached" && hubOpen && !isElectron)) {
    return (
      <div className="h-full w-full">
        <PortfolioHub
          portfolios={portfolios}
          onOpen={handleOpenPortfolio}
          onCreate={handleCreatePortfolio}
          onRename={handleRenamePortfolio}
          onDelete={handleDeletePortfolio}
          onExport={handleExportPortfolio}
          onImport={handleImportPortfolio}
        />
        {booting && <BootOverlay status={bootStatus} />}
      </div>
    );
  }

  // ── Portfolio / Trading view ──────────────────────────────────────────────
  return (
    <div className="bg-app flex h-full flex-col">
      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <div className="bg-panel relative flex h-7 shrink-0 items-center gap-2 border-0 border-b border-[var(--border)] px-2">
        {!isElectron && (
          <button
            onClick={() => setHubOpen(true)}
            className="border border-[var(--accent)] bg-transparent px-2 py-0.5 text-[9px] font-bold text-accent hover:bg-accent-soft"
            title="Back to portfolios"
          >
            &lt; HUB
          </button>
        )}
        <span className="text-primary text-[10px] font-bold tracking-wider">
          {currentPortfolioName()}
        </span>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <MarketClock market={market} clock={clock} />
        </div>
        <div className="flex-1" />
        <PanelsMenu counts={panelCounts} onAdd={handleAddPanel} />
        <span className="text-quaternary text-[9px] tracking-widest">DELTA VANTAGE</span>
      </div>

      {/* ── Mosaic panel layout ───────────────────────────────────────────── */}
      <MosaicLayout
        state={mosaic}
        onStateChange={setMosaic}
        onDetachPanel={handleDetach}
        renderPanel={(panelId) => {
          const type = panelTypeOf(panelId);
          switch (type) {
            case "watchlist":
              return {
                body: (
                  <TickerSidebar
                    symbols={symbols}
                    active={active}
                    onSelect={handleSelectSymbol}
                    onRemove={handleRemoveSymbol}
                    onAdd={handleAddSymbol}
                    onReorder={handleReorderSymbols}
                    quotes={quotes}
                    dragId={panelId}
                    liveStrategies={liveStrategies}
                    onDropStrategy={(strategy, symbol) => {
                      setLiveModal({ strategy, symbol });
                      setLiveError("");
                    }}
                  />
                ),
              };
            case "chart": {
              const c = charts[panelId] ?? makeChartInstance(active, defaultInterval);
              return {
                toolbar: (
                  <div className="bg-panel border-0 border-b border-[var(--border)] flex h-8 shrink-0 items-center gap-1 px-2">
                    <EditableSymbol value={c.symbol} onCommit={(s) => setChartSymbol(panelId, s)} />
                    {c.bars.length > 0 && (
                      <span className="text-primary font-mono text-[11px] font-bold">
                        {c.bars[c.bars.length - 1].close.toFixed(2)}
                      </span>
                    )}
                    <div className="h-3 w-px bg-[var(--border)] mx-1" />
                    <div className="flex h-full items-center">
                      {INTERVALS.map((iv) => (
                        <button
                          key={iv}
                          onClick={() => setChartInterval(panelId, iv)}
                          className={`h-full border-0 border-b-2 px-2 text-[9px] font-semibold ${
                            iv === c.interval
                              ? "border-b-[var(--accent)] text-accent"
                              : "border-transparent text-secondary hover:text-primary"
                          }`}
                        >
                          {iv}
                        </button>
                      ))}
                    </div>
                    <div className="flex-1" />
                    <NextBarCountdown interval={c.interval} clock={clock} market={market} crypto={c.symbol.includes("/")} />
                    <div className="h-3 w-px bg-[var(--border)] mx-2" />
                    <IndicatorDropdown
                      onAdd={(t, p, col) => addIndicator(panelId, t, p, col)}
                    />
                    {c.indicators.length > 0 && (
                      <div className="flex items-center gap-1 ml-1">
                        {c.indicators.map((ind) => (
                          <button
                            key={ind.id}
                            onClick={() => removeIndicator(panelId, ind.id)}
                            className="border-0 bg-transparent text-[8px] font-semibold uppercase px-1 py-0 hover:text-down"
                            style={{ color: ind.color }}
                            title={`Remove ${ind.type} ${ind.period}`}
                          >
                            {ind.type.toUpperCase()}({ind.period}) x
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ),
                body: (
                  <>
                    {c.chartError && (
                      <div className="bg-down-soft text-down px-3 py-1 text-[10px]">{c.chartError}</div>
                    )}
                    {c.loading ? (
                      <div className="text-secondary flex h-full items-center justify-center text-[11px]">Loading...</div>
                    ) : (
                      <PriceChart
                        bars={c.bars}
                        symbol={c.symbol}
                        theme={theme}
                        onNeedOlder={() => handleNeedOlder(panelId)}
                        onEdgeCleared={() => handleEdgeCleared(panelId)}
                        indicators={c.indicators}
                        noMoreData={c.noMoreHistory}
                        loadingMore={c.loadingMore}
                        trades={portfolio?.trades.filter((t) => t.symbol === c.symbol) ?? []}
                        resetKey={`${panelId}:${c.symbol}:${c.interval}`}
                      />
                    )}
                  </>
                ),
              };
            }
            case "trade":
              return {
                body: (
                  <OrderPanel
                    symbol={active}
                    latestPrice={latestPrice}
                    cash={portfolio?.cash ?? 0}
                    buyingPower={portfolio?.buying_power ?? portfolio?.cash ?? 0}
                    shortBuyingPower={portfolio?.short_buying_power ?? 0}
                    position={portfolio?.positions[active] ?? null}
                    maxOrderQty={settings?.max_order_qty ?? Infinity}
                    shareIncrement={settings?.share_increment ?? 1}
                    quote={quotes[active] ?? null}
                    liveStrategies={liveStrategies.filter((l) => l.symbol === active)}
                    onStopLiveStrategy={handleStopLiveStrategy}
                    onStopAllLiveStrategies={handleStopAllLiveStrategies}
                    onPlaceOrder={handlePlaceOrder}
                  />
                ),
              };
            case "strategy":
              return {
                body: (
                  <StrategyView
                    refreshPortfolio={refreshPortfolio}
                    onBacktestComplete={handleBacktestComplete}
                    portfolioId={currentPortfolioId()}
                    runSignal={runSignal}
                    liveStrategies={liveStrategies}
                    onStopLiveStrategy={handleStopLiveStrategy}
                  />
                ),
              };
            case "performance":
              return {
                body: (
                  <PerformanceView
                    portfolio={portfolio}
                    positions={positions}
                    orders={orders}
                    trades={trades}
                    perfPoints={perfPoints}
                    onCancelOrder={handleCancelOrder}
                  />
                ),
              };
            case "backtest":
              return {
                body: (
                  <BacktestView
                    result={backtest}
                    saved={savedBacktests}
                    onLoadRun={handleLoadSavedRun}
                    onDeleteRun={handleDeleteSavedRun}
                    onRunNew={() => {
                      ensurePanelOfType("strategy");
                      setRunSignal((n) => n + 1);
                    }}
                  />
                ),
              };
          }
        }}
      />

      <StatusBar
        portfolio={portfolio}
        onOpenSettings={() => setShowSettings(true)}
      />

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onThemeChange={setTheme}
        onAccountReset={handleReset}
      />

      <LiveStrategyModal
        open={liveModal != null}
        strategy={liveModal?.strategy ?? ""}
        symbol={liveModal?.symbol ?? ""}
        busy={liveBusy}
        error={liveError}
        defaultInterval={settings?.default_interval ?? "15Min"}
        onCancel={() => setLiveModal(null)}
        onStart={handleStartLiveStrategy}
      />
    </div>
  );
}

// ── Add panel menu ──────────────────────────────────────────────────────────

function BootOverlay({ status }: { status: string }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70">
      <style>{`
        @keyframes dv-indeterminate {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
        .dv-indeterminate {
          transform: translateX(-100%);
          animation: dv-indeterminate 1.4s ease-in-out infinite;
        }
      `}</style>
      <div className="bg-panel w-72 border border-[var(--border)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
          <span className="text-[9px] font-bold uppercase tracking-widest text-primary">Delta Vantage</span>
          <span className="text-[8px] font-semibold uppercase tracking-widest text-accent">booting</span>
        </div>
        <div className="px-4 py-5">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-tertiary">
            status <span className="text-accent normal-case tracking-normal">{status}</span>
          </div>
          <div className="h-2 w-full overflow-hidden border border-[var(--border)] bg-[#222222]">
            <div className="dv-indeterminate h-full w-[30%] bg-[var(--accent)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── PanelsMenu ─────────────────────────────────────────────────────────────

function PanelsMenu({ counts, onAdd }: { counts: Record<PanelType, number>; onAdd: (panel: PanelType) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="relative mr-1" ref={boxRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[11px] font-bold text-secondary hover:text-primary"
        title="Add panel"
      >
        +
      </button>
      {open && (
        <div className="bg-panel border border-[var(--border-strong)] absolute right-0 top-full z-50 mt-1 w-44 shadow-lg">
          <div className="border-b border-[var(--border)] px-2 py-1">
            <span className="text-secondary text-[8px] font-semibold uppercase tracking-widest">Add Panel</span>
          </div>
          {PANEL_TYPES.map((p) => (
            <button
              key={p}
              onClick={() => {
                setOpen(false);
                onAdd(p);
              }}
              className="flex w-full items-center justify-between border-0 bg-transparent px-2 py-1 text-left text-[10px] text-primary hover:bg-panel2 hover:underline"
              title={`Add another ${PANEL_LABELS[p]}`}
            >
              <span>{PANEL_LABELS[p]}</span>
              <span className="text-accent font-mono text-[9px]">{counts[p]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Editable symbol label ───────────────────────────────────────────────────

function EditableSymbol({ value, onCommit }: { value: string; onCommit: (s: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-primary hover:text-accent border-0 bg-transparent px-1 text-[11px] font-bold tracking-wider"
        title="Click to change symbol"
      >
        {value}
      </button>
    );
  }

  const commit = () => {
    const s = draft.trim().toUpperCase();
    if (s) onCommit(s);
    setEditing(false);
  };

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      className="border border-[var(--accent)] bg-editor px-1 text-[11px] font-bold tracking-wider text-primary outline-none"
    />
  );
}

// ── Next-bar countdown ──────────────────────────────────────────────────────

// When the next bar actually arrives depends on the market session:
//  - Intraday while open: epoch-aligned candle boundary.
//  - Intraday while closed/pre/post, and daily bars: next market open.
function nextBarTarget(interval: string, now: Date, market: MarketStatus | null, crypto = false): number | null {
  // Crypto trades 24/7 — the next candle is always the next epoch-aligned boundary.
  if (crypto) {
    if (interval === "1Day") {
      // Daily crypto candle: next midnight UTC.
      const t = new Date(now);
      t.setUTCHours(24, 0, 0, 0);
      return t.getTime();
    }
    return nextBarTime(interval, now);
  }
  // Intraday bars while the (equity) market is open: epoch-aligned boundary.
  if (interval !== "1Day" && market?.status === "open") {
    return nextBarTime(interval, now);
  }
  // 1Day bars, and intraday bars while the market is closed: next session open.
  // We compute the next weekday open (09:30 ET) relative to `now` in ET time.
  try {
    const zone = "America/New_York";
    const etNow = new Date(now.toLocaleString("en-US", { timeZone: zone }));
    const openToday = new Date(etNow);
    openToday.setHours(9, 30, 0, 0);
    if (etNow.getDay() >= 1 && etNow.getDay() <= 5 && etNow < openToday) {
      const t = openToday.getTime();
      if (!Number.isNaN(t)) return t;
    }
    // Otherwise find the next weekday.
    let d = new Date(now);
    let day = d.getDay();
    let add = (day === 5 ? 3 : day === 6 ? 2 : day === 0 ? -1 : 1);
    // Add days until a weekday; careful around weekend.
    do {
      d = new Date(now);
      d.setDate(d.getDate() + add);
      day = d.getDay();
      if (day >= 1 && day <= 5) break;
      add++;
    } while (true);
    const t = new Date(d.toLocaleString("en-US", { timeZone: zone }));
    t.setHours(9, 30, 0, 0);
    const ts = t.getTime();
    if (!Number.isNaN(ts)) return ts;
  } catch { /* zoneinfo/date handling unavailable */ }
  return null;
}

function nextBarTime(interval: string, now: Date): number {
  const ms = now.getTime();
  const mins = interval === "1Min" ? 1
    : interval === "5Min" ? 5
      : interval === "15Min" ? 15
        : interval === "1Hour" ? 60
          : interval === "1Day" ? 1440
            : 15;
  const period = mins * 60 * 1000;
  return Math.ceil(ms / period) * period;
}

function NextBarCountdown({ interval, clock, market, crypto = false }: { interval: string; clock: Date; market: MarketStatus | null; crypto?: boolean }) {
  const target = nextBarTarget(interval, clock, market, crypto);
  if (target == null) return null;
  let ms = target - clock.getTime();
  if (ms <= 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const countingToOpen = !crypto && (interval === "1Day" || market?.status !== "open");
  const label = countingToOpen ? "OPEN" : interval.replace("Min", "M").replace("Hour", "H");
  const text = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return (
    <span className="text-accent flex shrink-0 items-center gap-1 text-[9px] font-bold tracking-wider" title={countingToOpen ? `Market opens in ${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `Next ${interval} bar starts in ${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`}>
      <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
        <path d="M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1zm0 1v4l3 1.8-.6 1-3.4-2V2H6z" />
      </svg>
      NEXT {label} IN {text}
    </span>
  );
}

// ── Indicator dropdown ─────────────────────────────────────────────────────

function IndicatorDropdown({ onAdd }: { onAdd: (type: string, period: number, color: string) => void }) {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState(20);
  const [selectedType, setSelectedType] = useState("sma");
  const [color, setColor] = useState("#ffaa00");

  const indicators = [
    { type: "sma", label: "SMA", defaultPeriod: 20, defaultColor: "#ffaa00" },
    { type: "ema", label: "EMA", defaultPeriod: 20, defaultColor: "#ff6600" },
    { type: "bollinger", label: "BB", defaultPeriod: 20, defaultColor: "#cc66cc" },
    { type: "vwap", label: "VWAP", defaultPeriod: 20, defaultColor: "#00cccc" },
  ];
  const IND_PRESET_COLORS = ["#ffaa00", "#ff6600", "#cc66cc", "#00cccc", "#00ff41", "#ff3333", "#ffffff", "#66b3ff"];

  const handleAdd = () => {
    onAdd(selectedType, period, color);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="border-0 bg-transparent text-[9px] font-semibold text-secondary hover:text-accent px-1"
      >
        +IND
      </button>
      {open && (
        <div className="bg-panel border border-[var(--border-strong)] absolute right-0 top-full z-50 mt-1 w-52">
          <div className="border-b border-[var(--border)] px-2 py-1">
            <span className="text-secondary text-[8px] font-semibold uppercase tracking-widest">Add Indicator</span>
          </div>
          <div className="p-2 space-y-1.5">
            <select
              value={selectedType}
              onChange={(e) => {
                setSelectedType(e.target.value);
                const ind = indicators.find((i) => i.type === e.target.value);
                if (ind) {
                  setPeriod(ind.defaultPeriod);
                  setColor(ind.defaultColor);
                }
              }}
              className="border border-[var(--border)] bg-editor w-full px-1.5 py-1 text-[10px] text-primary outline-none"
            >
              {indicators.map((ind) => (
                <option key={ind.type} value={ind.type}>{ind.label}</option>
              ))}
            </select>
            <input
              type="number"
              value={period}
              min={1}
              onChange={(e) => setPeriod(parseInt(e.target.value, 10) || 20)}
              className="border border-[var(--border)] bg-editor w-full px-1.5 py-1 text-[10px] text-primary outline-none"
              placeholder="Period"
            />
            <div>
              <div className="text-tertiary mb-1 flex items-center justify-between text-[8px]">
                <span className="font-semibold uppercase tracking-widest">Color</span>
                <span className="font-mono" style={{ color }}>{color}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {IND_PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`h-5 w-5 border ${color === c ? "border-white" : "border-[var(--border)]"}`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-5 w-7 border-0 bg-transparent p-0"
                  title="Custom color"
                />
              </div>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setOpen(false)}
                className="flex-1 border border-[var(--border)] bg-transparent py-1 text-[9px] text-secondary"
              >
                CANCEL
              </button>
              <button
                onClick={handleAdd}
                className="flex-1 border border-[var(--accent)] bg-transparent py-1 text-[9px] font-bold text-accent"
              >
                ADD
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MarketClock ────────────────────────────────────────────────────────────

function MarketClock({ market, clock }: { market: MarketStatus | null; clock: Date }) {
  const isOpen = market?.status === "open";
  const color = isOpen
    ? "var(--up)"
    : market?.status === "pre" || market?.status === "post"
      ? "var(--accent)"
      : "var(--down)";
  const label = market ? market.status.toUpperCase() : "--";
  const time = clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = clock.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
  return (
    <div
      className="pointer-events-auto flex shrink-0 items-center gap-2 font-mono"
      title={market ? `${market.exchange} ${market.reason} · next open ${market.next_open}` : "Market status unavailable"}
    >
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[9px] font-bold tracking-widest" style={{ color }}>
          {label}
        </span>
      </span>
      <span className="text-tertiary text-[9px]">{time}</span>
      <span className="text-tertiary text-[9px]">{date}</span>
    </div>
  );
}

// ── StatusBar ────────────────────────────────────────────────────────────────

function StatusBar({ portfolio, onOpenSettings }: {
  portfolio: Portfolio | null;
  onOpenSettings: () => void;
}) {
  return (
    <div className="bg-panel flex h-7 shrink-0 items-center gap-3 border-0 border-t border-[var(--border)] px-3 text-[10px]">
      {!portfolio ? (
        <>
          <span className="text-secondary">Loading...</span>
          <div className="flex-1" />
        </>
      ) : (
        <AccountStats portfolio={portfolio} />
      )}

      <div className="flex-1" />

      <button
        onClick={onOpenSettings}
        className="text-secondary hover:text-primary flex h-5 w-5 shrink-0 items-center justify-center border-0 bg-transparent"
        title="Settings"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.62l-1.92-3.32a.49.49 0 0 0-.6-.22l-2.39.96a7.04 7.04 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.42h-3.84a.48.48 0 0 0-.48.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.6.22L2.36 8.84c-.14.21-.07.47.12.62l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.62l1.92 3.32c.13.24.37.31.6.22l2.38-.96c.5.38 1.04.71 1.63.95l.37 2.54c.04.24.25.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54a7.03 7.03 0 0 0 1.62-.95l2.39.96c.23.09.47.02.6-.22l1.92-3.32c.12-.21.07-.47-.12-.62l-2.03-1.58zM12 15.58A3.55 3.55 0 1 1 12 8.5a3.55 3.55 0 0 1 0 7.08z"/>
        </svg>
      </button>
    </div>
  );
}

function AccountStats({ portfolio }: { portfolio: Portfolio }) {
  const pnl = portfolio.unrealized_pnl + portfolio.realized_pnl;
  const pnlPct = portfolio.total_value > 0
    ? (pnl / (portfolio.total_value - pnl)) * 100
    : 0;
  const pnlColor = pnl >= 0 ? "text-up" : "text-down";

  return (
    <>
      <span className="text-secondary">
        CASH <span className="font-mono text-tertiary">{fmt(portfolio.cash)}</span>
      </span>
      <span className="text-secondary">
        INV <span className="font-mono text-tertiary">{fmt(portfolio.invested)}</span>
      </span>
      <span className="text-secondary">
        EQ <span className="font-mono text-primary font-bold">{fmt(portfolio.total_value)}</span>
      </span>
      <div className="h-3 w-px bg-[var(--border)]" />
      <span className={`${pnlColor} font-mono font-bold`}>
        P&L {pnl >= 0 ? "+" : ""}{fmt(pnl)} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
      </span>
      <div className="h-3 w-px bg-[var(--border)]" />
      <span className="text-secondary">
        POS <span className="font-mono text-tertiary">{portfolio.num_positions}</span>
      </span>
      <span className="text-secondary">
        TRD <span className="font-mono text-tertiary">{portfolio.num_trades}</span>
      </span>
    </>
  );
}

// ── Performance view ──────────────────────────────────────────────────────────

function RoundTripTable({ trips, limit, expanded, onToggle }: {
  trips: RoundTrip[];
  limit?: number;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  if (trips.length === 0) return null;
  const lim = limit ?? Infinity;
  const shown = expanded ? trips : trips.slice(0, lim);
  const totalPnl = trips.reduce((s, r) => s + r.pnl, 0);
  return (
    <section>
      <SubHeader title="Closed Round Trips (Buy @ - Sell @)" count={trips.length} />
      <div className="text-secondary px-3 py-0.5 text-[9px]">
        NET P&L <span className={totalPnl >= 0 ? "text-up" : "text-down"}>{totalPnl >= 0 ? "+" : ""}${fmt(totalPnl)}</span>
      </div>
      <Collapse count={trips.length} limit={lim} expanded={!!expanded} onToggle={onToggle} label="ROUND TRIPS">
        <table className="w-full text-[10px]">
          <thead>
            <tr>
              <Th>Symbol</Th><Th right>Qty</Th><Th right>Buy @</Th>
              <Th right>Sell @</Th><Th right>P&L</Th><Th right>P&L %</Th><Th>Opened</Th><Th>Closed</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                <td className="text-primary font-bold">{r.symbol}</td>
                <td className="text-right font-mono">{r.qty}</td>
                <td className="text-right font-mono text-up">${r.buyPrice.toFixed(2)}</td>
                <td className="text-right font-mono text-down">${r.sellPrice.toFixed(2)}</td>
                <td className={`text-right font-mono ${r.pnl >= 0 ? "text-up" : "text-down"}`}>
                  {r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)}
                </td>
                <td className={`text-right font-mono ${r.pnlPct >= 0 ? "text-up" : "text-down"}`}>
                  {r.pnlPct >= 0 ? "+" : ""}{r.pnlPct.toFixed(2)}%
                </td>
                <td className="text-secondary">{new Date(r.openedAt).toLocaleDateString()}</td>
                <td className="text-secondary">{new Date(r.closedAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Collapse>
    </section>
  );
}

function PerformanceView({
  portfolio,
  positions,
  orders,
  trades,
  perfPoints,
  onCancelOrder,
}: {
  portfolio: Portfolio | null;
  positions: Position[];
  orders: Order[];
  trades: Trade[];
  perfPoints: PerfPoint[];
  onCancelOrder?: (orderId: string) => Promise<void>;
}) {
  const unrealized = portfolio?.unrealized_pnl ?? 0;
  const realized = portfolio?.realized_pnl ?? 0;
  const pnl = unrealized + realized;
  return (
    <div>
      {/* Summary strip */}
      <div className="flex items-center gap-4 border-0 border-b border-[var(--border)] px-3 py-1.5">
        <Mini label="UNRL P&L" value={`${unrealized >= 0 ? "+" : ""}$${fmt(unrealized)}`} color={unrealized >= 0 ? "var(--up)" : "var(--down)"} />
        <Mini label="RLZD P&L" value={`${realized >= 0 ? "+" : ""}$${fmt(realized)}`} color={realized >= 0 ? "var(--up)" : "var(--down)"} />
        <Mini label="TOTAL" value={`${pnl >= 0 ? "+" : ""}$${fmt(pnl)}`} color={pnl >= 0 ? "var(--up)" : "var(--down)"} />
        <Mini label="EQUITY" value={`$${fmt(portfolio?.total_value ?? 0)}`} />
        <Mini label="CASH" value={`$${fmt(portfolio?.cash ?? 0)}`} />
      </div>

      <SubHeader title="Equity Over Time" />
      <LiveEquityChart points={perfPoints} currentEquity={portfolio?.total_value ?? 0} />

      <SubHeader title="Positions" count={positions.length} />
      {positions.length === 0 ? (
        <EmptyState message="No open positions" />
      ) : (
        <table className="w-full text-[10px]">
          <thead>
            <tr>
              <Th>Symbol</Th><Th right>Qty</Th><Th right>Avg Entry</Th><Th right>Current</Th>
              <Th right>Mkt Val</Th><Th right>P&L</Th><Th right>P&L %</Th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const c = p.unrealized_pnl >= 0 ? "text-up" : "text-down";
              return (
                <tr key={p.symbol}>
                  <td className="text-primary font-bold">{p.symbol}</td>
                  <td className="text-right font-mono">
                  {p.qty < 0 ? (
                    <span className="text-[var(--down)]">SHORT {Math.abs(p.qty)}</span>
                  ) : (
                    <span>{p.qty}</span>
                  )}
                </td>
                  <td className="text-right font-mono">${p.avg_entry_price.toFixed(2)}</td>
                  <td className="text-right font-mono">${p.current_price.toFixed(2)}</td>
                  <td className="text-right font-mono">${p.market_value.toFixed(2)}</td>
                  <td className={`text-right font-mono ${c}`}>${p.unrealized_pnl.toFixed(2)}</td>
                  <td className={`text-right font-mono ${c}`}>{p.unrealized_pnl_pct.toFixed(2)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <SubHeader title="Open Orders" count={orders.filter((o) => o.status === "pending").length} />
      {orders.length === 0 ? (
        <EmptyState message="No orders" />
      ) : (
        <table className="w-full text-[10px]">
          <thead>
            <tr>
              <Th>Symbol</Th><Th>Side</Th><Th>Type</Th><Th right>Qty</Th>
              <Th right>Fill</Th><Th>Status</Th><Th>Time</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="text-primary font-bold">{o.symbol}</td>
                <td className={o.side === "buy" ? "text-up" : "text-down"}>{o.side.toUpperCase()}</td>
                <td className="text-secondary">{o.order_type}</td>
                <td className="text-right font-mono">{o.qty}</td>
                <td className="text-right font-mono">
                  {o.fill_price != null ? `$${o.fill_price.toFixed(2)}` : "--"}
                </td>
                <td><StatusBadge status={o.status} /></td>
                <td className="text-secondary">
                  {o.created_at ? new Date(o.created_at).toLocaleString() : "--"}
                </td>
                <td>
                  {o.status === "pending" && onCancelOrder && (
                    <button
                      onClick={() => onCancelOrder(o.id)}
                      className="border-0 bg-transparent px-1 text-[8px] font-bold text-tertiary hover:text-down"
                      title={`Cancel ${o.symbol} ${o.order_type} ${o.side} ${o.qty}`}
                    >
                      CANCEL
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SubHeader title="Trade History" count={trades.length} />
      <RoundTripTable trips={computeRoundTrips(trades)} />
      {trades.length === 0 ? (
        <EmptyState message="No trades yet" />
      ) : (
        <table className="w-full text-[10px]">
          <thead>
            <tr>
              <Th>Time</Th><Th>Symbol</Th><Th>Side</Th><Th right>Qty</Th><Th right>Price</Th><Th right>Value</Th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={`${t.order_id}-${i}`}>
                <td className="text-secondary">{new Date(t.timestamp).toLocaleString()}</td>
                <td className="text-primary font-bold">{t.symbol}</td>
                <td className={t.side === "buy" ? "text-up" : "text-down"}>{t.side.toUpperCase()}</td>
                <td className="text-right font-mono">{t.qty}</td>
                <td className="text-right font-mono">${t.price.toFixed(2)}</td>
                <td className="text-right font-mono">${(t.qty * t.price).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Live equity chart ─────────────────────────────────────────────────────

function LiveEquityChart({ points, currentEquity }: {
  points: PerfPoint[]; currentEquity: number;
}) {
  const dataRaw = points.length > 0
    ? points
    : [{ t: 0, equity: currentEquity, cash: currentEquity }];
  const data = downsample(dataRaw, 500);

  const first = data[0].equity;
  const last = data[data.length - 1].equity;
  const up = last >= first;
  const color = up ? "var(--up)" : "var(--down)";

  const W = 800;
  const H = 100;
  const vals = data.map((p) => p.equity);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 4;
  const stepX = W / Math.max(data.length - 1, 1);
  const line = data.map((p, i) => {
    const x = i * stepX;
    const y = H - pad - ((p.equity - min) / range) * (H - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `0,${H} ${line} ${W},${H}`;

  return (
    <div className="border-0 border-b border-[var(--border)] py-1 pr-2 pl-1">
      <div className="text-secondary mb-0.5 flex items-center justify-between px-2 text-[8px]">
        <span>EQUITY</span>
        <span className="font-mono">${fmt(first)} &rarr; ${fmt(last)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[80px] w-full">
        <polygon points={area} fill={color} opacity="0.1" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    </div>
  );
}

// ── Backtest report ──────────────────────────────────────────────────────────

function BacktestView({
  result,
  saved = [],
  onLoadRun,
  onDeleteRun,
  onRunNew,
}: {
  result: BacktestResult | null;
  saved: import("./lib/types").BacktestSummary[];
  onLoadRun: (bid: string) => void;
  onDeleteRun: (bid: string) => void;
  onRunNew: () => void;
}) {
  const [selId, setSelId] = useState("");
  const [exportSel, setExportSel] = useState("");
  const [expandLogs, setExpandLogs] = useState(false);
  const [expandTrips, setExpandTrips] = useState(false);
  const [expandTrades, setExpandTrades] = useState(false);

  useEffect(() => {
    if (!saved.some((b) => b.id === selId)) setSelId("");
  }, [saved, selId]);

  const handleSelect = (bid: string) => {
    setSelId(bid);
    if (bid) onLoadRun(bid);
  };

  const m = result?.metrics;
  const p = result?.portfolio ?? null;
  const pnl = p?.realized_pnl ?? 0;
  const startValue = result && result.equity.length > 0 ? result.equity[0].v : p?.total_value ?? 0;
  const pct = p && startValue > 0 ? (p.total_value / startValue - 1) * 100 : 0;

  return (
    <div>
      {/* Compact toolbar: backtest label, saved-run loader, export, run-new */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-0 border-b border-[var(--border)] bg-panel px-2 py-1">
        <span className="text-secondary text-[9px] font-bold uppercase tracking-widest">BACKTEST</span>
        {result && (
          <span className="text-primary text-[10px] font-bold">
            {result.symbol}/{result.interval}
          </span>
        )}
        <select
          value={selId}
          onChange={(e) => handleSelect(e.target.value)}
          className="border border-[var(--border)] bg-editor max-w-[170px] shrink px-1.5 py-0.5 text-[9px] text-primary outline-none"
          title="Load a saved run"
        >
          <option value="">
            {saved.length === 0 ? "No saved runs" : "Load saved run..."}
          </option>
          {saved.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label || b.id.slice(0, 8)}
            </option>
          ))}
        </select>
        {selId && (
          <button
            onClick={() => {
              onDeleteRun(selId);
              setSelId("");
            }}
            className="border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[8px] text-tertiary hover:text-down"
            title="Delete the selected saved run"
          >
            X
          </button>
        )}
        {result && (
          <select
            value={exportSel}
            onChange={(e) => {
              const k = e.target.value;
              setExportSel("");
              if (k && buildExports(result)[k]) downloadExport(buildExports(result)[k]);
            }}
            className="border border-[var(--border)] bg-editor px-1.5 py-0.5 text-[9px] text-secondary outline-none"
            title="Export this run"
          >
            <option value="">EXPORT</option>
            <option value="json">JSON (full run)</option>
            <option value="trades">CSV (trades)</option>
            <option value="equity">CSV (equity curve)</option>
          </select>
        )}
        <div className="flex-1" />
        <span className="text-tertiary font-mono text-[8px]">
          {result ? `${result.bars_processed.toLocaleString()} bars · ${(result.runtime_ms / 1000).toFixed(2)}s` : ""}
        </span>
        <button
          onClick={onRunNew}
          className="border border-[var(--accent)] bg-transparent px-2 py-0.5 text-[9px] font-bold text-accent hover:bg-accent-soft"
        >
          RUN NEW
        </button>
      </div>

      {result && m && (
        <div className="grid grid-cols-4 gap-x-3 gap-y-1.5 border-0 border-b border-[var(--border)] bg-panel2 px-3 py-1.5 xl:grid-cols-6">
          <Metric label="Final" value={`$${fmt(p!.total_value)}`} />
          <Metric label="Cash" value={`$${fmt(p!.cash)}`} />
          <Metric label="P&L" value={`${pnl >= 0 ? "+" : ""}$${fmt(pnl)}`} color={pnl >= 0 ? "var(--up)" : "var(--down)"} />
          <Metric label="Return" value={`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`} color={pct >= 0 ? "var(--up)" : "var(--down)"} />
          <Metric label="Ann. Return" value={`${m.annualized_return_pct >= 0 ? "+" : ""}${m.annualized_return_pct.toFixed(2)}%`} color={m.annualized_return_pct >= 0 ? "var(--up)" : "var(--down)"} />
          <Metric label="Trades" value={String(result.trade_count)} />
          <Metric label="Sharpe" value={m.sharpe_ratio.toFixed(2)} />
          <Metric label="Sortino" value={m.sortino_ratio.toFixed(2)} />
          <Metric label="Max DD" value={`${m.max_drawdown_pct.toFixed(2)}%`} color="var(--down)" />
          <Metric label="Profit Factor" value={m.profit_factor == null ? "∞" : m.profit_factor.toFixed(2)} />
          <Metric label="Win Rate" value={`${(m.win_rate * 100).toFixed(1)}%`} />
          <Metric label="Avg Trade" value={fmt(m.avg_trade)} />
          <Metric label="Best Trade" value={`+$${fmt(m.best_trade)}`} color="var(--up)" />
          <Metric label="Worst Trade" value={`$${fmt(m.worst_trade)}`} color="var(--down)" />
          <Metric label="Exposure" value={`${m.exposure_pct.toFixed(1)}%`} />
          <Metric label="DD Duration" value={`${m.max_drawdown_duration} bars`} />
        </div>
      )}

      {!result ? (
        <div>
          {saved.length === 0 ? (
            <EmptyState message="No saved backtests yet. Run one from the Strategy panel or load a saved run here." />
          ) : (
            <table className="w-full text-[10px]">
              <thead>
                <tr>
                  <Th>Run</Th><Th>Strategy</Th><Th>Symbol</Th><Th right>Return</Th>
                  <Th right>Sharpe</Th><Th right>Win%</Th><Th right>Trades</Th><Th>Saved</Th><th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {saved.map((b) => (
                  <tr key={b.id} className="hover:bg-panel2">
                    <td className="text-primary font-bold">{b.label || b.id.slice(0, 8)}</td>
                    <td className="text-secondary">{b.strategy}.py</td>
                    <td>{b.symbol}</td>
                    <td className={`text-right font-mono ${(b.total_return_pct ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                      {(b.total_return_pct ?? 0) >= 0 ? "+" : ""}{(b.total_return_pct ?? 0).toFixed(2)}%
                    </td>
                    <td className="text-right font-mono">{(b.sharpe_ratio ?? 0).toFixed(2)}</td>
                    <td className="text-right font-mono">{((b.win_rate ?? 0) * 100).toFixed(1)}%</td>
                    <td className="text-right font-mono">{b.trade_count}</td>
                    <td className="text-secondary">{new Date(b.ts).toLocaleString()}</td>
                    <td>
                      <div className="flex gap-1">
                        <button
                          onClick={() => onLoadRun(b.id)}
                          className="border border-[var(--accent)] bg-transparent px-1.5 py-0.5 text-[8px] font-bold text-accent hover:bg-accent-soft"
                        >
                          LOAD
                        </button>
                        <button
                          onClick={() => onDeleteRun(b.id)}
                          className="border-0 bg-transparent px-1 text-[9px] text-tertiary hover:text-down"
                        >
                          x
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <>
          <div className="border-0 border-b border-[var(--border)] p-2">
            <BacktestEquityChart equity={result.equity} />
          </div>

          {result.logs.length > 0 && (
            <>
              <SubHeader title="Logs" count={result.logs.length} />
              <Collapse
                count={result.logs.length}
                limit={MAX_BACKTEST_ROWS}
                expanded={expandLogs}
                onToggle={() => setExpandLogs((e) => !e)}
                label="LOGS"
              >
                <div className="log-output px-3 py-1 text-[9px]">
                  {(expandLogs ? result.logs : result.logs.slice(0, MAX_BACKTEST_ROWS)).map((l, i) => (
                    <div key={i}><span className="log-timestamp">[{i}]</span> {l}</div>
                  ))}
                </div>
              </Collapse>
            </>
          )}

          <SubHeader title="Trades" count={p!.trades.length} />
          <RoundTripTable
            trips={computeRoundTrips(p!.trades)}
            limit={MAX_BACKTEST_ROWS}
            expanded={expandTrips}
            onToggle={() => setExpandTrips((e) => !e)}
          />
          {p!.trades.length === 0 ? (
            <EmptyState message="No trades generated" />
          ) : (
            <Collapse
              count={p!.trades.length}
              limit={MAX_BACKTEST_ROWS}
              expanded={expandTrades}
              onToggle={() => setExpandTrades((e) => !e)}
              label="TRADES"
            >
              <table className="w-full text-[10px]">
                <thead>
                  <tr>
                    <Th>Time</Th><Th>Symbol</Th><Th>Side</Th><Th right>Qty</Th><Th right>Price</Th><Th right>Value</Th>
                  </tr>
                </thead>
                <tbody>
                  {(expandTrades ? p!.trades : p!.trades.slice(0, MAX_BACKTEST_ROWS)).map((t, i) => (
                    <tr key={`${t.order_id}-${i}`}>
                      <td className="text-secondary">{new Date(t.timestamp).toLocaleString()}</td>
                      <td className="text-primary font-bold">{t.symbol}</td>
                      <td className={t.side === "buy" ? "text-up" : "text-down"}>{t.side.toUpperCase()}</td>
                      <td className="text-right font-mono">{t.qty}</td>
                      <td className="text-right font-mono">${t.price.toFixed(2)}</td>
                      <td className="text-right font-mono">${(t.qty * t.price).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Collapse>
          )}
        </>
      )}
    </div>
  );
}

function BacktestEquityChart({ equity }: { equity: { t: string; v: number; c: number }[] }) {
  if (equity.length < 2) {
    return <p className="text-secondary text-[10px]">No equity data.</p>;
  }
  // Long backtests (e.g. 1Min over a year) produce 250k+ equity points that
  // collapse into dense vertical bands when painted as an SVG polyline, so
  // reduce to a bounded sample before rendering.
  const pts = downsample(equity, 600);
  const W = 800;
  const H = 120;
  const base = pts[0].v;
  const up = pts[pts.length - 1].v >= base;
  const startPrice = pts[0].c || 1;
  const pct = (v: number) => (v / base - 1) * 100;
  const pctHold = (e: { c: number }) => (e.c / startPrice - 1) * 100;
  // Scale the two series independently. They can live on very different
  // magnitudes (a 0.2% equity move vs a 60% stock move), so sharing a y-axis
  // staples whichever one is bigger and squishes the other flat.
  const eqVals = pts.map((e) => pct(e.v));
  const holdVals = pts.map(pctHold);
  const eqMin = Math.min(...eqVals);
  const eqMax = Math.max(...eqVals);
  const holdMin = Math.min(...holdVals);
  const holdMax = Math.max(...holdVals);
  const pad = 4;
  const step = W / (pts.length - 1);
  const yFor = (val: number, lo: number, hi: number) => H - pad - ((val - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const line = pts.map((e, i) => `${(i * step).toFixed(1)},${yFor(pct(e.v), eqMin, eqMax).toFixed(1)}`).join(" ");
  const holdPts = pts.map((e, i) => `${(i * step).toFixed(1)},${yFor(pctHold(e), holdMin, holdMax).toFixed(1)}`).join(" ");
  const color = up ? "var(--up)" : "var(--down)";
  const endPct = pct(pts[pts.length - 1].v);
  const endHoldPct = pctHold(pts[pts.length - 1]);
  return (
    <div>
      <div className="text-secondary mb-0.5 flex items-center justify-between px-2 text-[8px]">
        <span>EQUITY CURVE</span>
        <span className="font-mono">${fmt(pts[0].v)} &rarr; ${fmt(pts[pts.length - 1].v)} ({endPct >= 0 ? "+" : ""}{endPct.toFixed(2)}%)</span>
      </div>
      <div className="text-secondary mb-0.5 flex gap-3 px-2 text-[8px]">
        <span>
          <span className="mr-1 inline-block h-[2px] w-3 align-middle" style={{ background: color }} /> strategy
        </span>
        <span className="text-tertiary">
          <span className="mr-1 inline-block h-0 w-3 border-t border-dashed align-middle" style={{ borderColor: "var(--border-strong)" }} /> buy &amp; hold {endHoldPct >= 0 ? "+" : ""}{endHoldPct.toFixed(2)}%
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[100px] w-full">
        <rect x={0} y={0} width={W} height={H} fill="var(--editor-bg)" />
        <line x1={0} y1={yFor(0, eqMin, eqMax)} x2={W} y2={yFor(0, eqMin, eqMax)} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="3 3" />
        <polyline points={holdPts} fill="none" stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="4 3" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <div className="text-secondary mt-0.5 flex justify-between px-2 text-[8px]">
        <span>{new Date(pts[0].t).toLocaleDateString()}</span>
        <span>{new Date(pts[pts.length - 1].t).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

// ── Small shared components ──────────────────────────────────────────────────

function SubHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="bg-panel2 border-0 border-y border-[var(--border)] px-3 py-1">
      <span className="text-secondary text-[8px] font-semibold uppercase tracking-[0.1em]">
        {title}
        {typeof count === "number" && count > 0 && (
          <span className="ml-1 text-accent">{count}</span>
        )}
      </span>
    </div>
  );
}

function ToggleMore({ total, label, expanded, onToggle }: {
  total: number;
  label: string;
  expanded: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="bg-panel2 relative z-10 w-full border-0 border-b border-[var(--border)] px-3 py-1 text-center text-[9px] font-bold tracking-wider text-accent hover:bg-accent-soft"
      title={expanded ? "Collapse this list" : `Show all ${total} ${label.toLowerCase()}`}
    >
      {expanded ? "▲ SHOW LESS" : `▼ SHOW ALL ${total} ${label}`}
    </button>
  );
}

function Collapse({ count, limit, expanded, onToggle, label, children }: {
  count: number;
  limit: number;
  expanded: boolean;
  onToggle?: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const over = count > limit;
  if (!over) return <>{children}</>;
  return (
    <div className="relative">
      <div className={expanded ? "" : "max-h-44 overflow-hidden"}>
        {children}
      </div>
      {!expanded && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 h-16 bg-gradient-to-t from-[var(--panel)] via-[var(--panel)]/70 to-transparent" />
      )}
      <ToggleMore total={count} label={label} expanded={expanded} onToggle={onToggle} />
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-tertiary text-[8px] uppercase tracking-wider">{label}</div>
      <div className="font-mono text-[11px] font-bold" style={{ color: color || "var(--text)" }}>
        {value}
      </div>
    </div>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-tertiary text-[8px] uppercase tracking-wider">{label}</span>
      <span className="font-mono text-[10px] font-bold" style={{ color: color || "var(--text)" }}>
        {value}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: Order["status"] }) {
  const cls = status === "filled"
    ? "text-up border-[var(--up)]"
    : status === "rejected" || status === "cancelled"
      ? "text-down border-[var(--down)]"
      : "text-secondary border-[var(--border)]";
  return (
    <span className={`badge ${cls}`}>
      {status}
    </span>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-2 py-1 ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-secondary flex h-full items-center justify-center py-6 text-[10px]">
      {message}
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function downsample<T extends { t: unknown }>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function defaultBacktestLabel(res: BacktestResult): string {
  const iv = res.interval.replace("Min", "M").replace("Hour", "H").replace("Day", "D");
  return `${res.symbol} ${iv} ${res.days}d ${new Date(res.start).toLocaleDateString()}`;
}
