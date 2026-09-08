import { useEffect, useRef } from "react";
import {
  createChart,
  createSeriesMarkers,
  ColorType,
  CandlestickSeries,
  LineSeries,
} from "lightweight-charts";
import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, SeriesMarker, Time, UTCTimestamp } from "lightweight-charts";
import type { BarData, Trade } from "../lib/types";

interface PriceChartProps {
  bars: BarData[];
  symbol: string;
  theme: "light" | "dark" | "mid";
  onNeedOlder?: () => void;
  onEdgeCleared?: () => void;
  indicators?: IndicatorOverlay[];
  noMoreData?: boolean;
  loadingMore?: boolean;
  resetKey?: string;
  trades?: Trade[];
}

export interface IndicatorOverlay {
  id: string;
  type: "sma" | "ema" | "bollinger" | "vwap";
  period?: number;
  data: { time: number; value: number }[];
  color: string;
}

const THEMES: Record<"light" | "dark" | "mid", {
  bg: string; text: string; grid: string; border: string; up: string; down: string;
}> = {
  dark: {
    bg: "#0a0a0a", text: "#888888", grid: "#1a1a1a", border: "#333333",
    up: "#00ff41", down: "#ff3333",
  },
  light: {
    bg: "#e8e8e8", text: "#555555", grid: "#d4d4d4", border: "#999999",
    up: "#008800", down: "#cc0000",
  },
  mid: {
    bg: "#4f4f4f", text: "#c2c2c2", grid: "#585858", border: "#7d7d7d",
    up: "#7acf7a", down: "#d68484",
  },
};

