import { useCallback, useEffect, useState } from "react";
import { api } from "./lib/api";
import type { BarData, Order, PerfPoint, Portfolio, Quote, Settings } from "./lib/types";
import TickerSidebar from "./components/TickerSidebar";
import PriceChart from "./components/PriceChart";
import OrderPanel from "./components/OrderPanel";
import StrategyView from "./components/StrategyView";

function getPanelType(): string | null {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^[#?]+/, ""));
  return params.get("panel") || hashParams.get("panel");
}

export default function DetachedPanelApp() {
  const panelType = getPanelType();
  useDetachedTheme();

  if (panelType === "watchlist") return <DetachedWatchlist />;
  if (panelType === "chart") return <DetachedChart />;
  if (panelType === "orders" || panelType === "right") return <DetachedOrders />;
  if (panelType === "strategy") return <DetachedStrategy />;
  if (panelType === "performance") return <DetachedPerformance />;
  if (panelType === "backtest") return <DetachedBacktest />;

  return (
    <div className="bg-app flex h-full items-center justify-center text-secondary text-[11px]">
      Unknown panel type: {panelType}
    </div>
  );
}

// Detect the user's theme as early as possible and apply it to this window's
// DOM root. Without `data-theme` set, none of the app's CSS variables exist
// and detached windows render with browser-default (white) styling.
function useDetachedTheme() {
  const [theme, setTheme] = useState<"light" | "dark" | "mid">("dark");

  useEffect(() => {
    let cancelled = false;
    try {
      const local = localStorage.getItem("dv-theme");
      if (local === "light" || local === "dark" || local === "mid") setTheme(local);
    } catch { /* ignore */ }
    api.settings()
      .then((d) => { if (!cancelled) setTheme(d.settings.theme === "light" ? "light" : d.settings.theme === "mid" ? "mid" : "dark"); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
    try { localStorage.setItem("dv-theme", theme); } catch { /* ignore */ }
  }, [theme]);

  return theme;
}

// ── Shared data hook ─────────────────────────────────────────────────────

function useSharedData() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [active, setActive] = useState("AAPL");
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [orders, setOrders] = useState<Order[]>([]);
  const [perfPoints, setPerfPoints] = useState<PerfPoint[]>([]);
  const [bars, setBars] = useState<BarData[]>([]);
  const [interval_, setInterval_] = useState("1Min");
  const [settings, setSettings] = useState<Settings | null>(null);

  const refresh = useCallback(async () => {
    try { setPortfolio(await api.portfolio()); } catch {}
    try { const d = await api.orders(); setOrders(d.orders); } catch {}
    try { const d = await api.performance(); setPerfPoints(d.points); } catch {}
    try { const d = await api.watchlist(); setSymbols(d.symbols); } catch {}
    try { const d = await api.quotes(); setQuotes(d.quotes); } catch {}
    try { const d = await api.settings(); setSettings(d.settings); setInterval_(d.settings.default_interval); } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const loadBars = useCallback(async (sym: string, iv: string) => {
    try {
      const d = await api.bars(sym, iv, 180);
      setBars(d.bars);
    } catch {}
  }, []);

  useEffect(() => { loadBars(active, interval_); }, [active, interval_, loadBars]);

  return { portfolio, symbols, active, setActive, quotes, orders, perfPoints, bars, interval_, setInterval_, settings, refresh };
}

// ── Individual detached panels ───────────────────────────────────────────

function DetachedWatchlist() {
  const { symbols, active, setActive, quotes } = useSharedData();

  const handleAdd = useCallback(async (sym: string): Promise<string | null> => {
    try { await api.addWatchlist(sym); return null; } catch { return "Failed to add"; }
  }, []);

  const handleRemove = useCallback(async (sym: string) => {
    try { await api.removeWatchlist(sym); } catch {}
  }, []);

  const handleReorder = useCallback(async (order: string[]) => {
    try { await api.reorderWatchlist(order); } catch {}
  }, []);

  return (
    <div className="bg-app h-full">
      <TickerSidebar
        symbols={symbols}
        active={active}
        onSelect={setActive}
        onRemove={handleRemove}
        onAdd={handleAdd}
        onReorder={handleReorder}
        quotes={quotes}
      />
    </div>
  );
}

function DetachedChart() {
  const { active, bars, interval_, portfolio } = useSharedData();
  const theme = useDetachedTheme();

  return (
    <div className="bg-app flex h-full flex-col">
      <div className="bg-panel border-0 border-b border-[var(--border)] flex h-8 shrink-0 items-center gap-2 px-2">
        <span className="text-primary text-[11px] font-bold tracking-wider">{active}</span>
        {bars.length > 0 && (
          <span className="text-primary font-mono text-[11px] font-bold">
            {bars[bars.length - 1].close.toFixed(2)}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <PriceChart
          bars={bars}
          symbol={active}
          theme={theme}
          trades={portfolio?.trades.filter((t) => t.symbol === active) ?? []}
          resetKey={`${active}:${interval_}`}
        />
      </div>
    </div>
  );
}

function DetachedOrders() {
  const { portfolio, active, bars, settings, quotes } = useSharedData();
  const latestPrice = bars.length > 0 ? bars[bars.length - 1].close : null;

  const handlePlaceOrder = useCallback(async (req: {
    symbol: string; side: string; qty: number;
    order_type?: string; limit_price?: number | null; stop_price?: number | null;
  }) => {
    const placed = await api.placeOrder(req);
    return placed;
  }, []);

  return (
    <div className="bg-app flex h-full flex-col">
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
        onPlaceOrder={handlePlaceOrder}
      />
    </div>
  );
}

function DetachedStrategy() {
  return (
    <div className="bg-app h-full">
      <StrategyView
        refreshPortfolio={async () => {}}
        onBacktestComplete={() => {}}
        portfolioId={null}
        runSignal={0}
      />
    </div>
  );
}

function DetachedPerformance() {
  const { portfolio, orders, refresh } = useSharedData();
  const positions = portfolio ? Object.values(portfolio.positions) : [];

  const handleCancel = useCallback(async (orderId: string) => {
    try { await api.cancelOrder(orderId); await refresh(); } catch { /* ignore */ }
  }, [refresh]);

  return (
    <div className="bg-app h-full overflow-auto">
      <div className="flex items-center gap-4 border-0 border-b border-[var(--border)] px-3 py-1.5">
        <Mini label="EQUITY" value={`$${fmt(portfolio?.total_value ?? 0)}`} />
        <Mini label="CASH" value={`$${fmt(portfolio?.cash ?? 0)}`} />
      </div>
      <SubHeader title="Positions" count={positions.length} />
      {positions.length === 0 ? (
        <div className="text-secondary flex py-6 items-center justify-center text-[10px]">No positions</div>
      ) : (
        <table className="w-full text-[10px]">
          <thead>
            <tr>
              <Th>Symbol</Th><Th right>Qty</Th><Th right>Avg Entry</Th><Th right>Current</Th><Th right>P&L</Th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.symbol}>
                <td className="text-primary font-bold">{p.symbol}</td>
                <td className="text-right font-mono">{p.qty}</td>
                <td className="text-right font-mono">${p.avg_entry_price.toFixed(2)}</td>
                <td className="text-right font-mono">${p.current_price.toFixed(2)}</td>
                <td className={`text-right font-mono ${p.unrealized_pnl >= 0 ? "text-up" : "text-down"}`}>
                  ${p.unrealized_pnl.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <SubHeader title="Open Orders" count={orders.filter((o) => o.status === "pending").length} />
      {orders.length > 0 && (
        <table className="w-full text-[10px]">
          <thead>
            <tr><Th>Symbol</Th><Th>Side</Th><Th>Type</Th><Th right>Qty</Th><Th>Status</Th><Th></Th></tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="text-primary font-bold">{o.symbol}</td>
                <td className={o.side === "buy" ? "text-up" : "text-down"}>{o.side.toUpperCase()}</td>
                <td className="text-secondary">{o.order_type}</td>
                <td className="text-right font-mono">{o.qty}</td>
                <td className={o.status === "filled" ? "text-up" : o.status === "rejected" ? "text-down" : "text-secondary"}>{o.status}</td>
                <td>
                  {o.status === "pending" && (
                    <button
                      onClick={() => handleCancel(o.id)}
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
    </div>
  );
}

function DetachedBacktest() {
  return (
    <div className="bg-app flex h-full items-center justify-center text-secondary text-[11px]">
      Backtest results appear here when running a backtest from the Strategy panel.
    </div>
  );
}

// ── Shared small components ──────────────────────────────────────────────

function SubHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="bg-panel2 border-0 border-y border-[var(--border)] px-3 py-1">
      <span className="text-secondary text-[8px] font-semibold uppercase tracking-[0.1em]">
        {title}{typeof count === "number" && count > 0 && <span className="ml-1 text-accent">{count}</span>}
      </span>
    </div>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-tertiary text-[8px] uppercase tracking-wider">{label}</span>
      <span className="font-mono text-[10px] font-bold" style={{ color: color || "var(--text)" }}>{value}</span>
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`px-2 py-1 ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
