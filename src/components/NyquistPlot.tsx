import { EmptyPlotState } from "@/components/EmptyPlotState";
import { useMemo, useState } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine, ReferenceArea,
} from "recharts";
import type { EISDataPoint } from "@/hooks/useSimulatedData";

/**
 * NYQUIST PLOT — EIS visualization with manual semicircle/Warburg separator.
 *
 * The separator is controlled by the parent (no automatic detection).
 * Points left of the separator are drawn teal (semicircle region);
 * points right are drawn amber (Warburg tail).
 */
interface NyquistPlotProps {
  data: EISDataPoint[];
  fittedCurve?: { zReal: number; zImag: number; frequency?: number }[];
  overlays?: { label: string; color: string; data: EISDataPoint[] }[];

  // Manual separator
  showSeparator?: boolean;
  separatorZReal?: number | null;
  onSeparatorChange?: (zReal: number) => void;

  /** Compact read-only rendering for the dashboard grid. */
  compact?: boolean;
}

const SEMI_COLOR = "hsl(160 70% 55%)"; // teal
const WARB_COLOR = "hsl(30 90% 60%)";  // amber
const SEP_COLOR  = "#F59E0B";

const NyquistPlot = ({
  data,
  fittedCurve,
  overlays,
  showSeparator = false,
  separatorZReal = null,
  onSeparatorChange,
  compact = false,
}: NyquistPlotProps) => {
  const ovs = compact ? [] : (overlays ?? []);

  const { minZ, maxZ } = useMemo(() => {
    if (data.length === 0) return { minZ: 0, maxZ: 1 };
    let mn = Infinity, mx = -Infinity;
    for (const d of data) {
      if (d.zReal < mn) mn = d.zReal;
      if (d.zReal > mx) mx = d.zReal;
    }
    return { minZ: Math.floor(mn), maxZ: Math.ceil(mx) };
  }, [data]);

  const sep = separatorZReal;
  const hasSep = !compact && showSeparator && sep != null;

  // Find the frequency corresponding to the separator zReal value.
  // We filter by FREQUENCY (not zReal) to correctly exclude the Warburg
  // tail, which can fold back to lower zReal values at low frequencies.
  const sepFreq = useMemo(() => {
    if (!hasSep || data.length === 0) return null;
    const closest = data.reduce((best, d) =>
      Math.abs(d.zReal - sep!) < Math.abs(best.zReal - sep!) ? d : best,
      data[0]
    );
    return closest.frequency;
  }, [hasSep, sep, data]);

  // Display convention: y = -Im(Z). Stored zImag is true Im(Z) (negative
  // for capacitive behavior), so we flip the sign here for the plot.
  const semiPts = hasSep && sepFreq != null
    ? data.filter(d => d.frequency >= sepFreq).map(d => ({ x: d.zReal, y: -d.zImag }))
    : data.map(d => ({ x: d.zReal, y: -d.zImag }));
  const warbPts = hasSep && sepFreq != null
    ? data.filter(d => d.frequency < sepFreq).map(d => ({ x: d.zReal, y: -d.zImag }))
    : [];

  const fitLine = (fittedCurve ?? []).map(d => ({ x: d.zReal, y: -d.zImag }));

  const [zoomArea, setZoomArea] = useState<{ x1: number; x2: number } | null>(null);
  const [zoomDomain, setZoomDomain] = useState<{ x: [number, number]; y: [number, number] } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  // ScatterChart, unlike LineChart, only populates activePayload when the
  // cursor is directly over a rendered dot (there's no "nearest x" index
  // tracking for continuous scatter data) — so a drag-to-zoom relying on
  // activePayload alone only registers right on top of existing points and
  // does nothing anywhere else on the plot. Convert the raw pixel position
  // via the X axis's own scale first; that works everywhere in the chart
  // area, with activePayload kept only as a fallback for older/edge cases.
  const getX = (e: any) => {
    try {
      const axisMap = e?.xAxisMap;
      if (axisMap && typeof e?.chartX === "number") {
        const axis = Object.values(axisMap)[0] as
          | { scale?: ((v: number) => number) & { invert?: (v: number) => number } }
          | undefined;
        if (axis?.scale) {
          const val = axis.scale.invert ? axis.scale.invert(e.chartX) : null;
          if (typeof val === "number" && Number.isFinite(val)) return val;
        }
      }
    } catch {
      // fall through to the activePayload-based fallback below
    }
    const p = e?.activePayload?.[0]?.payload;
    if (p && typeof p.x === "number") return p.x;
    if (typeof e?.xValue === "number") return e.xValue;
    return null;
  };

  const handleMouseDown = (e: any) => {
    const xVal = getX(e);
    if (xVal == null) return;
    setIsSelecting(true);
    setZoomArea({ x1: xVal, x2: xVal });
  };
  const handleMouseMove = (e: any) => {
    if (!isSelecting) return;
    const xVal = getX(e);
    if (xVal == null) return;
    setZoomArea((prev) => (prev ? { ...prev, x2: xVal } : null));
  };
  const handleMouseUp = () => {
    if (!isSelecting || !zoomArea) { setIsSelecting(false); return; }
    setIsSelecting(false);
    const x1 = Math.min(zoomArea.x1, zoomArea.x2);
    const x2 = Math.max(zoomArea.x1, zoomArea.x2);
    if (Math.abs(x2 - x1) < 1e-6) { setZoomArea(null); return; }
    const visible = data.filter((d) => d.zReal >= x1 && d.zReal <= x2);
    const ys = visible.map((d) => -d.zImag).filter((v) => Number.isFinite(v));
    if (ys.length === 0) { setZoomArea(null); return; }
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const pad = (yMax - yMin) * 0.05 || Math.abs(yMax) * 0.05 || 1;
    setZoomDomain({ x: [x1, x2], y: [yMin - pad, yMax + pad] });
    setZoomArea(null);
  };

  if (data.length === 0 && ovs.length === 0) {
    return (
      <EmptyPlotState
        title="No EIS sweep yet"
        hint="Click Start EIS to begin a simulated sweep, or switch Data Source to Live to connect your device."
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
          <ScatterChart
            margin={compact ? { top: 8, right: 8, bottom: 8, left: 8 } : { top: 28, right: 24, bottom: 24, left: 48 }}
            onMouseDown={compact ? undefined : handleMouseDown}
            onMouseMove={compact ? undefined : handleMouseMove}
            onMouseUp={compact ? undefined : handleMouseUp}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 15% 15%)" />
            <XAxis
              dataKey="x"
              type="number"
              name="Z' (Ω)"
              domain={zoomDomain ? zoomDomain.x : ['auto', 'auto']}
              allowDataOverflow
              label={compact ? undefined : { value: "Z' (Ohms) — Real Impedance", position: "bottom", offset: 20, fill: "hsl(215 15% 50%)", fontSize: 12 }}
              tick={{ fill: "hsl(215 15% 50%)", fontSize: compact ? 9 : 11 }}
              stroke="hsl(220 15% 20%)"
            />
            <YAxis
              dataKey="y"
              type="number"
              name="-Z'' (Ω)"
              domain={zoomDomain ? zoomDomain.y : ['auto', 'auto']}
              allowDataOverflow
              label={compact ? undefined : (props: any) => {
                const { viewBox } = props;
                const cy = viewBox.y + viewBox.height / 2;
                return (
                  <text
                    x={14}
                    y={cy}
                    transform={`rotate(-90, 14, ${cy})`}
                    textAnchor="middle"
                    fill="hsl(160 70% 50%)"
                    fontSize={11}
                    fontFamily="monospace"
                  >
                    -Z'' (Ohms) — Imaginary
                  </text>
                );
              }}
              tick={{ fill: "hsl(215 15% 50%)", fontSize: compact ? 9 : 11 }}
              stroke="hsl(220 15% 20%)"
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
              formatter={(value: number, name: string) => [`${value.toFixed(1)} Ω`, name]}
            />

            <Scatter
              data={semiPts}
              fill={SEMI_COLOR}
              stroke={SEMI_COLOR}
              strokeWidth={1}
              r={3}
              line={{ stroke: SEMI_COLOR, strokeWidth: 2 }}
              lineType="joint"
              name={hasSep ? "Semicircle" : "Measured"}
              isAnimationActive={false}
            />
            {warbPts.length > 0 && (
              <Scatter
                data={warbPts}
                fill={WARB_COLOR}
                stroke={WARB_COLOR}
                strokeWidth={1}
                r={3}
                line={{ stroke: WARB_COLOR, strokeWidth: 2, strokeDasharray: "4 3" }}
                lineType="joint"
                isAnimationActive={false}
                name="Warburg tail"
              />
            )}
            {ovs.map((o, i) => (
              <Scatter
                key={`ov-${i}-${o.label}`}
                data={o.data.map(d => ({ x: d.zReal, y: -d.zImag }))}
                fill={o.color}
                stroke={o.color}
                r={2}
                line={{ stroke: o.color, strokeWidth: 2 }}
                lineType="joint"
                isAnimationActive={false}
                name={o.label}
              />
            ))}
            {fitLine.length > 0 && (
              <Scatter
                data={fitLine}
                fill="transparent"
                stroke="hsl(170 80% 55%)"
                r={0}
                line={{ stroke: "hsl(170 80% 55%)", strokeWidth: 2 }}
                lineType="joint"
                isAnimationActive={false}
                name="Randles fit"
              />
            )}
            {hasSep && (
              <ReferenceLine
                x={sep!}
                stroke={SEP_COLOR}
                strokeDasharray="6 3"
                strokeWidth={2}
                label={{
                  value: "◄ Semicircle | Warburg ►",
                  position: "top",
                  fill: SEP_COLOR,
                  fontSize: 11,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
                ifOverflow="extendDomain"
              />
            )}
            {!compact && (ovs.length > 0 || hasSep) && (
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }} />
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
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {!compact && hasSep && onSeparatorChange && (
        <div className="mt-2 px-2 pb-1">
          <div className="flex items-center justify-between text-[11px] font-mono mb-1">
            <span style={{ color: SEP_COLOR }}>
              Semicircle / Warburg split: Z' = {sep!.toFixed(0)} Ω
            </span>
            <span className="text-muted-foreground">
              High-freq ≥ {sepFreq != null ? sepFreq.toFixed(2) : '?'} Hz: {sepFreq != null ? data.filter(d => d.frequency >= sepFreq).length : data.length} pts → semicircle fit ·
              Low-freq: {sepFreq != null ? data.filter(d => d.frequency < sepFreq).length : 0} pts → Warburg
            </span>
          </div>
          <input
            type="range"
            min={minZ}
            max={maxZ}
            step={1}
            value={Math.min(Math.max(sep!, minZ), maxZ)}
            onChange={(e) => onSeparatorChange(Number(e.target.value))}
            className="w-full accent-[hsl(160_70%_55%)]"
            aria-label="Semicircle / Warburg separator"
          />
        </div>
      )}
    </div>
  );
};

export default NyquistPlot;
