/**
 * BioFET metrics — centralised helper.
 *
 * All BioFET final results (UI, session, CSV, calibration) MUST go through
 * `computeFETTransferMetrics` so the same numbers, the same Vt method, and
 * the same sign convention are used everywhere.
 *
 * Raw data are never modified by `responseMode`. ΔVt is always computed
 * vtAnalyte − vtBaseline from the SAME measurement. `responseMode` only
 * affects the *calibration* signal (Langmuir fit input):
 *   - signed   : calibrationSignal = ΔVt
 *   - absolute : calibrationSignal = |ΔVt|
 *   - auto     : inferred sign from existing positive-C points, then
 *                calibrationSignal = responseSign * ΔVt
 */
import type { FETTransferPoint } from "@/hooks/useSimulatedData";
import { computeFETVtDetailed as _vtDetailed } from "@/utils/fetVt";
import { fetOnStateNoisePct } from "@/utils/fetNoise";

export type FETResponseMode = "auto" | "signed" | "absolute";

export interface FETVtDetailedResult {
  vt: number | null;
  method: "sqrt_extrapolation" | "constant_current_fallback" | "invalid";
  fitR2?: number | null;
  regionPoints?: number;
  ioffUsed?: number;
  warning?: string;
}

export interface FETTransferMetrics {
  vtBaseline: number | null;
  vtAnalyte: number | null;
  deltaVt_mV: number | null;          // signed; this is the physical ΔVt
  deltaVt_mV_signed: number | null;   // alias, kept for clarity in exports

  vtBaselineMethod?: FETVtDetailedResult["method"];
  vtAnalyteMethod?: FETVtDetailedResult["method"];
  vtMethod?: FETVtDetailedResult["method"]; // analyte method (final)

  vtBaselineFitR2?: number | null;
  vtAnalyteFitR2?: number | null;
  vtFitR2?: number | null;

  vtBaselineRegionPoints?: number;
  vtAnalyteRegionPoints?: number;
  vtRegionPoints?: number;

  vtBaselineIoffUsed?: number;
  vtAnalyteIoffUsed?: number;
  vtIoffUsed?: number;

  vtBaselineWarning?: string;
  vtAnalyteWarning?: string;
  vtWarning?: string;

  ion_uA?: number | null;
  ioff_uA?: number | null;
  ionIoffRatio?: number | null;
  subthresholdSlope_mV_dec?: number | null;
  baselineStabilityNoisePct?: number | null;

  responseMode?: FETResponseMode;
  responseSign?: 1 | -1;
  calibrationSignal_mV_used?: number | null;

  warnings?: string[];
}

export function computeFETVtDetailed(
  curve: FETTransferPoint[],
): FETVtDetailedResult {
  const r = _vtDetailed(curve);
  return {
    vt: r.vt,
    method: r.method,
    fitR2: r.fitR2,
    regionPoints: r.regionPoints,
    ioffUsed: r.ioffUsed,
    warning: r.warning,
  };
}

/** Pick sign from prior positive-C calibration entries' signed ΔVt. */
export function inferFETResponseSign(
  priorSignedDeltaVt_mV: number[],
): 1 | -1 {
  if (!priorSignedDeltaVt_mV || priorSignedDeltaVt_mV.length === 0) return 1;
  const sum = priorSignedDeltaVt_mV.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return sum >= 0 ? 1 : -1;
}

export function applyFETResponseMode(
  signal_mV: number,
  mode: FETResponseMode,
  sign: 1 | -1 = 1,
): { signedSignal_mV: number; calibrationSignal_mV_used: number; responseSign: 1 | -1 } {
  if (mode === "absolute") {
    return { signedSignal_mV: signal_mV, calibrationSignal_mV_used: Math.abs(signal_mV), responseSign: sign };
  }
  if (mode === "signed") {
    return { signedSignal_mV: signal_mV, calibrationSignal_mV_used: signal_mV, responseSign: 1 };
  }
  // auto
  return { signedSignal_mV: signal_mV, calibrationSignal_mV_used: sign * signal_mV, responseSign: sign };
}

/** Ion (95th pct), Ioff (5th pct) on analyte curve. */
function computeIonIoff(curve: FETTransferPoint[]): { ion: number | null; ioff: number | null } {
  const ids = curve.map((p) => p.id).filter((v) => Number.isFinite(v));
  if (ids.length < 5) return { ion: null, ioff: null };
  const sorted = [...ids].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  return { ion: pct(0.95), ioff: Math.max(pct(0.05), 1e-12) };
}

