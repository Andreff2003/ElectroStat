import { EmptyPlotState } from "@/components/EmptyPlotState";
import { useMemo, useState } from "react";
import {
  ComposedChart,
  CartesianGrid,
  Line,
  ReferenceArea,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import type { SWVDataPoint, SWVMetrics } from "@/types/swv";

type ChartMouseEvent = {
  activeLabel?: number | string;
  activePayload?: Array<{ payload?: { E?: number } }>;
};

interface SWVOverlay {
  id: string;
  label: string;
  color: string;
  data: SWVDataPoint[];
}

interface Props {
  data: SWVDataPoint[];
  corrected?: SWVDataPoint[];
  metrics?: SWVMetrics | null;
  showForwardReverse?: boolean;
  showBaseline?: boolean;
  /** "raw" (default) plots INet; "corrected" plots baseline-subtracted INet. */
  plotMode?: "raw" | "corrected";
  overlays?: SWVOverlay[];
  /** Compact read-only rendering for the dashboard grid. */
  compact?: boolean;
}

const fmt = (v: unknown, unit: string, digits = 3) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return "N/A";
  // Show tiny currents (nM analyte) in nA instead of a rounded 0.000 µA.
  if (unit === "µA" && v !== 0 && Math.abs(v) < 0.01) return `${(v * 1000).toFixed(digits)} nA`;
  return `${v.toFixed(digits)} ${unit}`;
};

/**
 * SWV plot — differential I_net vs E as the primary trace, with optional
 * forward/reverse and baseline overlays. Note: forward/reverse here are
 * pulse-sampled currents, NOT CV forward/backward scan branches.
 */
