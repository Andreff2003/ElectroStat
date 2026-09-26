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
import { computeFETQuality } from "@/utils/fetQuality";

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

  // Ion/Ioff, subthreshold slope, off-current and baseline noise are the panel's own estimators
  // (utils/fetQuality.ts), so the numbers exported with a measurement are the ones the operator saw.
  const quality = computeFETQuality(analyte, baseline);
  const ion = quality.ready ? quality.ion : null;
  const ioff = quality.ready ? quality.ioff : null;
  const ratio = quality.ready ? quality.ionIoff : null;
  const ss = quality.ready && quality.subthresholdSlope > 0 ? quality.subthresholdSlope : null;
  const baselineStability = quality.ready && quality.stabilityLevel !== "idle" ? quality.baselineStability : null;

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
