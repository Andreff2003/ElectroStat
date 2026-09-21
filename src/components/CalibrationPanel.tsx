import { useMemo, useState } from "react";
import { levenbergMarquardt } from "ml-levenberg-marquardt";
import { AlertTriangle, Beaker, Download } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ComposedChart,
} from "recharts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InfoHint } from "@/components/InfoHint";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EISDataPoint, FETTransferPoint } from "@/hooks/useSimulatedData";
import { computeFETVt as _computeFETVt } from "@/utils/fetVt";
import { applyFETResponseMode, type FETResponseMode } from "@/utils/fetMetrics";

/**
 * Returns the calibration signal (mV) that should be used in fits/plots for a
 * BioFET point, computed dynamically from the physical signed ΔVt so that
 * changing responseMode in the UI recalculates old points without touching raw.
 */
export function getCalibrationSignal(
  point: { signal: number; deltaVt_mV_signed?: number },
  responseMode: FETResponseMode,
  responseSign: 1 | -1 = 1,
): number {
  const physical = point.deltaVt_mV_signed ?? point.signal;
  return applyFETResponseMode(physical, responseMode, responseSign).calibrationSignal_mV_used;
}

export interface CalibrationPoint {
  concentration: number; // nM
  signal: number; // ΔRct (Ω) for EIS, ΔVt (mV) for FET, Ip (µA) for SWV — sign-preserved where applicable
  raw: number; // Rct (Ω) or Vt (V) or raw Ip (µA)
  timestamp: number;
  measurementId?: string;
  sampleId?: string;
  electrodeId?: string;
  notesShort?: string;
  // BioFET-specific traceability (optional)
  deltaVt_mV_signed?: number;
  calibrationSignal_mV_used?: number;
  responseMode?: "auto" | "signed" | "absolute";
  responseSign?: 1 | -1;
  vtBaseline?: number;
  vtAnalyte?: number;
  vtMethod?: string;
  vtFitR2?: number | null;
  vtRegionPoints?: number;
  vtWarning?: string;
  // SWV-specific traceability (optional)
  peakPotential_V?: number | null;
  snr?: number | null;
}

interface CalibrationPanelProps {
  mode: "eis" | "fet" | "swv";
  concentration: number;
  onChangeConcentration: (v: number) => void;
  points: CalibrationPoint[];
  onClear: () => void;
  onExport: () => void;
  /** Latest computed parameters from current/last sweep */
  currentRs?: number;
  currentRct?: number;
  currentVt?: number;
  /** BioFET-only — current measurement values for display, not aggregated from points */
  currentVtBaseline?: number | null;
  currentVtAnalyte?: number | null;
  currentDeltaVt_mV?: number | null;
  currentDeltaVtSigned_mV?: number | null;
  currentCalibrationSignal_mV?: number | null;
  /** BioFET-only Vt diagnostics from computeFETTransferMetrics */
  currentVtMethod?: string | null;
  currentVtFitR2?: number | null;
  currentVtRegionPoints?: number | null;
  currentVtWarning?: string | null;
  /** SWV-only — current measurement values for display */
  currentPeakCurrentRaw_uA?: number | null;
  currentPeakCurrentCorrected_uA?: number | null;
  currentPeakPotential_V?: number | null;
  responseMode?: FETResponseMode;
  responseSign?: 1 | -1;
  onResponseModeChange?: (mode: FETResponseMode) => void;
  /** True when randles fit did not converge and geometric estimate is shown */
  geometricFallback?: boolean;
  /** BioFET-only — display label for the analyte, e.g. "Cortisol". */
  analyteName?: string;
  /** Adds the current sweep's result as a calibration point. Omit to hide the button (legacy auto-add behaviour). */
  onAddCurrent?: () => void;
  /** Whether there's a current result to add (mirrors CVCalibrationPanel's canAdd). */
  canAdd?: boolean;
}

/** Find baseline (concentration === 0) point */
function findBaseline(points: CalibrationPoint[]) {
  return points.find((p) => p.concentration === 0);
}

/** Compute Rs (min zReal) and Rct (max-min zReal) from EIS sweep */
export function computeEISParams(data: EISDataPoint[]): { rs: number; rct: number } | null {
  const reals = (data ?? [])
    .map((d) => d?.zReal)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (reals.length < 5) return null;
  const minR = Math.min(...reals);
  const maxR = Math.max(...reals);
  return { rs: minR, rct: maxR - minR };
}

/** Vt extraction — sqrt(Id) extrapolation. See src/utils/fetVt.ts. */
export function computeFETVt(curve: FETTransferPoint[]): number | null {
  return _computeFETVt(curve);
}

