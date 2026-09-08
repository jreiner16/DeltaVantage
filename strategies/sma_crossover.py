"""SMA Crossover Strategy — example strategy for Delta Vantage.

Buy when fast SMA crosses above slow SMA, sell when it crosses below.
"""

from delta_vantage.strategy.base import Strategy, Bar
from delta_vantage.indicators.technical import sma


class SMACrossover(Strategy):
    fast_period = 10
    slow_period = 50

    def start(self):
        self.position_qty = 0
        self.ctx.log(f"SMA Crossover initialised: fast={self.fast_period}, slow={self.slow_period}")

    def on_bar(self, bar: Bar):
        df = self.ctx.get_data(bar.symbol, lookback=self.slow_period + 10)
        if df.empty or len(df) < self.slow_period:
            return

        fast = sma(df, self.fast_period)
        slow = sma(df, self.slow_period)

        if fast.iloc[-1] > slow.iloc[-1] and fast.iloc[-2] <= slow.iloc[-2]:
            if self.position_qty <= 0:
                self.ctx.place_order(bar.symbol, "buy", 10, "market")
                self.position_qty = 10
                self.ctx.log(f"BUY {bar.symbol} @ {bar.close:.2f} (fast={fast.iloc[-1]:.2f} > slow={slow.iloc[-1]:.2f})")

        elif fast.iloc[-1] < slow.iloc[-1] and fast.iloc[-2] >= slow.iloc[-2]:
            if self.position_qty > 0:
                self.ctx.place_order(bar.symbol, "sell", self.position_qty, "market")
                self.ctx.log(f"SELL {bar.symbol} @ {bar.close:.2f} (fast={fast.iloc[-1]:.2f} < slow={slow.iloc[-1]:.2f})")
                self.position_qty = 0

    def stop(self):
        self.ctx.log(f"Strategy stopped. Final position: {self.position_qty}")
