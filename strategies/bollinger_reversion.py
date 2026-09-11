"""Bollinger Mean-Reversion Strategy — buys band breaches with an ATR stop.

Buys when price closes below (or into) the lower Bollinger Band, rides it back
to the middle band, and uses a hard ATR-based stop below entry to cap losses.
Takes more risk than a passive crossover by entering against the move and
holding with a candle-band trailing exit.
"""

from backend.strategy.base import Strategy, Bar
from backend.indicators.technical import bollinger_bands, atr


class BollingerReversion(Strategy):
    period = 20
    std_dev = 2.0
    base_qty = 10
    stop_atr_mult = 2.5
    take_at_mid = True

    def start(self):
        self.position_qty = 0
        self.entry_price = None
        self.stop_price = None
        self.ctx.log("Bollinger Reversion initialised: period=20, std=2.0, ATR stop x2.5")

    def on_bar(self, bar: Bar):
        df = self.ctx.get_data(bar.symbol, lookback=self.period + 25)
        if df.empty or len(df) < self.period + 5:
            return

        bb = bollinger_bands(df, self.period, self.std_dev)
        a = atr(df, 14)

        if bb["BB_Lower"].isna().iloc[-1] or bb["BB_Mid"].isna().iloc[-1] or a.isna().iloc[-1]:
            return

        lower = bb["BB_Lower"].iloc[-1]
        mid = bb["BB_Mid"].iloc[-1]
        atr_val = max(a.iloc[-1], 1e-9)
        price = bar.close

        if self.position_qty <= 0:
            # Only fade a real breach of the lower band (limits whipsaw entries).
            if price < lower:
                self.ctx.place_order(bar.symbol, "buy", self.base_qty, "market")
                self.position_qty = self.base_qty
                self.entry_price = price
                self.stop_price = price - self.stop_atr_mult * atr_val
                self.ctx.log(
                    f"BUY {bar.symbol} @ {price:.2f} (breached lower band {lower:.2f}, stop {self.stop_price:.2f})"
                )
        else:
            exit_reason = None
            if self.take_at_mid and price >= mid:
                exit_reason = f"reversion to mid band {mid:.2f}"
            elif price <= self.stop_price:
                exit_reason = f"stop hit at {self.stop_price:.2f}"
            # Trail the stop up on strength but never above entry cost.
            elif self.entry_price is not None and price > self.entry_price:
                new_stop = price - self.stop_atr_mult * atr_val
                if new_stop > self.stop_price:
                    self.stop_price = new_stop

            if exit_reason:
                self.ctx.place_order(bar.symbol, "sell", self.position_qty, "market")
                self.ctx.log(f"SELL {bar.symbol} @ {price:.2f} ({exit_reason})")
                self.position_qty = 0
                self.entry_price = None
                self.stop_price = None

    def stop(self):
        self.ctx.log(f"Bollinger Reversion stopped. Final position: {self.position_qty}")