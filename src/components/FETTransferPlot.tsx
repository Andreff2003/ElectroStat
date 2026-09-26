import { EmptyPlotState } from "@/components/EmptyPlotState";
import { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceArea,
} from "recharts";
import type { FETTransferPoint } from "@/hooks/useSimulatedData";

interface FETOverlay {
  id: string;
  label: string;
  color: string;
  baseline: FETTransferPoint[];
  withAnalyte: FETTransferPoint[];
}

interface FETTransferPlotProps {
  baseline: FETTransferPoint[];
  withAnalyte: FETTransferPoint[];
  overlays?: FETOverlay[];
  /** Compact read-only rendering for the dashboard grid. */
  compact?: boolean;
  /** Display label for the analyte curve — e.g. "Cortisol". Never affects data. */
  analyteName?: string;
}

const FETTransferPlot = ({ baseline, withAnalyte, overlays: overlaysProp = [], compact = false, analyteName = "Analyte" }: FETTransferPlotProps) => {
  const overlays = compact ? [] : overlaysProp;
  const plotData = baseline.map((b, i) => ({
    vg: b.vg,
    baseline: b.id,
    analyte: withAnalyte[i]?.id ?? 0,
  }));

  const [zoomArea, setZoomArea] = useState<{ x1: number; x2: number } | null>(null);
  const [zoomDomain, setZoomDomain] = useState<{ x: [number, number]; y: [number, number] } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  const handleMouseDown = (e: any) => {
    const xVal = e?.activePayload?.[0]?.payload?.vg;
    if (xVal == null) return;
    setIsSelecting(true);
    setZoomArea({ x1: xVal, x2: xVal });
  };
  const handleMouseMove = (e: any) => {
    if (!isSelecting) return;
    const xVal = e?.activePayload?.[0]?.payload?.vg;
    if (xVal == null) return;
    setZoomArea((prev) => (prev ? { ...prev, x2: xVal } : null));
  };
  const handleMouseUp = () => {
    if (!isSelecting || !zoomArea) { setIsSelecting(false); return; }
    setIsSelecting(false);
    const x1 = Math.min(zoomArea.x1, zoomArea.x2);
    const x2 = Math.max(zoomArea.x1, zoomArea.x2);
    if (Math.abs(x2 - x1) < 1e-6) { setZoomArea(null); return; }
    const visible = plotData.filter((p) => p.vg >= x1 && p.vg <= x2);
    const ys = visible.flatMap((p) => [p.baseline, p.analyte]).filter((v) => Number.isFinite(v));
    if (ys.length === 0) { setZoomArea(null); return; }
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const pad = (yMax - yMin) * 0.05 || Math.abs(yMax) * 0.05 || 1;
    setZoomDomain({ x: [x1, x2], y: [yMin - pad, yMax + pad] });
    setZoomArea(null);
  };

  if (baseline.length === 0 && withAnalyte.length === 0) {
    return (
      <EmptyPlotState
        title="No transfer curve yet"
        hint="Click Start FET to sweep the transfer curve (Id vs Vg)."
      />
    );
  }

  return (
    <div className="w-full h-full" style={{ position: "relative" }}>
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
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={plotData}
          margin={compact ? { top: 8, right: 8, bottom: 8, left: 8 } : { top: 8, right: 24, bottom: 30, left: 56 }}
          onMouseDown={compact ? undefined : handleMouseDown}
          onMouseMove={compact ? undefined : handleMouseMove}
          onMouseUp={compact ? undefined : handleMouseUp}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 15% 15%)" />
          <XAxis
            dataKey="vg"
            type="number"
            domain={zoomDomain ? zoomDomain.x : ["auto", "auto"]}
            allowDataOverflow
            label={compact ? undefined : { value: "Gate Voltage Vg (V)", position: "bottom", offset: 6, fill: "hsl(215 15% 50%)", fontSize: 12 }}
            tick={{ fill: "hsl(215 15% 50%)", fontSize: compact ? 9 : 11 }}
            stroke="hsl(220 15% 20%)"
          />
          <YAxis
            domain={zoomDomain ? zoomDomain.y : ["auto", "auto"]}
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
                  fill="hsl(215 15% 50%)"
                  fontSize={11}
                  fontFamily="monospace"
                >
                  Drain Current Id (µA)
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
            formatter={(value: number) => [`${value.toFixed(2)} µA`]}
          />
          {!compact && <Legend verticalAlign="top" align="right" wrapperStyle={{ color: "hsl(215 15% 50%)", fontSize: 12, paddingBottom: 6 }} />}
          {overlays.flatMap((ov) => [
            <Line
              key={`ovb_${ov.id}`}
              type="monotone"
              data={ov.baseline}
              dataKey="id"
              name={`${ov.label} · baseline`}
              stroke={ov.color}
              strokeOpacity={0.55}
              strokeWidth={1.2}
              strokeDasharray="2 2"
              dot={false}
              isAnimationActive={false}
            />,
            <Line
              key={`ova_${ov.id}`}
              type="monotone"
              data={ov.withAnalyte}
              dataKey="id"
              name={`${ov.label} · analyte`}
              stroke={ov.color}
              strokeOpacity={1}
              strokeWidth={1.6}
              strokeDasharray="6 3"
              dot={false}
              isAnimationActive={false}
            />,
          ])}

          <Line type="monotone" dataKey="baseline" name="Baseline (no analyte)" stroke="hsl(200 80% 55%)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="analyte" name={`With ${analyteName}`} stroke="hsl(35 90% 55%)" strokeWidth={2} dot={false} strokeDasharray="6 3" isAnimationActive={false} />

          {!compact && isSelecting && zoomArea && zoomArea.x1 !== zoomArea.x2 && (
            <ReferenceArea x1={zoomArea.x1} x2={zoomArea.x2} strokeOpacity={0.3} fill="hsl(200 80% 55%)" fillOpacity={0.15} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default FETTransferPlot;