export default function PriceChart({ bars, symbol, theme, onNeedOlder, onEdgeCleared, indicators, noMoreData, loadingMore, resetKey, trades }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const fittedRef = useRef(false);
  const needOlderRef = useRef(onNeedOlder);
  needOlderRef.current = onNeedOlder;
  const edgeClearedRef = useRef(onEdgeCleared);
  edgeClearedRef.current = onEdgeCleared;
  const noMoreDataRef = useRef(noMoreData);
  noMoreDataRef.current = noMoreData;
  const barsLenRef = useRef(0);
  const suppressUntilRef = useRef(0);

  const lastResetKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey ?? null;
      fittedRef.current = false;
    }
  }, [resetKey]);

  useEffect(() => {
    if (!containerRef.current) return;
    const colors = THEMES[theme];

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: colors.bg },
        textColor: colors.text,
        fontFamily: "'Consolas', 'Menlo', 'Courier New', monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: {
        borderColor: colors.border,
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 8,
      },
      crosshair: {
        mode: 0,
        vertLine: {
          color: "#555555",
          width: 1,
          style: 2,
          labelBackgroundColor: "#00ccff",
        },
        horzLine: {
          color: "#555555",
          width: 1,
          style: 2,
          labelBackgroundColor: "#00ccff",
        },
      },
      handleScroll: { vertTouchDrag: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });

    chartRef.current = chart;
    seriesRef.current = candleSeries;
    markersApiRef.current = createSeriesMarkers(candleSeries, []);
    fittedRef.current = false;
    barsLenRef.current = 0;
    suppressUntilRef.current = 0;

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || typeof range.from !== "number") return;
      // Ignore events right after a fit/data load — they fire with the whole
      // dataset visible, which is NOT a user pan-to-left.
      const now = Date.now();
      if (now < suppressUntilRef.current) return;
      const total = barsLenRef.current;
      const span = range.to - range.from;
      // Only request older bars when the user has zoomed in to a subset of the
      // data AND panned to the left edge. When fitContent shows everything,
      // span ≈ total bars, so we never fire.
      if (range.from <= 1.5 && total > 0 && span < total * 0.9) {
        needOlderRef.current?.();
      } else if (range.from > 3 && noMoreDataRef.current) {
        edgeClearedRef.current?.();
      }
    });

    const ro = new ResizeObserver((entries) => {
      if (chartRef.current && entries[0]) {
        const { width, height } = entries[0].contentRect;
        chartRef.current.applyOptions({ width, height });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      chart.remove();
      ro.disconnect();
      markersApiRef.current?.detach();
      markersApiRef.current = null;
      chartRef.current = null;
      seriesRef.current = null;
      indicatorSeriesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, symbol]);

  useEffect(() => {
    if (!seriesRef.current || chartRef.current === null) return;
    const candleData = bars.map((b) => ({
      time: b.time_ts as UTCTimestamp,
      open: b.open, high: b.high, low: b.low, close: b.close,
    }));
    barsLenRef.current = candleData.length;
    seriesRef.current.setData(candleData);
    // On a brand-new symbol/interval, fit the whole series. When data is
    // merely appended (scrolling for older bars), preserve the user's view.
    if (!fittedRef.current) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
    // Give the freshly-fit chart a moment to settle before we consider any
    // visible-range events to be genuine user pans.
    suppressUntilRef.current = Date.now() + 400;
  }, [bars]);

  // Buy/sell trade markers — snap each trade to the bar that contains it.
  useEffect(() => {
    const markersApi = markersApiRef.current;
    if (!markersApi) return;
    if (!trades || trades.length === 0) {
      markersApi.setMarkers([]);
      return;
    }
    const colors = THEMES[theme];
    const times = bars.map((b) => b.time_ts);
    const markers: SeriesMarker<Time>[] = [];
    for (const t of trades) {
      const tradeSec = new Date(t.timestamp).getTime() / 1000;
      // Last bar at or before the trade timestamp (bars are sorted ascending).
      let idx = -1;
      for (let i = 0; i < times.length; i++) {
        if (times[i] <= tradeSec) idx = i; else break;
      }
      if (idx === -1) continue;
      const buy = t.side === "buy";
      markers.push({
        time: times[idx] as UTCTimestamp,
        position: buy ? "belowBar" : "aboveBar",
        shape: buy ? "arrowUp" : "arrowDown",
        color: buy ? colors.up : colors.down,
        text: `${buy ? "B" : "S"} ${t.qty}`,
        id: t.order_id,
      });
    }
    markersApi.setMarkers(markers);
  }, [trades, bars, theme]);

  // Manage indicator overlays
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Remove old indicator series
    for (const [id, series] of indicatorSeriesRef.current) {
      if (!indicators?.find((ind) => ind.id === id)) {
        chart.removeSeries(series);
        indicatorSeriesRef.current.delete(id);
      }
    }

    // Add/update indicator series
    if (!indicators) return;
    for (const ind of indicators) {
      let series = indicatorSeriesRef.current.get(ind.id);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: ind.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        indicatorSeriesRef.current.set(ind.id, series);
      }
      series.applyOptions({ color: ind.color });
      series.setData(
        ind.data.map((d) => ({
          time: d.time as UTCTimestamp,
          value: d.value,
        }))
      );
    }
  }, [indicators]);

  return (
    <div className="relative h-full w-full">
      <div className="absolute left-2 top-1 z-10 bg-panel px-1 py-0.5 border border-[var(--border)]">
        <span className="text-primary text-[10px] font-bold tracking-wider">{symbol}</span>
      </div>
      {loadingMore && (
        <div className="absolute left-2 bottom-2 z-10 flex items-center gap-1.5 bg-panel px-1.5 py-0.5 border border-[var(--border)]">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          <span className="text-tertiary text-[8px] tracking-widest">LOADING HISTORY</span>
        </div>
      )}
      {noMoreData && !loadingMore && (
        <div className="absolute left-2 bottom-2 z-10 bg-panel px-1.5 py-0.5 border border-[var(--border)]">
          <span className="text-tertiary text-[8px] tracking-widest">END OF AVAILABLE HISTORY</span>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
