import { useMemo } from "react";
import {
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Beaker, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/InfoHint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  responseFor,
  summarizeCalibration,
  randlesSevcikIpUA,
  type CVCalibrationPoint,
  type CVResponseMode,
} from "@/utils/cvCalibration";

interface Props {
  points: CVCalibrationPoint[];
  concentration_mM: number;
  onChangeConcentration: (v: number) => void;
  responseMode: CVResponseMode;
  onChangeResponseMode: (m: CVResponseMode) => void;
  onAddCurrent: () => void;
  onClear: () => void;
  onExport: () => void;
  canAdd: boolean;
  // Current sweep info for expected-vs-measured
  currentMeasuredUA: number | null;
  currentExpectedUA: number | null;
  cvModel: "reversible" | "quasi-reversible";
  n: number;
  areaCm2: number;
  scanRate_mVs: number;
}

const RESPONSE_LABEL: Record<CVResponseMode, string> = {
  mean: "mean peak (|Ipa|+|Ipc|)/2",
  anodic: "Ipa (anodic)",
  cathodic: "|Ipc| (cathodic)",
};

const CVCalibrationPanel = ({
  points,
  concentration_mM,
  onChangeConcentration,
  responseMode,
  onChangeResponseMode,
  onAddCurrent,
  onClear,
  onExport,
  canAdd,
  currentMeasuredUA,
  currentExpectedUA,
  cvModel,
  n,
  areaCm2,
  scanRate_mVs,
}: Props) => {
  const summary = useMemo(
    () => summarizeCalibration(points, responseMode),
    [points, responseMode],
  );

  // Build chart data: one row per measured replicate + a separate fit polyline.
  // We do NOT aggregate by concentration so replicates are visible.
  const chartData = useMemo(() => {
    type Row = { concentration: number; measured?: number; fitSignal?: number };
    const usable = points
      .map((p) => ({ c: p.concentration_mM, y: responseFor(p, responseMode) }))
      .filter((p) => p.y != null && Number.isFinite(p.y)) as { c: number; y: number }[];
    const measuredRows: Row[] = usable.map((p) => ({ concentration: p.c, measured: p.y }));
    const fitRows: Row[] = [];
    const fit = summary.fit;
    if (fit && usable.length >= 2) {
      const xs = usable.map((p) => p.c);
      const xmin = Math.min(...xs);
      const xmax = Math.max(...xs);
      const N = 40;
      for (let i = 0; i <= N; i++) {
        const c = xmin + ((xmax - xmin) * i) / N;
        fitRows.push({ concentration: c, fitSignal: fit.slope * c + fit.intercept });
      }
    }
    return [...measuredRows, ...fitRows].sort((a, b) => a.concentration - b.concentration);
  }, [points, responseMode, summary.fit]);

  const sortedPoints = useMemo(
    () => [...points].sort((a, b) => a.concentration_mM - b.concentration_mM),
    [points],
  );

  const expectedAtCurrent = useMemo(
    () => randlesSevcikIpUA({ n, areaCm2, cMM: concentration_mM, scanRate_mVs }),
    [n, areaCm2, concentration_mM, scanRate_mVs],
  );

  const percentError =
    currentMeasuredUA != null && currentExpectedUA && currentExpectedUA > 0
      ? ((currentMeasuredUA - currentExpectedUA) / currentExpectedUA) * 100
      : null;

  const qualityColor =
    summary.quality === "green"
      ? "text-graph-eis"
      : summary.quality === "yellow"
        ? "text-yellow-500"
        : summary.quality === "idle"
          ? "text-muted-foreground"
          : "text-destructive";

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Beaker className="h-4 w-4 text-primary" />
        <span className="font-mono text-sm text-foreground">CV Concentration & Calibration</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground uppercase">CV</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] font-mono uppercase text-muted-foreground">
            Sample Concentration (mM)
          </Label>
          <Input
            type="number"
            value={Number.isFinite(concentration_mM) ? concentration_mM : ""}
            min={0}
            step="any"
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              onChangeConcentration(Number.isFinite(v) ? Math.max(0, v) : 0);
            }}
            className="h-8 font-mono text-xs"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] font-mono uppercase text-muted-foreground">
            Response mode
          </Label>
          <Select value={responseMode} onValueChange={(v) => onChangeResponseMode(v as CVResponseMode)}>
            <SelectTrigger className="h-8 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mean" className="font-mono text-xs">{RESPONSE_LABEL.mean}</SelectItem>
              <SelectItem value="anodic" className="font-mono text-xs">{RESPONSE_LABEL.anodic}</SelectItem>
              <SelectItem value="cathodic" className="font-mono text-xs">{RESPONSE_LABEL.cathodic}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="bg-secondary rounded-md p-2">
          <div className="text-[10px] text-muted-foreground font-mono uppercase">Measured ip</div>
          <div className="text-sm font-mono text-foreground">
            {currentMeasuredUA != null ? `${currentMeasuredUA.toFixed(2)} µA` : "—"}
          </div>
        </div>
        <div className="bg-secondary rounded-md p-2">
          <div className="text-[10px] text-muted-foreground font-mono uppercase">Expected ip (RS)</div>
          <div className="text-sm font-mono text-foreground">
            {expectedAtCurrent != null ? `${expectedAtCurrent.toFixed(2)} µA` : "—"}
          </div>
          {percentError != null && (
            <div className="text-[10px] font-mono text-muted-foreground">
              error {percentError >= 0 ? "+" : ""}{percentError.toFixed(1)}%
            </div>
          )}
        </div>
      </div>
      {cvModel === "quasi-reversible" && (
        <div className="text-[10px] font-mono text-yellow-500 border border-yellow-500/40 bg-yellow-500/10 rounded-md p-2">
          Expected current assumes reversible diffusion-controlled CV.
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onAddCurrent} disabled={!canAdd} className="font-mono text-xs">
          ＋ Add Calibration Point
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClear}
          disabled={points.length === 0}
          className="font-mono text-xs"
        >
          Clear
        </Button>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-mono uppercase text-muted-foreground">
            Calibration Curve — response vs C ({RESPONSE_LABEL[responseMode]})
          </span>
          {summary.fit && (
            <span className="text-[10px] font-mono text-primary">
              slope {summary.fit.slope.toFixed(3)} µA/mM · R² {summary.fit.r2.toFixed(3)}
            </span>
          )}
        </div>
        <div className="h-[180px] bg-background rounded-md border border-border p-1">
          {chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[11px] font-mono text-muted-foreground">
              No calibration points yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="concentration"
                  type="number"
                  domain={[0, "auto"]}
                  tick={{ fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
                  label={{
                    value: "Concentration (mM)",
                    position: "insideBottom",
                    offset: -2,
                    style: { fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" },
                  }}
                />
                <YAxis
                  tick={{ fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
                  label={{
                    value: "Response (µA)",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" },
                  }}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    fontFamily: "monospace",
                    fontSize: "11px",
                  }}
                  formatter={(v: number) => (typeof v === "number" ? v.toFixed(3) : v)}
                />
                {summary.lod_mM != null && (
                  <ReferenceLine
                    x={summary.lod_mM}
                    stroke="hsl(var(--destructive))"
                    strokeDasharray="4 4"
                    label={{
                      value: `LOD ${summary.lod_mM.toFixed(3)} mM`,
                      fill: "hsl(var(--destructive))",
                      fontSize: 10,
                      position: "top",
                    }}
                  />
                )}
                <Line
                  type="linear"
                  dataKey="fitSignal"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Scatter dataKey="measured" fill="hsl(var(--primary))" />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="rounded-md bg-secondary/60 p-2 text-xs font-mono text-foreground space-y-0.5">
        <div>
          Sensitivity<InfoHint text="Slope of the linear calibration fit (peak current vs concentration)." />:{" "}
          <span className="text-primary">
            {summary.fit ? `${summary.fit.slope.toFixed(4)} µA/mM` : "—"}
          </span>
        </div>
        <div>
          Intercept<InfoHint text="Fitted current at C = 0 (b in I = m·C + b). It should sit close to the blank response; a large value points to background current or a poor blank." />:{" "}
          <span className="text-primary">
            {summary.fit ? `${summary.fit.intercept.toFixed(3)} µA` : "—"}
          </span>
        </div>
        <div>
          R²<InfoHint text="Coefficient of determination for the calibration fit. Closer to 1.0 indicates the model explains the concentration-response relationship well." />: <span className="text-primary">{summary.fit ? summary.fit.r2.toFixed(4) : "—"}</span>
        </div>
        <div>
          LOD (3σ/|slope|)<InfoHint text="Limit of Detection = 3σ(blank) / slope. The lowest concentration reliably distinguishable from a blank measurement." />:{" "}
          <span className="text-primary">
            {summary.lod_mM != null ? `${summary.lod_mM.toFixed(4)} mM` : "—"}
          </span>
          {summary.sigmaSource === "blank-replicates" && (
            <span className="text-muted-foreground"> · from blank replicates ({summary.nBlankReplicates})</span>
          )}
          {summary.sigmaSource === "fit-residual" && (
            <span className="text-muted-foreground"> · from calibration residuals (blank replicates recommended)</span>
          )}
          {summary.sigmaSource === "none" && (
            <span className="text-muted-foreground"> · unavailable — add blank replicates or ≥3 fit points</span>
          )}
        </div>
        <div>
          LOQ (10σ/|slope|)<InfoHint text="Limit of Quantitation = 10σ(blank) / slope. The lowest concentration that can be quantified with acceptable precision." />:{" "}
          <span className="text-primary">
            {summary.loq_mM != null ? `${summary.loq_mM.toFixed(4)} mM` : "—"}
          </span>
        </div>
        <div className="text-muted-foreground">
          points: {summary.nPoints} · unique C: {summary.nUniqueConcentrations} · blanks: {summary.nBlankReplicates}
        </div>
        <div>
          quality<InfoHint text="At-a-glance verdict combining R², a positive slope, and point count. Green requires ≥5 points, R² ≥ 0.995 and an LOD. Yellow needs ≥3 points and R² ≥ 0.98." />:{" "}
          <span className={`uppercase ${qualityColor}`}>{summary.quality === "idle" ? "—" : summary.quality}</span>
          {summary.qualityReasons.length > 0 && (
            <span className="text-muted-foreground"> · {summary.qualityReasons.join(" · ")}</span>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-mono uppercase text-muted-foreground">
            Points ({points.length})
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={onExport}
              disabled={points.length === 0}
              className="h-7 font-mono text-[11px]"
            >
              <Download className="h-3 w-3" /> Export CSV
            </Button>
          </div>
        </div>
        <div className="rounded-md border border-border max-h-[160px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 text-[10px] font-mono uppercase">C (mM)</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">Ipa (µA)</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">|Ipc| (µA)</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">mean (µA)</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">ΔEp (mV)</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">Sample</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">Electrode</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">Meas. ID</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedPoints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-[11px] font-mono text-muted-foreground py-3 text-center">
                    No calibration points yet
                  </TableCell>
                </TableRow>
              ) : (
                sortedPoints.map((p, i) => {
                  const midShort = p.measurementId
                    ? p.measurementId.length > 14
                      ? `…${p.measurementId.slice(-13)}`
                      : p.measurementId
                    : "—";
                  return (
                    <TableRow key={`${p.timestamp}-${i}`}>
                      <TableCell className="py-1.5 text-xs font-mono">{p.concentration_mM}</TableCell>
                      <TableCell className="py-1.5 text-xs font-mono">{p.Ipa_uA != null ? p.Ipa_uA.toFixed(2) : "—"}</TableCell>
                      <TableCell className="py-1.5 text-xs font-mono">{p.IpcAbs_uA != null ? p.IpcAbs_uA.toFixed(2) : "—"}</TableCell>
                      <TableCell className="py-1.5 text-xs font-mono">{p.responseMean_uA != null ? p.responseMean_uA.toFixed(2) : "—"}</TableCell>
                      <TableCell className="py-1.5 text-xs font-mono">{p.deltaEp_mV != null ? p.deltaEp_mV.toFixed(0) : "—"}</TableCell>
                      <TableCell className="py-1.5 text-[11px] font-mono text-muted-foreground">
                        {p.sampleId ?? "—"}
                      </TableCell>
                      <TableCell className="py-1.5 text-[11px] font-mono text-muted-foreground">
                        {p.electrodeId ?? "—"}
                      </TableCell>
                      <TableCell
                        className="py-1.5 text-[11px] font-mono text-muted-foreground"
                        title={p.measurementId ?? ""}
                      >
                        {midShort}
                      </TableCell>
                      <TableCell className="py-1.5 text-xs font-mono">
                        {new Date(p.timestamp).toLocaleTimeString()}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
};

export default CVCalibrationPanel;