export default function SWVPlot({
  data,
  corrected,
  metrics,
  showForwardReverse = false,
  showBaseline = false,
  plotMode = "raw",
  overlays = [],
  compact = false,
}: Props) {
  const correctedAvailable =
    !!corrected &&
    corrected.length === data.length &&
    corrected.some((p) => Number.isFinite(p.ICorrected));
  const effectiveMode: "raw" | "corrected" =
    plotMode === "corrected" && correctedAvailable ? "corrected" : "raw";
  const seriesCount =
    1 + // main I net line
    (showForwardReverse ? 2 : 0) +
    (showBaseline ? 1 : 0) +
    overlays.length;
  const rows = useMemo(() => {
    const src = corrected && corrected.length === data.length ? corrected : data;
    return src.map((p, i) => ({
      E: p.E,
      IForward: p.IForward,
      IReverse: p.IReverse,
      INet:
        effectiveMode === "corrected" && Number.isFinite(p.ICorrected as number)
          ? (p.ICorrected as number)
          : p.INet,
      baseline: p.baseline ?? data[i]?.baseline ?? null,
      ICorrected: p.ICorrected ?? null,
    }));
  }, [data, corrected, effectiveMode]);

  // Tick precision follows the visible current span: nA-level scans (nM
  // analyte) would otherwise print as 0.00 on every tick.
  const ySpan = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rows) {
      if (Number.isFinite(r.INet)) {
        lo = Math.min(lo, r.INet);
        hi = Math.max(hi, r.INet);
      }
    }
    return hi - lo;
  }, [rows]);

  const [zoomArea, setZoomArea] = useState<{ x1: number; x2: number } | null>(null);
  const [zoomDomain, setZoomDomain] = useState<{
    x: [number, number];
    y: [number, number];
  } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const visibleSpan = zoomDomain ? zoomDomain.y[1] - zoomDomain.y[0] : ySpan;
  const yDecimals = visibleSpan > 0
    ? Math.min(8, Math.max(2, Math.ceil(-Math.log10(visibleSpan / 5))))
    : 2;

  const getX = (e: ChartMouseEvent | null | undefined): number | null => {
    if (!e) return null;
    if (typeof e.activeLabel === "number") return e.activeLabel;
    const p = e.activePayload?.[0]?.payload;
    if (p && typeof p.E === "number") return p.E;
    return null;
  };

  const handleMouseDown = (e: ChartMouseEvent) => {
    const x = getX(e);
    if (x == null) return;
    setIsSelecting(true);
    setZoomArea({ x1: x, x2: x });
  };
  const handleMouseMove = (e: ChartMouseEvent) => {
    if (!isSelecting) return;
    const x = getX(e);
    if (x == null) return;
    setZoomArea((prev) => (prev ? { ...prev, x2: x } : null));
  };
  const handleMouseUp = () => {
    if (!isSelecting || !zoomArea) {
      setIsSelecting(false);
      return;
    }
    setIsSelecting(false);
    const x1 = Math.min(zoomArea.x1, zoomArea.x2);
    const x2 = Math.max(zoomArea.x1, zoomArea.x2);
    if (Math.abs(x2 - x1) < 1e-6) {
      setZoomArea(null);
      return;
    }
    const ys = rows
      .filter((r) => r.E >= x1 && r.E <= x2)
      .map((r) => r.INet)
      .filter((v): v is number => Number.isFinite(v));
    if (ys.length === 0) {
      setZoomArea(null);
      return;
    }
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const pad = (yMax - yMin) * 0.05 || Math.abs(yMax) * 0.05 || 1;
    setZoomDomain({ x: [x1, x2], y: [yMin - pad, yMax + pad] });
    setZoomArea(null);
  };

  if (data.length === 0 && overlays.length === 0) {
    return (
      <EmptyPlotState
        title="No SWV scan yet"
        hint="Click Start SWV to run a square-wave voltammetry scan."
      />
    );
  }

  return (
    <div className="w-full h-full flex flex-col" style={{ position: "relative" }}>
      {!compact && zoomDomain && (
        <button
          onClick={() => setZoomDomain(null)}
          style={{
            position: "absolute", top: 8, right: 8, zIndex: 10,
            fontSize: "11px", padding: "3px 10px",
            borderRadius: "4px", cursor: "pointer",
            background: "hsl(220 18% 14%)",
            border: "1px solid hsl(220 15% 22%)",
            color: "hsl(210 20% 80%)",
          }}
        >
          Reset Zoom
        </button>
      )}
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={compact ? { top: 8, right: 8, bottom: 8, left: 8 } : { top: 10, right: 20, left: 10, bottom: 20 }}
          onMouseDown={compact ? undefined : handleMouseDown}
          onMouseMove={compact ? undefined : handleMouseMove}
          onMouseUp={compact ? undefined : handleMouseUp}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="E"
            type="number"
            domain={zoomDomain ? zoomDomain.x : ["auto", "auto"]}
            allowDataOverflow
            label={compact ? undefined : { value: "E / V", position: "insideBottom", offset: -5 }}
            tick={{ fontSize: compact ? 9 : 11 }}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <YAxis
            domain={zoomDomain ? zoomDomain.y : ["auto", "auto"]}
            allowDataOverflow
            label={compact ? undefined : { value: "I / µA", angle: -90, position: "insideLeft" }}
            tick={{ fontSize: compact ? 9 : 11 }}
            tickFormatter={(v: number) => v.toFixed(yDecimals)}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(220 18% 10%)",
              border: "1px solid hsl(220 15% 18%)",
              borderRadius: "6px",
              color: "hsl(210 20% 90%)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
            }}
            formatter={(v: number | string, name: string) => [fmt(Number(v), "µA"), name]}
            labelFormatter={(v: number) => `E = ${Number(v).toFixed(3)} V`}
          />
          {!compact && seriesCount > 1 && (
            <Legend wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }} />
          )}
          {overlays.map((ov) => (
            <Line
              key={ov.id}
              type="monotone"
              data={ov.data}
              dataKey="INet"
              name={`${ov.label}${effectiveMode === "corrected" ? " (corrected)" : " (raw)"}`}
              stroke={ov.color}
              dot={false}
              strokeWidth={1.5}
              strokeDasharray="2 2"
              isAnimationActive={false}
            />
          ))}
          <Line
            type="monotone"
            dataKey="INet"
            name={effectiveMode === "corrected" ? "I net (corrected)" : "I net (raw)"}
            stroke="#3b82f6"
            dot={false}
            strokeWidth={2}
          />
          {/* No Fragment here: Recharts does not pick up children wrapped in one. */}
          {showForwardReverse && (
            <Line type="monotone" dataKey="IForward" name="I forward" stroke="#10b981" dot={false} strokeWidth={1} />
          )}
          {showForwardReverse && (
            <Line type="monotone" dataKey="IReverse" name="I reverse" stroke="#ef4444" dot={false} strokeWidth={1} />
          )}
          {showBaseline && (
            <Line type="monotone" dataKey="baseline" name="Baseline" stroke="#9ca3af" dot={false} strokeDasharray="4 4" />
          )}
          {metrics?.peakPotential_V != null && metrics.peakCurrentCorrected_uA != null && (
            <ReferenceDot
              x={metrics.peakPotential_V}
              y={metrics.peakCurrentCorrected_uA}
              r={5}
              fill="#f59e0b"
              stroke="#78350f"
              label={{ value: "peak", position: "top", fill: "#f59e0b", fontSize: 10 }}
            />
          )}
          {!compact && isSelecting && zoomArea && zoomArea.x1 !== zoomArea.x2 && (
            <ReferenceArea
              x1={Math.min(zoomArea.x1, zoomArea.x2)}
              x2={Math.max(zoomArea.x1, zoomArea.x2)}
              strokeOpacity={0.3}
              fill="hsl(160 70% 55%)"
              fillOpacity={0.15}
            />
          )}
        </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
