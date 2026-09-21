import type { CVMetrics } from "@/utils/computeCVMetrics";
import {
  CV_RS_PREFACTOR as RS_PREFACTOR,
  CV_DEFAULT_D_CM2_S,
} from "@/utils/cvConstants";

export type CVResponseMode = "mean" | "anodic" | "cathodic";

export interface CVCalibrationPoint {
  concentration_mM: number;
  Ipa_uA: number | null;
  IpcAbs_uA: number | null;
  responseMean_uA: number | null;
  deltaEp_mV: number | null;
  ratio: number | null;
  Dapparent: number | null;
  cvModel: "reversible" | "quasi-reversible";
  timestamp: number;
  // Traceability — optional, for linking back to the source measurement.
  measurementId?: string;
  sampleId?: string;
  electrodeId?: string;
  notes?: string; // short summary, free-form
}

export interface LinearFit {
  slope: number;         // µA / mM
  intercept: number;     // µA
  r2: number;
  nPoints: number;
  residuals: number[];
  sigmaResidual: number; // µA
}

/** Pick the response value (µA) for a given mode from a calibration point. */
export function responseFor(p: CVCalibrationPoint, mode: CVResponseMode): number | null {
  if (mode === "anodic") return p.Ipa_uA;
  if (mode === "cathodic") return p.IpcAbs_uA;
  return p.responseMean_uA;
}

export interface BuildCVCalibrationPointMeta {
  measurementId?: string;
  sampleId?: string;
  electrodeId?: string;
  /** Short single-line summary; long notes should be summarised by the caller. */
  notes?: string;
  timestamp?: number;
}

/** Build a calibration point from CV metrics + concentration. */
export function buildCVCalibrationPoint(
  concentration_mM: number,
  metrics: CVMetrics | null,
  cvModel: "reversible" | "quasi-reversible",
  meta?: BuildCVCalibrationPointMeta,
): CVCalibrationPoint {
  const Ipa = metrics && Number.isFinite(metrics.IpaCorrected) ? metrics.IpaCorrected : null;
  const IpcAbs =
    metrics && Number.isFinite(metrics.IpcCorrected) ? Math.abs(metrics.IpcCorrected) : null;
  const mean =
    Ipa != null && IpcAbs != null
      ? (Ipa + IpcAbs) / 2
      : Ipa != null
        ? Ipa
        : IpcAbs;
  return {
    concentration_mM,
    Ipa_uA: Ipa,
    IpcAbs_uA: IpcAbs,
    responseMean_uA: mean ?? null,
    deltaEp_mV: metrics && Number.isFinite(metrics.deltaEp) ? metrics.deltaEp : null,
    ratio: metrics && Number.isFinite(metrics.IpaIpcRatio) ? metrics.IpaIpcRatio : null,
    Dapparent: metrics && metrics.D_valid ? metrics.D_apparent : null,
    cvModel,
    timestamp: meta?.timestamp ?? Date.now(),
    measurementId: meta?.measurementId,
    sampleId: meta?.sampleId,
    electrodeId: meta?.electrodeId,
    notes: meta?.notes,
  };
}

/** Ordinary least squares linear regression. */
export function fitLinearOLS(xs: number[], ys: number[]): LinearFit | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx < 1e-12) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const residuals = xs.map((x, i) => ys[i] - (slope * x + intercept));
  const ssRes = residuals.reduce((a, r) => a + r * r, 0);
  const r2 = syy < 1e-12 ? 1 : 1 - ssRes / syy;
  const sigmaResidual = n > 2 ? Math.sqrt(ssRes / (n - 2)) : Math.sqrt(ssRes / n);
  return { slope, intercept, r2, nPoints: n, residuals, sigmaResidual };
}

/**
 * Estimate blank noise (sigma, µA) from blank replicates (C=0). Falls back
 * to residual sigma from the linear fit when too few blanks are present.
 */
export function estimateSigmaBlank(
  points: CVCalibrationPoint[],
  mode: CVResponseMode,
  fitSigmaResidual: number | null,
): number | null {
  const blanks = points
    .filter((p) => p.concentration_mM === 0)
    .map((p) => responseFor(p, mode))
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (blanks.length >= 3) {
    const m = blanks.reduce((a, b) => a + b, 0) / blanks.length;
    return Math.sqrt(blanks.reduce((a, v) => a + (v - m) ** 2, 0) / (blanks.length - 1));
  }
  return fitSigmaResidual && fitSigmaResidual > 0 ? fitSigmaResidual : null;
}

