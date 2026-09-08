"""RSI Mean-Reversion Strategy — fades oversold/overbought extremes.

Buys when RSI drops below the oversold threshold *and* price is still above
the long-term trend average (mean reversion in an uptrend), and exits when RSI
reaches the overbought threshold or the trend breaks. Riskier than plain SMA
crossover because it intentionally buys against the recent move.
"""

from delta_vantage.strategy.base import Strategy, Bar
from delta_vantage.indicators.technical import rsi, sma, atr


class RSIReversal(Strategy):
    rsi_period = 14
    oversold = 28
    overbought = 74
    trend_period = 50
    base_qty = 10

    def start(self):
        self.position_qty = 0
        self.entry_price = None
        self.ctx.log("RSI Reversal initialised: rsi=14, oversold=28, overbought=74")

    def on_bar(self, bar: Bar):
        df = self.ctx.get_data(bar.symbol, lookback=self.trend_period + self.rsi_period + 10)
        if df.empty or len(df) < self.trend_period + self.rsi_period:
            return

        r = rsi(df, self.rsi_period)
        trend = sma(df, self.trend_period)
        a = atr(df, 14)

        if r.isna().iloc[-1] or trend.isna().iloc[-1] or a.isna().iloc[-1]:
            return

        price = bar.close
        r_val = r.iloc[-1]
        uptrend = price > trend.iloc[-1]
        atr_val = max(a.iloc[-1], 1e-9)

        if self.position_qty <= 0:
            # Fade the dip: buy oversold *only* while the long trend is intact.
            if r_val < self.oversold and uptrend:
                self.ctx.place_order(bar.symbol, "buy", self.base_qty, "market")
                self.position_qty = self.base_qty
                self.entry_price = price
                self.ctx.log(
                    f"BUY {bar.symbol} @ {price:.2f} (RSI {r_val:.1f} oversold, price {price:.2f} > trend {trend.iloc[-1]:.2f})"
                )
        elif self.position_qty > 0:
            exit_reason = None
            if r_val >= self.overbought:
                exit_reason = f"RSI {r_val:.1f} overbought"
            elif price < trend.iloc[-1]:
                exit_reason = f"price {price:.2f} broke trend {trend.iloc[-1]:.2f}"
            elif self.entry_price is not None and price <= self.entry_price - 3 * atr_val:
                exit_reason = f"stop hit ({self.entry_price - 3 * atr_val:.2f})"

            if exit_reason:
                self.ctx.place_order(bar.symbol, "sell", self.position_qty, "market")
                self.ctx.log(f"SELL {bar.symbol} @ {price:.2f} ({exit_reason})")
                self.position_qty = 0
                self.entry_price = None

    def stop(self):
        self.ctx.log(f"RSI Reversal stopped. Final position: {self.position_qty}")