/**
 * Nonlinear least-squares Langmuir fit:
 *   Signal = Smax * C / (C + Kd)
 *
 * Solved with Levenberg-Marquardt — the same solver already used for the EIS
 * CNLS fits — in LOG-space for both parameters. Log-space keeps Smax and Kd
 * strictly positive without bounds, and makes the step behaviour independent
 * of the signal scale, which differs by orders of magnitude between modes
 * (Ω for EIS ΔRct vs mV for BioFET ΔVt).
 *
 * `converged` is false when LM failed outright or did not improve on the
 * initial estimate — the caller must surface that, because a stalled fit
 * can still produce a respectable-looking R².
 */
export function fitLangmuirNLLS(
  points: { concentration: number; signal: number }[],
): { kd: number; sMax: number; r2: number; converged: boolean } | null {
  // Signals are already transformed by the caller (responseMode applied).
  // For "signed" mode with mixed-sign points, Langmuir is fit on magnitude
  // (documented behaviour); auto/absolute already produce non-negative values.
  const data = points.filter((p) => p.concentration > 0 && Math.abs(p.signal) > 0);
  if (data.length < 3) return null;
  const Cs = data.map((p) => p.concentration);
  const Ss = data.map((p) => Math.abs(p.signal));
  const sortedC = [...Cs].sort((a, b) => a - b);
  const medianC = sortedC[Math.floor(sortedC.length / 2)];
  const sMax0 = Math.max(...Ss) * 1.5;
  const kd0 = Math.max(medianC, 1e-6);
  if (!(sMax0 > 0) || !(kd0 > 0)) return null;

  const sse = (sM: number, k: number) => {
    let s = 0;
    for (let i = 0; i < Cs.length; i++) {
      const m = (sM * Cs[i]) / (Cs[i] + k);
      const r = m - Ss[i];
      s += r * r;
    }
    return s;
  };

  // Clamped exponentials so a wandering LM step can never produce Infinity
  // (which would poison the residuals and abort the fit).
  const expSafe = (v: number) => Math.exp(Math.max(-60, Math.min(60, v)));
  const modelFn = ([lsMax, lkd]: number[]) => (c: number) =>
    (expSafe(lsMax) * c) / (c + expSafe(lkd));

  let sMax = sMax0;
  let kd = kd0;
  let converged = false;
  try {
    const r = levenbergMarquardt({ x: Cs, y: Ss }, modelFn, {
      initialValues: [Math.log(sMax0), Math.log(kd0)],
      damping: 1e-3,
      maxIterations: 500,
      errorTolerance: 1e-10,
    });
    const pv = r?.parameterValues;
    if (pv && pv.length === 2 && pv.every((v: number) => Number.isFinite(v))) {
      const fittedSMax = expSafe(pv[0]);
      const fittedKd = expSafe(pv[1]);
      // Only accept the LM result if it actually beat the starting guess.
      if (sse(fittedSMax, fittedKd) <= sse(sMax0, kd0)) {
        sMax = fittedSMax;
        kd = fittedKd;
        converged = true;
      }
    }
  } catch (err) {
    console.warn("[ElectroStat] Langmuir LM fit failed — keeping initial estimate", err);
  }

  if (!Number.isFinite(kd) || !Number.isFinite(sMax) || kd <= 0 || sMax <= 0) return null;

  const meanY = Ss.reduce((a, b) => a + b, 0) / Ss.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < Cs.length; i++) {
    const m = (sMax * Cs[i]) / (Cs[i] + kd);
    ssRes += (Ss[i] - m) ** 2;
    ssTot += (Ss[i] - meanY) ** 2;
  }
  const r2 = ssTot < 1e-12 ? 1 : 1 - ssRes / ssTot;
  return { kd, sMax, r2, converged };
}

/** Linear fit Signal = m * C + b on points with C > 0. Returns slope, intercept, R², nPoints. */
export function fitLinearSWV(points: CalibrationPoint[]): { slope: number; intercept: number; r2: number; nPoints: number } | null {
  const positive = points.filter((p) => p.concentration > 0);
  if (positive.length < 2) return null;
  const n = positive.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of positive) {
    sx += p.concentration;
    sy += p.signal;
    sxx += p.concentration ** 2;
    sxy += p.concentration * p.signal;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // R²
  const meanY = sy / n;
  let ssRes = 0, ssTot = 0;
  for (const p of positive) {
    const yPred = slope * p.concentration + intercept;
    ssRes += (p.signal - yPred) ** 2;
    ssTot += (p.signal - meanY) ** 2;
  }
  const r2 = ssTot < 1e-12 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2, nPoints: n };
}