/** LOD = 3·σ / slope (mM). */
export function computeLOD(sigmaBlank: number | null, slope: number): number | null {
  if (sigmaBlank == null || !(slope > 0)) return null;
  return (3 * sigmaBlank) / slope;
}
/** LOQ = 10·σ / slope (mM). */
export function computeLOQ(sigmaBlank: number | null, slope: number): number | null {
  if (sigmaBlank == null || !(slope > 0)) return null;
  return (10 * sigmaBlank) / slope;
}

/**
 * Randles–Ševčík expected peak current (µA) for a reversible diffusion-
 * controlled system at 25 °C.
 */
export function randlesSevcikIpUA(opts: {
  n: number;
  areaCm2: number;
  cMM: number;
  scanRate_mVs: number;
  D_cm2s?: number;
}): number | null {
  const D = opts.D_cm2s ?? CV_DEFAULT_D_CM2_S;
  if (!(opts.n > 0) || !(opts.areaCm2 > 0) || !(opts.cMM >= 0) || !(opts.scanRate_mVs > 0)) return null;
  const cBulk = opts.cMM * 1e-6;            // mol/cm³
  const vVs = opts.scanRate_mVs / 1000;     // V/s
  const ipA =
    RS_PREFACTOR * Math.pow(opts.n, 1.5) * opts.areaCm2 * cBulk * Math.sqrt(D * vVs);
  return ipA * 1e6;
}

/** "idle" = no measurements yet: nothing to judge, so no verdict. */
export type CVCalibrationQuality = "green" | "yellow" | "red" | "idle";
export type CVSigmaSource = "blank-replicates" | "fit-residual" | "none";

export interface CVCalibrationSummary {
  fit: LinearFit | null;
  sigmaBlank: number | null;
  sigma_uA: number | null;
  sigmaSource: CVSigmaSource;
  lod_mM: number | null;
  loq_mM: number | null;
  quality: CVCalibrationQuality;
  qualityReasons: string[];
  nPoints: number;
  nUniqueConcentrations: number;
  nBlankReplicates: number;
}

export function summarizeCalibration(
  points: CVCalibrationPoint[],
  mode: CVResponseMode,
): CVCalibrationSummary {
  const usable = points
    .map((p) => ({ c: p.concentration_mM, y: responseFor(p, mode) }))
    .filter((p) => p.y != null && Number.isFinite(p.y)) as { c: number; y: number }[];
  const fit =
    usable.length >= 2 ? fitLinearOLS(usable.map((p) => p.c), usable.map((p) => p.y)) : null;

  // Decide sigma source independently so the UI can explain it.
  const blanks = points
    .filter((p) => p.concentration_mM === 0)
    .map((p) => responseFor(p, mode))
    .filter((v): v is number => v != null && Number.isFinite(v));
  let sigma_uA: number | null = null;
  let sigmaSource: CVSigmaSource = "none";
  if (blanks.length >= 3) {
    const m = blanks.reduce((a, b) => a + b, 0) / blanks.length;
    sigma_uA = Math.sqrt(blanks.reduce((a, v) => a + (v - m) ** 2, 0) / (blanks.length - 1));
    sigmaSource = "blank-replicates";
  } else if (fit && fit.sigmaResidual > 0) {
    sigma_uA = fit.sigmaResidual;
    sigmaSource = "fit-residual";
  }
  const slope = fit?.slope ?? 0;
  const lod = computeLOD(sigma_uA, slope);
  const loq = computeLOQ(sigma_uA, slope);

  const reasons: string[] = [];
  let quality: CVCalibrationQuality = "red";
  const r2 = fit?.r2 ?? 0;
  const n = fit?.nPoints ?? 0;
  if (points.length === 0) {
    quality = "idle";
    reasons.push("add calibration measurements");
  } else {
    if (slope <= 0) reasons.push("slope ≤ 0");
    if (n < 3) reasons.push(`only ${n} usable points`);
    if (n >= 5 && r2 >= 0.995 && slope > 0 && lod != null) {
      quality = "green";
    } else if (n >= 3 && r2 >= 0.98 && slope > 0) {
      quality = "yellow";
      if (lod == null) reasons.push("LOD requires blank replicates or ≥3 fit points");
    } else {
      quality = "red";
      if (r2 < 0.98) reasons.push(`R² = ${r2.toFixed(3)} below 0.98`);
    }
  }
  const uniqueC = new Set(points.map((p) => p.concentration_mM)).size;
  return {
    fit,
    sigmaBlank: sigmaSource === "blank-replicates" ? sigma_uA : null,
    sigma_uA,
    sigmaSource,
    lod_mM: lod,
    loq_mM: loq,
    quality,
    qualityReasons: reasons,
    nPoints: points.length,
    nUniqueConcentrations: uniqueC,
    nBlankReplicates: blanks.length,
  };
}