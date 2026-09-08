import { useState } from "react";
import type { LiveStrategy, Order, Position, Quote } from "../lib/types";
import LiveStrategiesBar from "./LiveStrategiesBar";

interface OrderPanelProps {
  symbol: string;
  latestPrice: number | null;
  cash: number;
  buyingPower: number;
  shortBuyingPower: number;
  position: Position | null;
  maxOrderQty: number;
  shareIncrement: number;
  quote: Quote | null;
  liveStrategies?: LiveStrategy[];
  onStopLiveStrategy?: (key: string) => void;
  onStopAllLiveStrategies?: () => void;
  onPlaceOrder: (req: {
    symbol: string;
    side: string;
    qty: number;
    order_type?: string;
    limit_price?: number | null;
    stop_price?: number | null;
  }) => Promise<Order>;
}

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function OrderPanel({
  symbol,
  latestPrice,
  cash,
  buyingPower,
  shortBuyingPower,
  position,
  maxOrderQty,
  shareIncrement,
  quote,
  liveStrategies = [],
  onStopLiveStrategy,
  onStopAllLiveStrategies,
  onPlaceOrder,
}: OrderPanelProps) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("");
  const [orderType, setOrderType] = useState("market");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState("");
  const [lastOrder, setLastOrder] = useState<Order | null>(null);

  const price = latestPrice;
  const crypto = symbol.includes("/");
  const qtyNum = parseFloat(qty) || 0;

  const unrealized = position?.unrealized_pnl ?? 0;
  const pnlColor = unrealized >= 0 ? "text-up" : "text-down";

  const step = crypto ? 0.0001 : shareIncrement > 0 ? shareIncrement : 1;
  const floorToStep = (n: number) => Math.floor(n / step) * step;

  // Long capacity is limited by buying power; short capacity by what the
  // account can realistically borrow (shortBuyingPower from the broker).
  const maxBuyQty = price && price > 0 ? Math.max(0, buyingPower / price) : 0;
  const heldLong = position && position.qty > 0 ? position.qty : 0;
  const shortQtyCapacity = price && price > 0 ? shortBuyingPower / price : 0;
  const maxSellQty = heldLong + shortQtyCapacity;
  const effectiveMax = side === "buy" ? maxBuyQty : maxSellQty;
  const hardCap = Number.isFinite(maxOrderQty) ? maxOrderQty : Infinity;
  // For crypto allow fractional quantities; for equities clamp to the share increment.
  const orderableMax = crypto ? Math.min(effectiveMax, hardCap) : floorToStep(Math.min(effectiveMax, hardCap));

  const estValue = price != null && price > 0 && qtyNum ? price * qtyNum : null;
  const cashAfter = estValue != null
    ? side === "buy"
      ? Math.max(0, cash - estValue)
      : cash + estValue
    : cash;

  const changePct = quote?.change_pct ?? null;

  const fmtMax = (n: number) =>
    crypto ? String(Number(n.toFixed(4))) : String(Math.floor(n / step) * step);

  const setQtyClamped = (val: number) => {
    const v = Math.max(0, crypto ? val : floorToStep(val));
    setQty(String(v > 0 ? v : ""));
  };
  const applyPct = (pct: number) => {
    const v = orderableMax * (pct / 100);
    setQtyClamped(crypto ? Math.round(v * 10000) / 10000 : floorToStep(v));
  };

  const handleSubmit = async () => {
    if (!qtyNum || qtyNum <= 0) {
      setStatus("error:Enter a valid quantity");
      return;
    }
    if (qtyNum > orderableMax) {
      setStatus(`error:Max ${side === "buy" ? "buy" : "sell"} quantity is ${fmtMax(orderableMax)}`);
      return;
    }
    if (side === "buy" && estValue != null && estValue > buyingPower) {
      setStatus("error:Insufficient buying power");
      return;
    }
    setSubmitting(true);
    setStatus("");
    try {
      const placed = await onPlaceOrder({
        symbol,
        side,
        qty: qtyNum,
        order_type: orderType,
        limit_price: orderType.includes("limit") && limitPrice ? parseFloat(limitPrice) : null,
        stop_price: orderType.includes("stop") && stopPrice ? parseFloat(stopPrice) : null,
      });
      setLastOrder(placed);
      setQty("");
      setStatus("ok");
    } catch (e) {
      setStatus(`error:${e instanceof Error ? e.message : "Order failed"}`);
    } finally {
      setSubmitting(false);
    }
  };

  const isShort = position != null && position.qty < 0;
  const handleClosePosition = async () => {
    if (!position) return;
    setSubmitting(true);
    setStatus("");
    try {
      // Shorts are closed by buying to cover; longs by selling to close.
      const placed = await onPlaceOrder({
        symbol,
        side: isShort ? "buy" : "sell",
        qty: Math.abs(position.qty),
        order_type: "market",
      });
      setLastOrder(placed);
      setStatus("ok");
    } catch (e) {
      setStatus(`error:${e instanceof Error ? e.message : "Failed to close position"}`);
    } finally {
      setSubmitting(false);
    }
  };

  const isError = status.startsWith("error:");
  const statusTheme =
    !isError && lastOrder
      ? lastOrder.status === "filled"
        ? "border-[var(--up)] bg-up-soft text-up"
        : lastOrder.status === "rejected" || lastOrder.status === "cancelled"
          ? "border-[var(--down)] bg-down-soft text-down"
          : "border-[var(--accent)] bg-accent-soft text-accent"
      : "border-[var(--up)] bg-up-soft text-up";
  const opensShort = side === "sell" && qtyNum > heldLong;
  const invalid = qtyNum > orderableMax || (side === "buy" && estValue != null && estValue > buyingPower);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Symbol / price header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between border-0 border-b border-[var(--border)] px-3 py-2">
        <span className="text-primary text-[12px] font-bold tracking-wider">{symbol}</span>
        {price != null && (
          <div className="flex items-baseline gap-2">
            {changePct != null && (
              <span className={`font-mono text-[9px] font-bold ${changePct >= 0 ? "text-up" : "text-down"}`}>
                {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
              </span>
            )}
            <span className="font-mono text-[13px] font-bold text-primary">${price.toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* ── Live strategies banner ───────────────────────────────────── */}
      <LiveStrategiesBar
        strategies={liveStrategies}
        onStop={onStopLiveStrategy ?? (() => {})}
        onStopAll={onStopAllLiveStrategies ?? (() => {})}
      />

      {/* ── Side selector ─────────────────────────────────────────────── */}
      <div className="relative grid grid-cols-2 gap-0 border-0 border-b border-[var(--border)]">
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-[var(--border)]" />
        <button
          onClick={() => setSide("buy")}
          className={`relative border-0 border-b-2 py-2 text-[11px] font-bold tracking-wider transition-colors ${
            side === "buy"
              ? "border-[var(--up)] bg-up-soft text-[var(--up)] shadow-[inset_0_0_0_1px_var(--up)]"
              : "border-transparent bg-transparent text-secondary hover:text-[var(--up)]"
          }`}
          title="Set order side to buy"
        >
          BUY
        </button>
        <button
          onClick={() => setSide("sell")}
          className={`relative border-0 border-b-2 py-2 text-[11px] font-bold tracking-wider transition-colors ${
            side === "sell"
              ? "border-[var(--down)] bg-down-soft text-[var(--down)] shadow-[inset_0_0_0_1px_var(--down)]"
              : "border-transparent bg-transparent text-secondary hover:text-[var(--down)]"
          }`}
          title="Set order side to sell"
        >
          SELL
        </button>
      </div>

      {/* ── Order ticket ─────────────────────────────────────────────── */}
      <div className="flex-1 space-y-2 px-3 py-2.5">
        {/* Order type */}
        <div>
          <FieldLabel text="Order Type" />
          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value)}
            className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[11px] text-primary outline-none"
          >
            <option value="market">Market</option>
            <option value="limit">Limit</option>
            <option value="stop">Stop</option>
          </select>
        </div>

        {orderType === "limit" && (
          <InputField label="Limit Price" type="number" step="0.01" value={limitPrice} onChange={setLimitPrice} placeholder="0.00" />
        )}
        {orderType === "stop" && (
          <InputField label="Stop Price" type="number" step="0.01" value={stopPrice} onChange={setStopPrice} placeholder="0.00" />
        )}

        {/* Quantity */}
        <div>
          <FieldLabel text="Quantity">
            {orderableMax > 0 && (
              <span className="text-tertiary ml-1 normal-case tracking-normal">
                max {fmtMax(orderableMax)}
                {side === "sell" && shortQtyCapacity > 0 && " (incl. short)"}
              </span>
            )}
          </FieldLabel>
          <input
            type="number"
            value={qty}
            min={crypto ? "0" : "1"}
            step={step}
            max={orderableMax || undefined}
            onChange={(e) => setQty(e.target.value)}
            className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[12px] font-mono text-primary outline-none"
          />
        </div>

        {/* Quick allocation */}
        <div className="grid grid-cols-4 gap-0">
          {[25, 50, 75, 99].map((p) => (
            <button
              key={p}
              onClick={() => applyPct(p)}
              className={`border-0 py-0.5 text-[9px] font-bold ${
                p === 99 ? "border-[var(--border)]" : "border-r-0 border-[var(--border)]"
              } bg-transparent text-secondary hover:text-primary`}
            >
              {p === 99 ? "MAX" : `${p}%`}
            </button>
          ))}
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={submitting || invalid}
          className={`w-full py-2.5 text-[11px] font-bold ${
            side === "buy"
              ? "bg-[var(--up)] text-black hover:opacity-90"
              : "bg-[var(--down)] text-white hover:opacity-90"
          } disabled:opacity-30 disabled:cursor-not-allowed`}
        >
          {submitting ? "SUBMITTING..." : opensShort ? "SELL TO OPEN SHORT" : "PLACE ORDER"}
        </button>

        {/* Status */}
        {status && (
          <div className={`mt-1 border px-2 py-1 text-[10px] font-bold ${
            isError
              ? "border-[var(--down)] bg-down-soft text-down"
              : statusTheme
          }`}>
            {isError ? status.slice("error:".length) : lastOrder ? `ORDER ${lastOrder.status.toUpperCase()}` : "ORDER PLACED"}
          </div>
        )}
      </div>

      {/* ── Order summary ────────────────────────────────────────────── */}
      <div className="bg-panel2 space-y-0.5 border-0 border-t border-[var(--border)] px-3 py-1.5 text-[10px]">
        <Row label="Side" value={side === "buy" ? "BUY" : opensShort ? "SELL (SHORT)" : "SELL"} />
        <Row label="Type" value={orderType.toUpperCase()} />
        {estValue != null && (
          <Row label="Est. Value" value={`$${fmt(estValue)}`} />
        )}
        <Row label="Cash After" value={`$${fmt(cashAfter)}`} />
      </div>

      {/* ── Position ─────────────────────────────────────────────────── */}
      <div className="border-0 border-t border-[var(--border)] px-3 py-2">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-secondary text-[8px] font-bold uppercase tracking-[0.12em]">
            Position · {symbol}
          </span>
          {position ? (
            <span className={`font-mono text-[10px] font-bold ${pnlColor}`}>
              {unrealized >= 0 ? "+" : ""}{fmt(unrealized)}
            </span>
          ) : (
            <span className="text-tertiary text-[10px]">Flat</span>
          )}
        </div>
        {position ? (
          <div className="flex items-center justify-between gap-2">
            <div className="text-secondary flex items-center gap-3 text-[10px]">
              <span>
                QTY <b className={`font-mono ${isShort ? "text-[var(--down)]" : "text-primary"}`}>
                  {isShort ? `SHORT ${Math.abs(position.qty)}` : position.qty}
                </b>
              </span>
              <span>AVG <b className="text-primary font-mono">${fmt(position.avg_entry_price)}</b></span>
              <span>VAL <b className="text-primary font-mono">${fmt(position.market_value)}</b></span>
            </div>
            <button
              onClick={handleClosePosition}
              disabled={submitting}
              className="border border-[var(--down)] bg-transparent px-2 py-0.5 text-[8px] font-bold text-[var(--down)] hover:bg-down-soft disabled:opacity-40"
              title={
                isShort
                  ? `Market buy ${Math.abs(position.qty)} ${symbol} to cover the short`
                  : `Market sell ${position.qty} ${symbol} to close the position`
              }
            >
              {isShort ? "COVER" : "CLOSE"}
            </button>
          </div>
        ) : (
          <span className="text-tertiary text-[10px]">No open position {shortQtyCapacity > 0 ? "· shorting available" : ""}</span>
        )}
      </div>

      {/* ── Buying power footer ──────────────────────────────────────── */}
      <div className="bg-panel flex items-baseline justify-between border-0 border-t border-[var(--border)] px-3 py-1.5">
        <span className="text-secondary text-[8px] font-bold uppercase tracking-[0.12em]">Buying Power</span>
        <span className="font-mono text-[12px] font-bold text-primary">${fmt(buyingPower)}</span>
      </div>
    </div>
  );
}

function FieldLabel({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <span className="text-secondary mb-0.5 flex items-baseline text-[8px] font-bold uppercase tracking-[0.12em]">
      {text}
      {children}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-secondary">{label}</span>
      <span className="text-primary font-mono font-bold">{value}</span>
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  type,
  step,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  step?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <FieldLabel text={label} />
      <input
        value={value}
        type={type}
        step={step}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[12px] font-mono text-primary outline-none"
      />
    </div>
  );
}