/**
 * LOD/LOQ for SWV. Uses only positive concentrations for the slope and derives
 * σ either from blank replicates (C=0) or from the residuals of the linear fit.
 * This intentionally mirrors the SWVMode calibration logic to preserve existing
 * SWV behaviour when migrating to the shared panel.
 */
export function computeLODSWV(
  points: CalibrationPoint[],
): { value: number; loq: number; sigmaSource: "replicates" | "residuals" } | null {
  const positive = points.filter((p) => p.concentration > 0);
  const fit = fitLinearSWV(points);
  if (!fit || Math.abs(fit.slope) < 1e-12) return null;
  const blanks = points.filter((p) => p.concentration === 0);
  let sigmaBlank: number;
  let sigmaSource: "replicates" | "residuals";
  if (blanks.length >= 2) {
    const mean = blanks.reduce((a, p) => a + p.signal, 0) / blanks.length;
    sigmaBlank = Math.sqrt(
      blanks.reduce((a, p) => a + (p.signal - mean) ** 2, 0) / (blanks.length - 1),
    );
    sigmaSource = "replicates";
  } else {
    const residSq = positive.reduce(
      (a, p) => a + (p.signal - (fit.slope * p.concentration + fit.intercept)) ** 2,
      0,
    );
    sigmaBlank = Math.sqrt(residSq / Math.max(1, positive.length - 2));
    sigmaSource = "residuals";
  }
  return {
    value: (3 * sigmaBlank) / Math.abs(fit.slope),
    loq: (10 * sigmaBlank) / Math.abs(fit.slope),
    sigmaSource,
  };
}

/**
 * LOD = 3 σ / slope, LOQ = 10 σ / slope.
 *
 * `slope` must be the sensitivity at the LOW-concentration limit of
 * whatever curve is actually being reported — for EIS/BioFET that's the
 * Langmuir isotherm (Signal = Smax·C/(C+Kd)) plotted on the chart above,
 * whose slope at C→0 is Smax/Kd, NOT a straight line fit across the whole
 * (possibly saturating) concentration range. Fitting a plain regression
 * line to points that span into saturation understates the true
 * low-concentration sensitivity and inflates LOD/LOQ — pass the Langmuir
 * fit's Smax/Kd in for eis/fet, not an independent linear fit.
 *
 * BioFET caveat — units must match.  Calibration points store `signal` in
 * mV (ΔVt) but `raw` in volts (Vt).  Computing σ over `raw` therefore needs
 * a ×1000 conversion before dividing by the mV/nM slope, otherwise the LOD
 * is off by a factor of 1000.
 */
export function computeLOD(
  points: CalibrationPoint[],
  mode: "eis" | "fet",
  slope: number | null,
): { value: number; loq: number; sigmaSource: "replicates" | "two_percent_baseline" } | null {
  const baseline = findBaseline(points);
  if (!baseline) return null;
  if (slope == null || !(slope > 0)) return null;
  const baselines = points.filter((p) => p.concentration === 0);
  let sigmaRaw: number;
  let sigmaSource: "replicates" | "two_percent_baseline";
  if (baselines.length >= 2) {
    const vals = baselines.map((p) => p.raw);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    sigmaRaw = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
    sigmaSource = "replicates";
  } else {
    sigmaRaw = Math.abs(baseline.raw) * 0.02;
    sigmaSource = "two_percent_baseline";
  }
  // BioFET: raw is in V, signal/slope are in mV → convert σ to mV.
  const sigma = mode === "fet" ? sigmaRaw * 1000 : sigmaRaw;
  return { value: (3 * sigma) / slope, loq: (10 * sigma) / slope, sigmaSource };
}