/** Subthreshold slope (mV/dec) — linear fit of Vg vs log10(Id) on subthreshold region. */
function computeSS(curve: FETTransferPoint[]): number | null {
  const clean = curve.filter((p) => p.id > 0 && Number.isFinite(p.vg)).sort((a, b) => a.vg - b.vg);
  if (clean.length < 5) return null;
  const ids = clean.map((p) => p.id);
  const sorted = [...ids].sort((a, b) => a - b);
  const ioff = Math.max(sorted[Math.floor(0.05 * (sorted.length - 1))], 1e-12);
  const ion = sorted[Math.floor(0.95 * (sorted.length - 1))];
  if (!(ion > ioff)) return null;
  const lo = ioff * 2;
  const hi = ioff * 100;
  const region = clean.filter((p) => p.id >= lo && p.id <= hi);
  if (region.length < 3) return null;
  const xs = region.map((p) => p.vg);
  const ys = region.map((p) => Math.log10(p.id));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (sxx < 1e-18) return null;
  const slope = sxy / sxx; // dec / V
  if (Math.abs(slope) < 1e-9) return null;
  return Math.abs(1000 / slope); // mV/dec
}

export interface FETMetricsOptions {
  responseMode?: FETResponseMode;
  responseSign?: 1 | -1;
}

export function computeFETTransferMetrics(
  baseline: FETTransferPoint[],
  analyte: FETTransferPoint[],
  opts: FETMetricsOptions = {},
): FETTransferMetrics {
  const responseMode: FETResponseMode = opts.responseMode ?? "signed";
  const responseSign: 1 | -1 = opts.responseSign ?? 1;

  let vb = computeFETVtDetailed(baseline);
  let va = computeFETVtDetailed(analyte);
  // Read both curves the same way. If only one of them needed the constant-current
  // fallback, re-read the other with it too: the shift between thresholds found by
  // different methods is off by hundreds of mV (see fetVt.ts, forceFallback).
  let sameMethodForced = false;
  const isFb = (m: string) => m === "constant_current_fallback";
  if (vb.method !== va.method && (isFb(vb.method) || isFb(va.method)) && vb.method !== "invalid" && va.method !== "invalid") {
    if (isFb(va.method)) vb = _vtDetailed(baseline, { forceFallback: true });
    else va = _vtDetailed(analyte, { forceFallback: true });
    sameMethodForced = true;
  }

  const vtBaseline = vb.vt;
  const vtAnalyte = va.vt;
  const deltaVt_mV =
    vtBaseline != null && vtAnalyte != null ? (vtAnalyte - vtBaseline) * 1000 : null;

  let calibrationSignal_mV_used: number | null = null;
  if (deltaVt_mV != null) {
    calibrationSignal_mV_used = applyFETResponseMode(deltaVt_mV, responseMode, responseSign).calibrationSignal_mV_used;
  }

  const { ion, ioff } = computeIonIoff(analyte);
  const ratio = ion != null && ioff != null && ioff > 0 ? ion / ioff : null;
  const ss = computeSS(analyte);

  // Baseline noise: scatter of the baseline curve around its own smooth on-state
  // trend (see fetOnStateNoisePct). The former whole-curve std/mean read ~140 %
  // on any sweep that spans off to on, because it measured the shape of the curve.
  const baselineStability = fetOnStateNoisePct(baseline);

  const warnings: string[] = [];
  if (sameMethodForced) {
    warnings.push("ΔVt uses the constant-current method on both curves (square-root extraction failed on one); it reads about 35 % low but consistently.");
  }
  if (vb.warning) warnings.push(`baseline: ${vb.warning}`);
  if (va.warning) warnings.push(`analyte: ${va.warning}`);

  return {
    vtBaseline,
    vtAnalyte,
    deltaVt_mV,
    deltaVt_mV_signed: deltaVt_mV,
    vtBaselineMethod: vb.method,
    vtAnalyteMethod: va.method,
    vtMethod: va.method,
    vtBaselineFitR2: vb.fitR2 ?? null,
    vtAnalyteFitR2: va.fitR2 ?? null,
    vtFitR2: va.fitR2 ?? null,
    vtBaselineRegionPoints: vb.regionPoints,
    vtAnalyteRegionPoints: va.regionPoints,
    vtRegionPoints: va.regionPoints,
    vtBaselineIoffUsed: vb.ioffUsed,
    vtAnalyteIoffUsed: va.ioffUsed,
    vtIoffUsed: va.ioffUsed,
    vtBaselineWarning: vb.warning,
    vtAnalyteWarning: va.warning,
    vtWarning: va.warning,
    ion_uA: ion,
    ioff_uA: ioff,
    ionIoffRatio: ratio,
    subthresholdSlope_mV_dec: ss,
    baselineStabilityNoisePct: baselineStability,
    responseMode,
    responseSign,
    calibrationSignal_mV_used,
    warnings: warnings.length ? warnings : undefined,
  };
}
