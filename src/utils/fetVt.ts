/**
 * BioFET Vt extraction — sqrt(Id) linear extrapolation
 *
 * For an ideal long-channel MOSFET in saturation:
 *     Id ≈ K · (Vg − Vt)^2
 * therefore
 *     sqrt(Id) ≈ sqrt(K) · (Vg − Vt)
 *
 * Fitting a straight line y = a·Vg + b on the strong-inversion region gives
 *     Vt = −b / a
 *
 * The previous "Vg @ 10% of Ion" method is biased: for a perfect quadratic
 * with Vt and VgMax it returns Vt + sqrt(0.1)·(VgMax − Vt), so ΔVt is
 * under-estimated by a factor (1 − sqrt(0.1)) ≈ 0.684.
 */
import type { FETTransferPoint } from "@/hooks/useSimulatedData";

export type VtMethod =
  | "sqrt_extrapolation"
  | "constant_current_fallback"
  | "invalid";

export interface VtResult {
  vt: number | null;
  method: VtMethod;
  fitR2: number | null;
  regionPoints: number;
  ioffUsed: number;
  warning?: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function linReg(xs: number[], ys: number[]): { a: number; b: number; r2: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-18) return null;
  const a = sxy / sxx;
  const b = meanY - a * meanX;
  const r2 = syy < 1e-18 ? 1 : 1 - (syy - a * sxy) / syy;
  return { a, b, r2 };
}

export interface VtOptions {
  /** Fraction of Ion to start the strong-inversion window (default 0.2). */
  lowFrac?: number;
  /** Fraction of Ion to stop the window (default 0.8). */
  highFrac?: number;
  /** Minimum points in the fit window (default 4). */
  minPoints?: number;
  /** R² threshold below which we declare the sqrt fit invalid (default 0.8). */
  minR2?: number;
  /**
   * Skip the sqrt fit and read Vt with the constant-current method. Used by
   * computeFETTransferMetrics so that both curves of one measurement are read
   * the same way: the two methods place the threshold in different places
   * (the fallback sits 0.2-0.3 V above the sqrt value), so a shift taken
   * between one curve of each kind is off by hundreds of mV.
   */
  forceFallback?: boolean;
}

export function computeFETVtDetailed(
  curve: FETTransferPoint[],
  opts: VtOptions = {},
): VtResult {
  const lowFrac = opts.lowFrac ?? 0.2;
  const highFrac = opts.highFrac ?? 0.8;
  const minPoints = opts.minPoints ?? 4;
  const minR2 = opts.minR2 ?? 0.8;

  const clean = curve
    .filter((p) => Number.isFinite(p.vg) && Number.isFinite(p.id))
    .sort((a, b) => a.vg - b.vg);

  if (clean.length < 5) {
    return { vt: null, method: "invalid", fitR2: null, regionPoints: 0, ioffUsed: 0,
      warning: "Not enough points" };
  }

  // Robust Ioff: 5th percentile of raw Id (handles ascending Vg curves where
  // lowest Vg is deep sub-threshold).
  const sortedIds = [...clean.map((p) => p.id)].sort((a, b) => a - b);
  const ioff = percentile(sortedIds, 0.05);
  const idCorr = clean.map((p) => Math.max(p.id - ioff, 0));
  const sortedCorr = [...idCorr].sort((a, b) => a - b);
  const ion = percentile(sortedCorr, 0.95);

  if (!(ion > 1e-9)) {
    return { vt: null, method: "invalid", fitR2: null, regionPoints: 0, ioffUsed: ioff,
      warning: "Ion not detectable" };
  }

  // Strong-inversion window
  const region: { vg: number; idc: number }[] = [];
  for (let i = 0; i < clean.length; i++) {
    const f = idCorr[i] / ion;
    if (f >= lowFrac && f <= highFrac) region.push({ vg: clean[i].vg, idc: idCorr[i] });
  }

  // sqrt(Id) linear fit
  if (!opts.forceFallback && region.length >= minPoints) {
    const xs = region.map((r) => r.vg);
    const ys = region.map((r) => Math.sqrt(Math.max(r.idc, 0)));
    const fit = linReg(xs, ys);
    if (fit && fit.a > 0 && fit.r2 >= minR2) {
      const vt = -fit.b / fit.a;
      if (Number.isFinite(vt)) {
        return {
          vt,
          method: "sqrt_extrapolation",
          fitR2: fit.r2,
          regionPoints: region.length,
          ioffUsed: ioff,
        };
      }
    }
  }

  // Fallback: constant-current (Vg @ Id = 10% of Ion above Ioff)
  const target = 0.1 * ion;
  for (let i = 1; i < clean.length; i++) {
    if (idCorr[i] >= target) {
      const a = { vg: clean[i - 1].vg, idc: idCorr[i - 1] };
      const b = { vg: clean[i].vg, idc: idCorr[i] };
      const vt = b.idc === a.idc ? b.vg : a.vg + ((target - a.idc) / (b.idc - a.idc)) * (b.vg - a.vg);
      return {
        vt,
        method: "constant_current_fallback",
        fitR2: null,
        regionPoints: region.length,
        ioffUsed: ioff,
        warning: opts.forceFallback
          ? "constant-current 10% Ion, to match the other curve of the measurement"
          : "sqrt fit unreliable — using constant-current 10% Ion",
      };
    }
  }

  return {
    vt: null, method: "invalid", fitR2: null,
    regionPoints: region.length, ioffUsed: ioff,
    warning: "Could not extract Vt",
  };
}

/** Backwards-compatible scalar API. */
export function computeFETVt(curve: FETTransferPoint[]): number | null {
  return computeFETVtDetailed(curve).vt;
}