const CalibrationPanel = ({
  mode,
  concentration,
  onChangeConcentration,
  points,
  onClear,
  onExport,
  currentRs,
  currentRct,
  currentVt,
  currentVtBaseline,
  currentVtAnalyte,
  currentDeltaVt_mV,
  currentDeltaVtSigned_mV,
  currentCalibrationSignal_mV,
  currentVtMethod,
  currentVtFitR2,
  currentVtRegionPoints,
  currentVtWarning,
  currentPeakCurrentRaw_uA,
  currentPeakCurrentCorrected_uA,
  currentPeakPotential_V,
  responseMode = "auto",
  responseSign = 1,
  onResponseModeChange,
  geometricFallback,
  analyteName = "analyte",
  onAddCurrent,
  canAdd = false,
}: CalibrationPanelProps) => {
  const baseline = findBaseline(points);
  const hasBaseline = !!baseline;
  const [normalised, setNormalised] = useState(false);

  const sampleLabel =
    concentration === 0
      ? `Baseline (no ${analyteName})`
      : `Sample — ${concentration} nM ${analyteName}`;

  const signalUnit = mode === "eis" ? "Ω" : mode === "fet" ? "mV" : "µA";
  const signalKey = mode === "eis" ? "ΔRct" : mode === "fet" ? "ΔVt" : "Ip";
  const modeLabel = mode === "eis" ? "EIS" : mode === "fet" ? "BioFET" : "SWV";

  // For EIS-only normalisation: ΔRct% = ΔRct / Rct_baseline * 100
  const baselineRctRaw = useMemo(
    () => points.find((p) => p.concentration === 0)?.raw ?? null,
    [points],
  );
  const showNormalised = normalised && mode === "eis" && baselineRctRaw != null && baselineRctRaw > 0;
  const displayUnit = showNormalised ? "%" : signalUnit;
  const displayKey = showNormalised ? `${signalKey}%` : signalKey;

  // Build the points used for plotting / fitting.
  // - EIS: optional %-normalisation.
  // - BioFET: recompute the calibration signal from the ORIGINAL signed ΔVt
  //   (deltaVt_mV_signed) using the current responseMode/responseSign, so that
  //   toggling the response mode in the UI updates fit and chart coherently
  //   without ever mutating raw data.
  const transformedPoints = useMemo(() => {
    if (mode === "swv") return points;
    if (mode === "fet") {
      const sign: 1 | -1 = responseSign ?? 1;
      return points.map((p) => {
        const physical = p.deltaVt_mV_signed ?? p.signal;
        const cal = applyFETResponseMode(physical, responseMode, sign).calibrationSignal_mV_used;
        return { ...p, signal: cal };
      });
    }
    if (!showNormalised || !baselineRctRaw) return points;
    return points.map((p) => ({
      ...p,
      signal: (p.signal / baselineRctRaw) * 100,
    }));
  }, [points, mode, responseMode, responseSign, showNormalised, baselineRctRaw]);

  // Sort points by concentration for plotting
  const sortedPoints = useMemo(
    () => [...transformedPoints].sort((a, b) => a.concentration - b.concentration),
    [transformedPoints]
  );

  // Decide log scale if span > 2 decades
  const useLog = useMemo(() => {
    const nz = sortedPoints.filter((p) => p.concentration > 0);
    if (nz.length < 2) return false;
    const min = Math.min(...nz.map((p) => p.concentration));
    const max = Math.max(...nz.map((p) => p.concentration));
    return max / Math.max(min, 1e-9) > 100;
  }, [sortedPoints]);

  const fit = useMemo(
    () => (mode !== "swv" && transformedPoints.length >= 4 ? fitLangmuirNLLS(transformedPoints) : null),
    [transformedPoints, mode],
  );
  // SWV only — EIS/BioFET's fit is `fit` (Langmuir) above.
  const linear = useMemo(
    () =>
      mode === "swv" && transformedPoints.filter((p) => p.concentration > 0).length >= 2
        ? fitLinearSWV(transformedPoints)
        : null,
    [transformedPoints, mode],
  );
  // The single model that Sensitivity/R²/LOD/LOQ/quality below are all
  // derived from — Langmuir for EIS/BioFET (the same curve drawn on the
  // chart and summarised as Kd/Smax above), linear for SWV. Prior to this,
  // EIS/BioFET silently computed those from an unrelated straight-line fit
  // instead of the Langmuir curve actually being shown/reported, which
  // could understate low-concentration sensitivity (and inflate LOD) when
  // calibration points span into the saturating region.
  const effectiveFit = useMemo(() => {
    if (mode === "swv") {
      return linear
        ? { slope: linear.slope, r2: linear.r2, nPoints: linear.nPoints, intercept: linear.intercept as number | null }
        : null;
    }
    return fit
      ? { slope: fit.sMax / fit.kd, r2: fit.r2, nPoints: transformedPoints.length, intercept: null as number | null }
      : null;
  }, [mode, linear, fit, transformedPoints.length]);
  const lodResult = useMemo(
    () =>
      mode === "swv"
        ? computeLODSWV(transformedPoints)
        : computeLOD(transformedPoints, mode as "eis" | "fet", effectiveFit?.slope ?? null),
    [transformedPoints, mode, effectiveFit],
  );
  const lod = lodResult?.value ?? null;
  const loq = "loq" in (lodResult ?? {}) ? (lodResult as { loq?: number } | null)?.loq ?? null : null;

  // Same at-a-glance verdict CV's calibration panel already computes:
  // combines fit quality (R²), a positive slope, and enough points into one
  // GREEN/YELLOW/RED read, instead of leaving the user to eyeball R²/LOD
  // themselves.
  const quality = useMemo(() => {
    const reasons: string[] = [];
    const r2 = effectiveFit?.r2 ?? 0;
    const n = effectiveFit?.nPoints ?? 0;
    const slope = effectiveFit?.slope ?? 0;
    if (!effectiveFit || slope <= 0) reasons.push("slope ≤ 0");
    if (n < 3) reasons.push(`only ${n} usable point${n === 1 ? "" : "s"}`);
    let level: "green" | "yellow" | "red" | "idle";
    if (points.length === 0) {
      // Nothing measured yet: no verdict (a red "slope <= 0" here would be misleading).
      return { level: "idle" as const, reasons: ["add calibration measurements"] };
    }
    if (n >= 5 && r2 >= 0.995 && slope > 0 && lod != null) {
      level = "green";
    } else if (n >= 3 && r2 >= 0.98 && slope > 0) {
      level = "yellow";
      if (lod == null) reasons.push("LOD requires blank replicates or ≥3 fit points");
    } else {
      level = "red";
      if (effectiveFit && r2 < 0.98) reasons.push(`R² = ${r2.toFixed(3)} below 0.98`);
    }
    return { level, reasons };
  }, [effectiveFit, lod, points.length]);
  const qualityColor =
    quality.level === "green"
      ? "text-graph-eis"
      : quality.level === "yellow"
        ? "text-yellow-500"
        : quality.level === "idle"
          ? "text-muted-foreground"
          : "text-destructive";

  // Build smooth Langmuir curve points using fit
  const fitCurve = useMemo(() => {
    if (!fit) return [];
    const nz = sortedPoints.filter((p) => p.concentration > 0);
    if (nz.length < 1) return [];
    const minC = Math.min(...nz.map((p) => p.concentration));
    const maxC = Math.max(...nz.map((p) => p.concentration));
    const N = 50;
    const out: { concentration: number; fitSignal: number }[] = [];
    for (let i = 0; i <= N; i++) {
      let c: number;
      if (useLog) {
        const lo = Math.log10(Math.max(minC, 1e-3));
        const hi = Math.log10(maxC);
        c = Math.pow(10, lo + ((hi - lo) * i) / N);
      } else {
        c = minC + ((maxC - minC) * i) / N;
      }
      out.push({ concentration: c, fitSignal: (fit.sMax * c) / (c + fit.kd) });
    }
    return out;
  }, [fit, sortedPoints, useLog]);

  // Measured rows: one row per measurement — DO NOT aggregate by concentration,
  // and DO include blanks (0 nM) so replicates and baselines stay visible.
  const measuredRows = useMemo(
    () =>
      sortedPoints.map((p, i) => ({
        concentration: p.concentration,
        measured: p.signal,
        replicateIndex: i,
        measurementId: p.measurementId,
      })),
    [sortedPoints],
  );

  // Fit rows are a separate series for the Langmuir curve.
  const fitRows = useMemo(
    () => fitCurve.map((f) => ({ concentration: f.concentration, fitSignal: f.fitSignal })),
    [fitCurve],
  );

  const hasChartData = measuredRows.length > 0 || fitRows.length > 0;

  // Currently-displayed parameters
  const sampleRct = currentRct ?? null;
  const baselineRct = points.find((p) => p.concentration === 0)?.raw ?? null;
  const deltaRct =
    sampleRct != null && baselineRct != null && concentration > 0
      ? sampleRct - baselineRct
      : 0;

  // BioFET: prefer props from the *current measurement* (same sweep) over the
  // legacy "diff vs old blank in points[]" computation. ΔVt is the physical,
  // sign-preserved value computed by computeFETTransferMetrics.
  const liveVtAnalyte = currentVtAnalyte ?? currentVt ?? null;
  const liveVtBaseline = currentVtBaseline ?? null;
  const liveDeltaVt_mV =
    currentDeltaVt_mV ??
    currentDeltaVtSigned_mV ??
    (liveVtAnalyte != null && liveVtBaseline != null
      ? (liveVtAnalyte - liveVtBaseline) * 1000
      : null);

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Beaker className="h-4 w-4 text-primary" />
        <span className="font-mono text-sm text-foreground">Concentration & Calibration</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground uppercase">
          {modeLabel}
        </span>
      </div>

      {/* Concentration input */}
      <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-3 items-end">
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] font-mono uppercase text-muted-foreground">
            Sample Concentration (nM)
          </Label>
          <Input
            type="number"
            value={Number.isFinite(concentration) ? concentration : ""}
            min={0}
            step="any"
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              onChangeConcentration(Number.isFinite(n) ? Math.max(0, n) : 0);
            }}
            className="h-8 font-mono text-xs"
          />
        </div>
        <div className="text-xs font-mono text-muted-foreground">
          {sampleLabel}
        </div>
      </div>

      {/* EIS-only: ΔRct is computed relative to the stored 0 nM row
          (eisCalibration.find concentration===0) — without it every point
          silently falls back to ΔRct=0. BioFET's ΔVt comes from the
          baseline/analyte curves of the SAME sweep (no dependency on a
          stored calibration row) and SWV's signal is the peak current
          itself, so this warning would be a false alarm for either. */}
      {mode === "eis" && !hasBaseline && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs font-mono text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Please measure baseline (0 nM) first
        </div>
      )}

      {/* Live parameters box */}
      {mode === "eis" && (
        <div className="grid grid-cols-1 gap-2">
          <div className="bg-secondary rounded-md p-2">
            <div className="text-[10px] text-muted-foreground font-mono uppercase">ΔRct</div>
            <div className="text-sm font-mono text-foreground">
              {`${deltaRct.toFixed(1)} Ω`}
            </div>
            {geometricFallback && (
              <div className="text-[9px] font-mono text-yellow-500 leading-tight mt-0.5">
                ⚠ Fit did not converge — using geometric estimate
              </div>
            )}
          </div>
        </div>
      )}
      {mode === "fet" && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div className="bg-secondary rounded-md p-2">
              <div className="text-[10px] text-muted-foreground font-mono uppercase">Vt baseline</div>
              <div className="text-sm font-mono text-foreground">
                {liveVtBaseline != null ? `${liveVtBaseline.toFixed(3)} V` : "—"}
              </div>
            </div>
            <div className="bg-secondary rounded-md p-2">
              <div className="text-[10px] text-muted-foreground font-mono uppercase">Vt analyte</div>
              <div className="text-sm font-mono text-foreground">
                {liveVtAnalyte != null ? `${liveVtAnalyte.toFixed(3)} V` : "—"}
              </div>
            </div>
            <div className="bg-secondary rounded-md p-2">
              <div className="text-[10px] text-muted-foreground font-mono uppercase">ΔVt (signed)</div>
              <div className="text-sm font-mono text-foreground">
                {liveDeltaVt_mV != null ? `${liveDeltaVt_mV >= 0 ? "+" : ""}${liveDeltaVt_mV.toFixed(1)} mV` : "—"}
              </div>
            </div>
          </div>
          {onResponseModeChange && (
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-muted-foreground">
              <span className="uppercase">Response mode</span>
              <Select
                value={responseMode}
                onValueChange={(v) => onResponseModeChange(v as "auto" | "signed" | "absolute")}
              >
                <SelectTrigger className="h-6 w-[110px] font-mono text-[10px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto" className="font-mono text-xs">Auto</SelectItem>
                  <SelectItem value="signed" className="font-mono text-xs">Signed</SelectItem>
                  <SelectItem value="absolute" className="font-mono text-xs">Absolute</SelectItem>
                </SelectContent>
              </Select>
              {responseSign != null && (
                <span>sign={responseSign > 0 ? "+1" : "-1"}</span>
              )}
              {currentCalibrationSignal_mV != null && (
                <span>· cal signal={currentCalibrationSignal_mV.toFixed(1)} mV</span>
              )}
            </div>
          )}
          {(currentVtMethod || currentVtFitR2 != null || currentVtRegionPoints != null || currentVtWarning) && (
            <div className="rounded-md bg-secondary/60 p-2 text-[10px] font-mono text-muted-foreground space-y-0.5">
              <div className="uppercase text-[9px] tracking-wide">Vt diagnostics</div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {currentVtMethod && <span>method=<span className="text-foreground">{currentVtMethod}</span></span>}
                {currentVtFitR2 != null && <span>R²=<span className="text-foreground">{currentVtFitR2.toFixed(3)}</span></span>}
                {currentVtRegionPoints != null && <span>N={currentVtRegionPoints}</span>}
              </div>
              {currentVtWarning && (
                <div className="text-yellow-500">⚠ {currentVtWarning}</div>
              )}
            </div>
          )}
        </div>
      )}
      {mode === "swv" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div className="bg-secondary rounded-md p-2">
            <div className="text-[10px] text-muted-foreground font-mono uppercase">Ip raw</div>
            <div className="text-sm font-mono text-foreground">
              {currentPeakCurrentRaw_uA != null ? `${currentPeakCurrentRaw_uA.toFixed(2)} µA` : "—"}
            </div>
          </div>
          <div className="bg-secondary rounded-md p-2">
            <div className="text-[10px] text-muted-foreground font-mono uppercase">Ip corrected</div>
            <div className="text-sm font-mono text-foreground">
              {currentPeakCurrentCorrected_uA != null ? `${currentPeakCurrentCorrected_uA.toFixed(2)} µA` : "—"}
            </div>
          </div>
          <div className="bg-secondary rounded-md p-2">
            <div className="text-[10px] text-muted-foreground font-mono uppercase">Ep</div>
            <div className="text-sm font-mono text-foreground">
              {currentPeakPotential_V != null ? `${currentPeakPotential_V.toFixed(3)} V` : "—"}
            </div>
          </div>
        </div>
      )}

      {onAddCurrent && (
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
      )}

      {/* Calibration chart */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-mono uppercase text-muted-foreground">
            Calibration Curve
          </span>
          <div className="flex items-center gap-3">
            {mode === "eis" && (
              <label className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground cursor-pointer">
                <Switch
                  checked={normalised}
                  onCheckedChange={setNormalised}
                  disabled={!baselineRctRaw}
                  className="h-4 w-7"
                />
                Normalised (ΔRct/Rct₀ %)
              </label>
            )}
            {fit && (
              <span className="text-[10px] font-mono text-primary">
                Kd = {fit.kd.toFixed(2)} nM (R² = {fit.r2.toFixed(3)}) · Max {displayKey} = {fit.sMax.toFixed(1)} {displayUnit}
              </span>
            )}
          </div>
        </div>
        <div className="h-[180px] bg-background rounded-md border border-border p-1">
          {!hasChartData ? (
            <div className="flex h-full items-center justify-center text-[11px] font-mono text-muted-foreground">
              No measurements yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="concentration"
                  type="number"
                  scale={useLog ? "log" : "linear"}
                  domain={useLog ? ["auto", "auto"] : [0, "auto"]}
                  tick={{ fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
                  label={{
                    value: "Concentration (nM)",
                    position: "insideBottom",
                    offset: -2,
                    style: { fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" },
                  }}
                  allowDataOverflow
                />
                <YAxis
                  tick={{ fontSize: 10, fontFamily: "monospace", fill: "hsl(var(--muted-foreground))" }}
                  label={{
                    value: `${displayKey} (${displayUnit})`,
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
                  formatter={(value: number) =>
                    typeof value === "number" ? value.toFixed(2) : value
                  }
                />
                {lod != null && (
                  <ReferenceLine
                    x={lod}
                    stroke="hsl(var(--destructive))"
                    strokeDasharray="4 4"
                    label={{
                      value: `LOD ${lod.toFixed(2)} nM`,
                      fill: "hsl(var(--destructive))",
                      fontSize: 10,
                      position: "top",
                    }}
                  />
                )}
                <Line
                  type="monotone"
                  data={fitRows}
                  dataKey="fitSignal"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Scatter
                  data={measuredRows}
                  dataKey="measured"
                  fill="hsl(var(--primary))"
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Kd estimation summary */}
      {points.length >= 4 && fit && (
        <div className="rounded-md bg-secondary/60 p-2 text-xs font-mono text-foreground">
          <div>Estimated Kd<InfoHint text="Dissociation constant from the fitted binding curve. Lower Kd = higher aptamer/analyte affinity. Fitted via nonlinear least squares on the Langmuir isotherm." />: <span className="text-primary">{fit.kd.toFixed(2)} nM</span> <span className="text-muted-foreground">(R² = {fit.r2.toFixed(3)})</span></div>
          <div>Max {displayKey}: <span className="text-primary">{fit.sMax.toFixed(2)} {displayUnit}</span></div>
          {!fit.converged && (
            <div className="text-[10px] text-destructive mt-1">
              ⚠ Langmuir fit did not converge — Kd is a rough starting estimate, not a fitted value
            </div>
          )}
          {fit.converged && fit.r2 < 0.9 && (
            <div className="text-[10px] text-yellow-500 mt-1">
              ⚠ Poor Langmuir fit (R² &lt; 0.90) — more calibration points recommended
            </div>
          )}
        </div>
      )}
      <div className="rounded-md bg-secondary/60 p-2 text-xs font-mono text-foreground space-y-0.5">
        <div>
          Sensitivity<InfoHint text={mode === "swv" ? "Slope of the linear calibration fit." : "Slope of the Langmuir fit at the low-concentration limit (Smax/Kd) — the sensitivity of the same curve drawn above, not a separate straight-line fit."} />:{" "}
          <span className="text-primary">
            {effectiveFit ? `${effectiveFit.slope.toFixed(3)} ${displayUnit}/nM` : "—"}
          </span>
        </div>
        {mode === "swv" && (
          <div>
            Intercept<InfoHint text="Fitted signal at C = 0 (b in signal = m·C + b), from the positive-concentration points. Compare it with the measured blank: a large gap points to background or a poor blank." />:{" "}
            <span className="text-primary">
              {effectiveFit?.intercept != null ? `${effectiveFit.intercept.toFixed(3)} ${displayUnit}` : "—"}
            </span>
          </div>
        )}
        <div>
          R²<InfoHint text="Coefficient of determination for the calibration fit. Closer to 1.0 indicates the model explains the concentration-response relationship well." />:{" "}
          <span className="text-primary">{effectiveFit ? effectiveFit.r2.toFixed(4) : "—"}</span>
        </div>
        <div>
          LOD (3σ/|slope|)<InfoHint text="Limit of Detection = 3σ(blank) / slope. The lowest concentration reliably distinguishable from a blank measurement." />:{" "}
          <span className="text-primary">{lod != null ? `${lod.toFixed(2)} nM` : "—"}</span>
          {lod != null && (
            <span className="text-muted-foreground"> · σ from {lodResult?.sigmaSource === "replicates" ? "blank replicates" : mode === "swv" ? "residuals" : "2% baseline"}</span>
          )}
        </div>
        <div>
          LOQ (10σ/|slope|)<InfoHint text="Limit of Quantitation = 10σ(blank) / slope. The lowest concentration that can be quantified with acceptable precision." />:{" "}
          <span className="text-primary">{loq != null ? `${loq.toFixed(2)} nM` : "—"}</span>
        </div>
        <div>
          quality<InfoHint text="At-a-glance verdict combining R², a positive slope, and point count. Green requires ≥5 points, R² ≥ 0.995 and an LOD. Yellow needs ≥3 points and R² ≥ 0.98." />:{" "}
          <span className={`uppercase ${qualityColor}`}>{quality.level === "idle" ? "—" : quality.level}</span>
          {quality.reasons.length > 0 && (
            <span className="text-muted-foreground"> · {quality.reasons.join(" · ")}</span>
          )}
        </div>
      </div>
      {points.length > 0 && points.length < 4 && mode !== "swv" && (
        <div className="text-[11px] font-mono text-muted-foreground">
          Need {4 - points.length} more measurement(s) for Kd estimation
        </div>
      )}
      {mode === "swv" && points.filter((p) => p.concentration > 0).length > 0 && points.filter((p) => p.concentration > 0).length < 2 && (
        <div className="text-[11px] font-mono text-muted-foreground">
          Need {2 - points.filter((p) => p.concentration > 0).length} more positive-concentration measurement(s) for linear calibration
        </div>
      )}

      {/* Calibration table */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-mono uppercase text-muted-foreground">
            Measurements ({points.length})
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
                <TableHead className="h-8 text-[10px] font-mono uppercase">Conc (nM)</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">
                  {signalKey} ({signalUnit})
                </TableHead>
                {mode === "swv" && (
                  <>
                    <TableHead className="h-8 text-[10px] font-mono uppercase">Raw (µA)</TableHead>
                    <TableHead className="h-8 text-[10px] font-mono uppercase">Ep (V)</TableHead>
                    <TableHead className="h-8 text-[10px] font-mono uppercase">SNR</TableHead>
                  </>
                )}
                <TableHead className="h-8 text-[10px] font-mono uppercase">Sample</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">Electrode</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">Meas. ID</TableHead>
                <TableHead className="h-8 text-[10px] font-mono uppercase">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {points.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={mode === "swv" ? 9 : 6} className="text-[11px] font-mono text-muted-foreground py-3 text-center">
                    No measurements yet
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
                      <TableCell className="py-1.5 text-xs font-mono">{p.concentration}</TableCell>
                      <TableCell className="py-1.5 text-xs font-mono">{p.signal.toFixed(2)}</TableCell>
                      {mode === "swv" && (
                        <>
                          <TableCell className="py-1.5 text-xs font-mono">{p.raw != null ? p.raw.toFixed(2) : "—"}</TableCell>
                          <TableCell className="py-1.5 text-xs font-mono">{p.peakPotential_V != null ? p.peakPotential_V.toFixed(3) : "—"}</TableCell>
                          <TableCell className="py-1.5 text-xs font-mono">{p.snr != null ? p.snr.toFixed(1) : "—"}</TableCell>
                        </>
                      )}
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

export default CalibrationPanel;