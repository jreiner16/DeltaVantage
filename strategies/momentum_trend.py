"""Momentum Trend-Following Strategy — rides strong trends and pyramids.

Enters when a fast EMA is above a slow EMA with RSI confirming strength and
momentum still accelerating, adds units while strength persists, and exits
everything on a single trend/momentum break. Aggressive: specifically designed
to add size to winning positions rather than trimming them.
"""

from delta_vantage.strategy.base import Strategy, Bar
from delta_vantage.indicators.technical import ema, rsi, atr


class MomentumTrend(Strategy):
    fast_ema = 20
    slow_ema = 60
    rsi_period = 14
    base_qty = 5
    max_units = 3
    entry_rsi = 55
    add_rsi = 68
    exit_rsi = 42

    def start(self):
        self.units = 0
        self.entry_price = None
        self.peak_price = None
        self.ctx.log(
            f"Momentum Trend initialised: ema=20/60, base_qty={self.base_qty}, max_units={self.max_units}, pyramid RSI>{self.add_rsi}"
        )

    def on_bar(self, bar: Bar):
        df = self.ctx.get_data(bar.symbol, lookback=self.slow_ema + self.rsi_period + 10)
        if df.empty or len(df) < self.slow_ema + self.rsi_period:
            return

        f = ema(df, self.fast_ema)
        s = ema(df, self.slow_ema)
        r = rsi(df, self.rsi_period)
        a = atr(df, 14)

        if f.isna().iloc[-1] or s.isna().iloc[-1] or r.isna().iloc[-1] or a.isna().iloc[-1]:
            return
        if f.isna().iloc[-2] or r.isna().iloc[-2]:
            return

        price = bar.close
        r_val = r.iloc[-1]
        rising = f.iloc[-1] > f.iloc[-2]
        strong = price > f.iloc[-1] > s.iloc[-1] and r_val > self.entry_rsi
        atr_val = max(a.iloc[-1], 1e-9)

        if self.units <= 0:
            # Fresh entry only on a confirmed, accelerating up-trend.
            if strong and rising:
                self.ctx.place_order(bar.symbol, "buy", self.base_qty, "market")
                self.units = self.base_qty
                self.entry_price = price
                self.peak_price = price
                self.ctx.log(
                    f"BUY {bar.symbol} @ {price:.2f} (price {price:.2f} > ema20 {f.iloc[-1]:.2f} > ema60 {s.iloc[-1]:.2f}, RSI {r_val:.1f})"
                )
        elif self.units > 0:
            if price > self.peak_price:
                self.peak_price = price

            # Pyramid: keep buying strength — the core of this strategy's risk.
            if self.units < self.max_units * self.base_qty and r_val > self.add_rsi and rising:
                self.ctx.place_order(bar.symbol, "buy", self.base_qty, "market")
                self.units += self.base_qty
                self.ctx.log(f"PYRAMID {bar.symbol} @ {price:.2f} (units={self.units}, RSI {r_val:.1f})")

            # Exit: trend flips OR momentum collapses OR trailing stop breaks.
            exit_reason = None
            if price < s.iloc[-1]:
                exit_reason = f"price {price:.2f} broke ema60 {s.iloc[-1]:.2f}"
            elif r_val < self.exit_rsi:
                exit_reason = f"RSI {r_val:.1f} collapsed"
            elif self.peak_price is not None and price <= self.peak_price - 4 * atr_val:
                exit_reason = f"trailing stop (peak {self.peak_price:.2f} - 4*ATR)"

            if exit_reason:
                self.ctx.place_order(bar.symbol, "sell", self.units, "market")
                self.ctx.log(f"SELL {bar.symbol} @ {price:.2f} ({exit_reason})")
                self.units = 0
                self.entry_price = None
                self.peak_price = None

    def stop(self):
        self.ctx.log(f"Momentum Trend stopped. Final units: {self.units}")