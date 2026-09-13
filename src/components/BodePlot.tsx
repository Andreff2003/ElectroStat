import { EmptyPlotState } from "@/components/EmptyPlotState";
import { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine, ReferenceArea,
} from "recharts";
import type { EISDataPoint } from "@/hooks/useSimulatedData";

interface BodePlotProps {
  data: EISDataPoint[];
  overlays?: { label: string; color: string; data: EISDataPoint[] }[];

  /** Compact read-only rendering for the dashboard grid. */
  compact?: boolean;
}

const BodePlot = ({ data, overlays, compact = false }: BodePlotProps) => {
  const plotData = data.map(d => ({
    freq: d.frequency,
    zMag: d.zMag,
    phase: d.phase,
  }));
  const ovs = compact ? [] : (overlays ?? []).map((o) => ({
    ...o,
    data: o.data.map((d) => ({ freq: d.frequency, zMag: d.zMag, phase: d.phase })),
  }));

  const [zoomArea, setZoomArea] = useState<{ x1: number; x2: number } | null>(null);
  const [zoomDomain, setZoomDomain] = useState<{ x: [number, number] } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  const handleMouseDown = (e: any) => {
    const xVal = e?.activePayload?.[0]?.payload?.freq;
    if (xVal == null) return;
    setIsSelecting(true);
    setZoomArea({ x1: xVal, x2: xVal });
  };
  const handleMouseMove = (e: any) => {
    if (!isSelecting) return;
    const xVal = e?.activePayload?.[0]?.payload?.freq;
    if (xVal == null) return;
    setZoomArea((prev) => (prev ? { ...prev, x2: xVal } : null));
  };
  const handleMouseUp = () => {
    if (!isSelecting || !zoomArea) { setIsSelecting(false); return; }
    setIsSelecting(false);
    const x1 = Math.min(zoomArea.x1, zoomArea.x2);
    const x2 = Math.max(zoomArea.x1, zoomArea.x2);
    if (x2 / x1 < 1.0001) { setZoomArea(null); return; }
    setZoomDomain({ x: [x1, x2] });
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
          margin={compact ? { top: 8, right: 8, bottom: 8, left: 8 } : { top: 10, right: 30, bottom: 40, left: 20 }}
          onMouseDown={compact ? undefined : handleMouseDown}
          onMouseMove={compact ? undefined : handleMouseMove}
          onMouseUp={compact ? undefined : handleMouseUp}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 15% 15%)" />
          <XAxis
            dataKey="freq"
            type="number"
            scale="log"
            domain={zoomDomain ? zoomDomain.x : ['auto', 'auto']}
            allowDataOverflow
            label={compact ? undefined : { value: "Frequency (Hz)", position: "bottom", offset: 20, fill: "hsl(215 15% 50%)", fontSize: 12 }}
            tick={{ fill: "hsl(215 15% 50%)", fontSize: compact ? 9 : 10 }}
            stroke="hsl(220 15% 20%)"
            interval={compact ? undefined : 9}
          />
          <YAxis
            yAxisId="left"
            scale="log"
            domain={['auto', 'auto']}
            allowDataOverflow
            label={compact ? undefined : { value: "|Z| (Ω)", angle: -90, position: "insideLeft", offset: -5, fill: "hsl(160 70% 50%)", fontSize: 12 }}
            tick={{ fill: "hsl(215 15% 50%)", fontSize: compact ? 9 : 11 }}
            stroke="hsl(220 15% 20%)"
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={["auto", "auto"]}
            label={compact ? undefined : { value: "Phase (°)", angle: 90, position: "insideRight", offset: -5, fill: "hsl(35 90% 55%)", fontSize: 12 }}
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
          />
          {!compact && <Legend wrapperStyle={{ color: "hsl(215 15% 50%)", fontSize: 12 }} />}
          {!compact && (
            <ReferenceLine
              yAxisId="right"
              y={-45}
              stroke="hsl(35 90% 55%)"
              strokeDasharray="4 4"
              label={{ value: "-45° (ω = 1/RctCdl)", fill: "hsl(35 90% 55%)", fontSize: 10, position: "insideTopRight" }}
            />
          )}
          <Line yAxisId="left" type="monotone" dataKey="zMag" name="|Z| (Ω)" stroke="hsl(160 70% 50%)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line yAxisId="right" type="monotone" dataKey="phase" name="Phase (°)" stroke="hsl(35 90% 55%)" strokeWidth={2} dot={false} isAnimationActive={false} />
          {ovs.map((o, i) => [
            <Line
              key={`ov-mag-${i}`}
              yAxisId="left"
              type="monotone"
              data={o.data}
              dataKey="zMag"
              name={`${o.label} |Z|`}
              stroke={o.color}
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
            />,
            <Line
              key={`ov-ph-${i}`}
              yAxisId="right"
              type="monotone"
              data={o.data}
              dataKey="phase"
              name={`${o.label} φ`}
              stroke={o.color}
              strokeOpacity={0.6}
              strokeWidth={1.5}
              strokeDasharray="2 3"
              dot={false}
              isAnimationActive={false}
            />,
          ])}
          {!compact && isSelecting && zoomArea && zoomArea.x1 !== zoomArea.x2 && (
            <ReferenceArea yAxisId="left" x1={zoomArea.x1} x2={zoomArea.x2} strokeOpacity={0.3} fill="hsl(160 70% 55%)" fillOpacity={0.15} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default BodePlot;
