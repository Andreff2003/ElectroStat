import { EmptyPlotState } from "@/components/EmptyPlotState";
import { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea, Legend,
} from "recharts";
import type { FETTimePoint } from "@/hooks/useSimulatedData";

export interface FETTimeOverlay {
  id?: string;
  label: string;
  color: string;
  data: FETTimePoint[];
}

interface FETTimePlotProps {
  data: FETTimePoint[];
  markers?: { time: number; label: string }[];
  overlays?: FETTimeOverlay[];
  /** Compact read-only rendering for the dashboard grid. */
  compact?: boolean;
  /** Display label for the default injection marker — e.g. "Cortisol". */
  analyteName?: string;
}


const FETTimePlot = ({ data, markers, overlays: overlaysProp = [], compact = false, analyteName = "Analyte" }: FETTimePlotProps) => {
  const overlays = compact ? [] : overlaysProp;
  const lines = markers && markers.length > 0
    ? markers
    : [{ time: 10, label: `${analyteName} injection` }];

  const [zoomArea, setZoomArea] = useState<{ x1: number; x2: number } | null>(null);
  const [zoomDomain, setZoomDomain] = useState<{ x: [number, number]; y: [number, number] } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  const handleMouseDown = (e: any) => {
    const xVal = e?.activePayload?.[0]?.payload?.time;
    if (xVal == null) return;
    setIsSelecting(true);
    setZoomArea({ x1: xVal, x2: xVal });
  };
  const handleMouseMove = (e: any) => {
    if (!isSelecting) return;
    const xVal = e?.activePayload?.[0]?.payload?.time;
    if (xVal == null) return;
    setZoomArea((prev) => (prev ? { ...prev, x2: xVal } : null));
  };
  const handleMouseUp = () => {
    if (!isSelecting || !zoomArea) { setIsSelecting(false); return; }
    setIsSelecting(false);
    const x1 = Math.min(zoomArea.x1, zoomArea.x2);
    const x2 = Math.max(zoomArea.x1, zoomArea.x2);
    if (Math.abs(x2 - x1) < 1e-6) { setZoomArea(null); return; }
    const visible = data.filter((p) => p.time >= x1 && p.time <= x2);
    const ys = visible.map((p) => p.id).filter((v) => Number.isFinite(v));
    if (ys.length === 0) { setZoomArea(null); return; }
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const pad = (yMax - yMin) * 0.05 || Math.abs(yMax) * 0.05 || 1;
    setZoomDomain({ x: [x1, x2], y: [yMin - pad, yMax + pad] });
    setZoomArea(null);
  };

  if (data.length === 0 && overlays.length === 0) {
    return (
      <EmptyPlotState
        title="No time response yet"
        hint="Click Start FET to begin monitoring Id vs time."
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
          data={data}
          margin={compact ? { top: 8, right: 8, bottom: 8, left: 16 } : { top: 28, right: 20, bottom: 26, left: 20 }}
          onMouseDown={compact ? undefined : handleMouseDown}
          onMouseMove={compact ? undefined : handleMouseMove}
          onMouseUp={compact ? undefined : handleMouseUp}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 15% 15%)" />
          <XAxis
            dataKey="time"
            type="number"
            domain={zoomDomain ? zoomDomain.x : ["auto", "auto"]}
            allowDataOverflow
            label={compact ? undefined : { value: "Time (s)", position: "bottom", offset: 6, fill: "hsl(215 15% 50%)", fontSize: 12 }}
            tick={{ fill: "hsl(215 15% 50%)", fontSize: compact ? 9 : 11 }}
            stroke="hsl(220 15% 20%)"
          />
          <YAxis
            domain={zoomDomain ? zoomDomain.y : ["auto", "auto"]}
            allowDataOverflow
            label={compact ? undefined : { value: "Id (µA)", angle: -90, position: "insideLeft", offset: -5, fill: "hsl(215 15% 50%)", fontSize: 12 }}
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
            formatter={(value: number) => [`${value.toFixed(2)} µA`, "Id"]}
          />
          {lines.map((m, i) => (
            <ReferenceLine
              key={`mk-${i}-${m.time}`}
              x={m.time}
              stroke="hsl(0 65% 50%)"
              strokeDasharray="4 4"
              label={compact ? undefined : { value: m.label, fill: "hsl(0 65% 60%)", fontSize: 11, position: "top" }}
            />
          ))}
          {!compact && overlays.length > 0 && <Legend wrapperStyle={{ color: "hsl(215 15% 50%)", fontSize: 12 }} />}
          {overlays.map((ov, idx) => {
            const key = ov.id ?? `ov-${idx}`;
            return (
              <Line
                key={key}
                type="monotone"
                data={ov.data}
                dataKey="id"
                name={ov.label}
                stroke={ov.color}
                strokeWidth={1.4}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
              />
            );
          })}
          <Line type="monotone" dataKey="id" name="Id" stroke="hsl(200 80% 55%)" strokeWidth={2} dot={false} isAnimationActive={false} />

          {!compact && isSelecting && zoomArea && zoomArea.x1 !== zoomArea.x2 && (
            <ReferenceArea x1={zoomArea.x1} x2={zoomArea.x2} strokeOpacity={0.3} fill="hsl(200 80% 55%)" fillOpacity={0.15} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default FETTimePlot;
