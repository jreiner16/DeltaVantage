import type { Trade } from "./types";

export interface RoundTrip {
  symbol: string;
  qty: number;
  buyPrice: number;
  sellPrice: number;
  pnl: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
}

// Pair the flat, chronological trade log into completed buy->sell round trips (FIFO).
// Each resulting row exposes BOTH the entry (buy) price and the exit (sell) price.
export function computeRoundTrips(trades: Trade[]): RoundTrip[] {
  const trips: RoundTrip[] = [];
  const lots: { symbol: string; qty: number; price: number; ts: string }[] = [];

  const sorted = [...trades].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const t of sorted) {
    if (t.side === "buy") {
      lots.push({ symbol: t.symbol, qty: t.qty, price: t.price, ts: t.timestamp });
      continue;
    }

    // Sell: match against buy lots for the same symbol, FIFO.
    let remaining = t.qty;
    while (remaining > 0) {
      const idx = lots.findIndex((l) => l.symbol === t.symbol);
      if (idx === -1) break;
      const lot = lots[idx];
      const matched = Math.min(lot.qty, remaining);
      const pnl = (t.price - lot.price) * matched;
      const pnlPct = lot.price !== 0 ? ((t.price - lot.price) / lot.price) * 100 : 0;
      trips.push({
        symbol: t.symbol,
        qty: matched,
        buyPrice: lot.price,
        sellPrice: t.price,
        pnl,
        pnlPct,
        openedAt: lot.ts,
        closedAt: t.timestamp,
      });
      lot.qty -= matched;
      remaining -= matched;
      if (lot.qty <= 0) lots.splice(idx, 1);
    }
  }

  return trips;
}
