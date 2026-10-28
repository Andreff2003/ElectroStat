import type { CVDataPoint } from "@/hooks/useSimulatedCVData";
import {
  CV_F,
  CV_R,
  CV_T_DEFAULT_K,
  CV_RS_PREFACTOR,
  CV_DELTA_EP_REVERSIBLE_MV,
} from "@/utils/cvConstants";

export type CVReversibility = "reversible" | "quasi-reversible" | "irreversible";
export type BaselineMethod =
  | "per-branch-linear"
  | "partial-per-branch-linear"
  | "global-linear"
  | "linear-edges"
  | "none";
export type BaselineMethodInput =
  | "auto"
  | "none"
  | "linear-first-15"
  | "linear-edges";
export type BaselineResolvedMethod =
  | "linear-first-15"
  | "linear-edges"
  | "linear-anchors"
  | "mixed"
  | "none";
/** What was fitted on one branch. "linear-anchors" is the line between the two ends of the reverse branch. */
type BranchBaselineMethod = "linear-first-15" | "linear-edges" | "linear-anchors" | "none";
export type DStatus = "valid" | "apparent" | "invalid";

export interface CVMetrics {
  // Raw (uncorrected) peak currents in µA
  IpaRaw: number;
  IpcRaw: number;
  // Baseline-corrected peak currents in µA
  IpaCorrected: number;
  IpcCorrected: number;
  // Backward-compat aliases — equal to the corrected values
  Ipa: number;
  Ipc: number;
  /**
   * The largest baseline-corrected excursion on the anodic / cathodic branch,
   * whether or not it counts as a peak (it is NaN only when the branch is too
   * short). Used by the calibration, where a blank has no peak but still has a
   * reading at the peak position. Everything else uses Ipa/Ipc, which are NaN
   * for a peak that was not detected.
   */
  IpaExcursion?: number;
  IpcExcursion?: number;
  // Peak potentials in V
  Epa: number;
  Epc: number;
  E0prime: number;
  // Spread
  deltaEp: number;          // mV
  IpaIpcRatio: number;      // |Ipa/Ipc|
  // Derived parameters — NaN when not physically valid
  n_electrons: number;      // from CV_DELTA_EP_REVERSIBLE_MV (≈57 mV) / ΔEp, only valid for reversible @25°C
  n_est_valid: boolean;
  D_apparent: number;       // cm²/s
  D_valid: boolean;
  D_status: DStatus;
  /** Which corrected peak(s) were fed into the Randles-Ševčík expression. */
  D_peak_source?: "anodic" | "cathodic" | "none";
  reversibility: CVReversibility;
  baselineMethod: BaselineMethod;
  baselineMethodInput: BaselineMethodInput;
  baselineResolvedMethod: BaselineResolvedMethod;
  metricsCycle: number;
  correctedDataAvailable: boolean;
  correctedDataCoversAllCycles: boolean;
  noise_uA: number;         // estimated noise (1.4826·MAD)
  SNR_anodic: number;       // |Ipa_corr| / noise
  SNR_cathodic: number;     // |Ipc_corr| / noise
  hasAnodic: boolean;
  hasCathodic: boolean;
  warnings: string[];
  correctedData?: CVDataPoint[]; // copy with baseline/Icorr fields populated
}

export interface CVMetricsInput {
  scanRate_mVs: number;
  n: number;
  cMM: number;
  areaCm2: number;
  baselineMethodInput?: BaselineMethodInput; // default "auto"
  /**
   * Minimum prominence (µA) for a peak, on top of the rule of 5× the noise.
   * Default PEAK_MIN_PROMINENCE_UA.
   */
  minPeakProminence_uA?: number;
}

// Randles-Ševčík prefactor at 25 °C (0.4463 · F · sqrt(F/RT)) ≈ 268648.45
const F = CV_F;
const R = CV_R;
const TEMP_K = CV_T_DEFAULT_K;
export const RS_PREFACTOR = CV_RS_PREFACTOR;

/** Locate switching index by following the actual sign of dE/dt. */
function findSwitchIdx(sample: CVDataPoint[]): { switchIdx: number; goesPositive: boolean } {
  let dE0 = 0;
  for (let i = 1; i < sample.length; i++) {
    const d = sample[i].E - sample[0].E;
    if (Math.abs(d) > 1e-6) { dE0 = d; break; }
  }
  const goesPositive = dE0 > 0;
  let switchIdx = 0;
  if (goesPositive) {
    let m = sample[0].E;
    for (let i = 1; i < sample.length; i++) {
      if (sample[i].E > m) { m = sample[i].E; switchIdx = i; }
    }
  } else {
    let m = sample[0].E;
    for (let i = 1; i < sample.length; i++) {
      if (sample[i].E < m) { m = sample[i].E; switchIdx = i; }
    }
  }
  return { switchIdx, goesPositive };
}

/** A leg shorter than this is the few points around a vertex, not a sweep. */
const MIN_LEG_POINTS = 5;

/**
 * The legs of a cycle by the sign of dE/dt: a run of points whose potential keeps rising (anodic-going) or
 * keeps falling (cathodic-going). The branch names of the data ("forward", "reverse", "return") do not decide
 * anything here: a CV that starts between its vertices has three legs (start to vertex 1, vertex 1 to vertex 2,
 * vertex 2 back to the start), and a peak can be on any of them. The point of a vertex ends the leg that
 * reached it. Legs with fewer than MIN_LEG_POINTS points are left out.
 */
export function splitLegs(points: CVDataPoint[]): CVDataPoint[][] {
  const legs: CVDataPoint[][] = [];
  let cur: CVDataPoint[] = [];
  let dir = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const d = points[i].E - points[i - 1].E;
      const sgn = Math.abs(d) > 1e-9 ? Math.sign(d) : 0;
      if (sgn !== 0 && dir !== 0 && sgn !== dir) {
        legs.push(cur);
        cur = [];
      }
      if (sgn !== 0) dir = sgn;
    }
    cur.push(points[i]);
  }
  legs.push(cur);
  return legs.filter((l) => l.length >= MIN_LEG_POINTS);
}

const legGoesPositive = (leg: CVDataPoint[]): boolean => leg[leg.length - 1].E > leg[0].E;

/** Generic linear fit y = m·x + b through the supplied segment. */
function linearFit(seg: CVDataPoint[]): ((E: number) => number) | null {
  if (seg.length < 2) return null;
  const sx = seg.reduce((a, p) => a + p.E, 0);
  const sy = seg.reduce((a, p) => a + p.I, 0);
  const sxx = seg.reduce((a, p) => a + p.E * p.E, 0);
  const sxy = seg.reduce((a, p) => a + p.E * p.I, 0);
  const m = seg.length;
  const denom = m * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) {
    const mean = sy / m;
    return () => mean;
  }
  const slope = (m * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / m;
  return (E: number) => intercept + slope * E;
}

function fitBranchBaseline(
  branch: CVDataPoint[],
  method: BaselineMethodInput,
): ((E: number) => number) | null {
  if (method === "none" || branch.length < 4) return null;
  if (method === "linear-edges") {
    const nEdge = Math.max(2, Math.floor(branch.length * 0.1));
    const seg = [...branch.slice(0, nEdge), ...branch.slice(branch.length - nEdge)];
    return linearFit(seg);
  }
  // auto + linear-first-15
  const nFit = Math.max(3, Math.floor(branch.length * 0.15));
  return linearFit(branch.slice(0, nFit));
}

/**
 * Robust residual sigma (1.4826·MAD) of `seg` under fit `f`.
 * Returns NaN when the segment is too small or sigma cannot be computed.
 */
function fitRegionSigma(
  seg: CVDataPoint[],
  f: (E: number) => number,
): number {
  if (seg.length < 3) return NaN;
  const res = seg.map((p) => p.I - f(p.E));
  const sorted = [...res].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const abs = res.map((r) => Math.abs(r - med)).sort((a, b) => a - b);
  const mad = abs[Math.floor(abs.length / 2)];
  return 1.4826 * mad;
}

/**
 * Auto baseline picker — actually evaluates both candidates and picks the one
 * with lower residual sigma on its own fit region. Falls back gracefully.
 */
function autoPickBranchBaseline(branch: CVDataPoint[]): {
  fit: ((E: number) => number) | null;
  method: BranchBaselineMethod;
} {
  if (branch.length < 4) return { fit: null, method: "none" };
  const n15 = Math.max(3, Math.floor(branch.length * 0.15));
  const seg15 = branch.slice(0, n15);
  const nEdge = Math.max(2, Math.floor(branch.length * 0.1));
  const segE = [...branch.slice(0, nEdge), ...branch.slice(branch.length - nEdge)];
  const f15 = linearFit(seg15);
  const fE = linearFit(segE);
  const s15 = f15 ? fitRegionSigma(seg15, f15) : NaN;
  const sE = fE ? fitRegionSigma(segE, fE) : NaN;
  const ok15 = !!f15 && Number.isFinite(s15);
  const okE = !!fE && Number.isFinite(sE);
  if (!ok15 && !okE) return { fit: null, method: "none" };
  if (ok15 && !okE) return { fit: f15!, method: "linear-first-15" };
  if (!ok15 && okE) return { fit: fE!, method: "linear-edges" };
  // Both valid — prefer linear-edges when its residual sigma is comparable
  // or smaller (edges captures sloping baselines that span the window).
  if (sE <= s15 * 1.10) return { fit: fE!, method: "linear-edges" };
  return { fit: f15!, method: "linear-first-15" };
}

/** Resolve a baseline fit for a single branch given the user-selected mode. */
function resolveBranchBaseline(
  branch: CVDataPoint[],
  input: BaselineMethodInput,
): {
  fit: ((E: number) => number) | null;
  method: BranchBaselineMethod;
} {
  if (input === "none" || branch.length < 4) return { fit: null, method: "none" };
  if (input === "auto") return autoPickBranchBaseline(branch);
  const fit = fitBranchBaseline(branch, input);
  return fit
    ? { fit, method: input === "linear-edges" ? "linear-edges" : "linear-first-15" }
    : { fit: null, method: "none" };
}

/** 3-point boxcar smoothing — used only to locate the index of the peak. */
function smooth(branch: CVDataPoint[]): number[] {
  const out = branch.map((p) => p.I);
  for (let i = 1; i < branch.length - 1; i++) {
    out[i] = (branch[i - 1].I + branch[i].I + branch[i + 1].I) / 3;
  }
  return out;
}

/** 1.4826 · MAD of the residuals of `seg` vs `baseline(E)`. */
function noiseFromBranch(
  branch: CVDataPoint[],
  baseline: ((E: number) => number) | null,
): number {
  if (branch.length < 4) return 0;
  const nFit = Math.max(3, Math.floor(branch.length * 0.15));
  const seg = branch.slice(0, nFit);
  const residuals = seg.map((p) => p.I - (baseline ? baseline(p.E) : 0));
  const sorted = [...residuals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const absDev = residuals.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
  const mad = absDev[Math.floor(absDev.length / 2)];
  return 1.4826 * mad;
}

/**
 * What a candidate has to look like to count as a peak and not as noise, ripple
 * or the tail of a charging transient.
 *
 * - Prominence: how far the candidate stands above the higher of the two
 *   saddles that separate it from anything higher, on the smoothed,
 *   baseline-corrected trace. It must be at least PEAK_MIN_PROMINENCE_SIGMA
 *   times the point-to-point noise of that trace, and at least a minimum in µA
 *   (configurable, default PEAK_MIN_PROMINENCE_UA).
 * - Width: the candidate must stay above half its prominence over at least
 *   PEAK_MIN_WIDTH_POINTS points and PEAK_MIN_WIDTH_MV. A reversible peak is
 *   about 90/n mV wide at half height, so 20 mV leaves room for n up to 4,
 *   while a spike of a few points on a flat capacitive plateau is rejected.
 *
 * On a flat capacitor trace with 1 to 5 µA of ripple the largest excursion used
 * to be reported as a peak ("Epc -0.286 V, Peaks detected 1/2").
 */
export const PEAK_MIN_PROMINENCE_SIGMA = 5;
export const PEAK_MIN_PROMINENCE_UA = 0.05;
export const PEAK_MIN_WIDTH_POINTS = 4;
export const PEAK_MIN_WIDTH_MV = 20;
/**
 * A feature that stays above half its prominence over more than this fraction of
 * the branch is a curved baseline (the bow of a capacitive plateau, a drift),
 * not a peak: a reversible peak is about 90/n mV wide on a branch of several
 * hundred mV, a bow spans some 70 % of it.
 */
export const PEAK_MAX_WIDTH_FRACTION = 0.5;
/** Smallest peak height (µA, baseline-corrected) that is ever reported, whatever the noise. */
const FIXED_PEAK_THRESHOLD_UA = 0.05;

interface PeakCandidate {
  /** Points on the branch the candidate was found on. */
  branchLength: number;
  Iraw: number;
  Icorr: number;
  E: number;
  idx: number;
  /** µA above the higher saddle, on the smoothed corrected trace (always >= 0). */
  prominence: number;
  /** Points, and mV, over which the trace stays above half the prominence. */
  widthPoints: number;
  widthMv: number;
}

/**
 * Find an extremum on a branch (max for "anodic", min for "cathodic"),
 * ignoring the outer 5 % of points so we don't pick the ramp endpoints, and
 * measure how prominent and how wide it is.
 */
function findPeak(
  branch: CVDataPoint[],
  baseline: ((E: number) => number) | null,
  kind: "anodic" | "cathodic",
): PeakCandidate | null {
  if (branch.length < 5) return null;
  const sm = smooth(branch);
  const sign = kind === "anodic" ? 1 : -1;
  // y is the smoothed, baseline-corrected trace, flipped so that the peak is a maximum.
  const y = sm.map((v, i) => sign * (baseline ? v - baseline(branch[i].E) : v));
  const edge = Math.max(1, Math.floor(branch.length * 0.05));
  let bestIdx = -1;
  let bestVal = -Infinity;
  for (let i = edge; i < branch.length - edge; i++) {
    if (y[i] > bestVal) {
      bestVal = y[i];
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const Iraw = branch[bestIdx].I;
  const Icorr = baseline ? Iraw - baseline(branch[bestIdx].E) : Iraw;

  // Topographic prominence: walk each way until a higher point or the end of
  // the branch, keeping the lowest value seen. The saddle is the higher of the two.
  let leftMin = bestVal;
  for (let i = bestIdx - 1; i >= 0 && y[i] <= bestVal; i--) leftMin = Math.min(leftMin, y[i]);
  let rightMin = bestVal;
  for (let i = bestIdx + 1; i < branch.length && y[i] <= bestVal; i++) rightMin = Math.min(rightMin, y[i]);
  const prominence = Math.max(0, bestVal - Math.max(leftMin, rightMin));

  // Width at half prominence: the contiguous stretch around the peak that stays above it.
  const half = bestVal - prominence / 2;
  let lo = bestIdx;
  while (lo - 1 >= 0 && y[lo - 1] >= half) lo--;
  let hi = bestIdx;
  while (hi + 1 < branch.length && y[hi + 1] >= half) hi++;

  return {
    branchLength: branch.length,
    Iraw,
    Icorr,
    E: branch[bestIdx].E,
    idx: bestIdx,
    prominence,
    widthPoints: hi - lo + 1,
    widthMv: Math.abs(branch[hi].E - branch[lo].E) * 1000,
  };
}

/**
 * Point-to-point noise of the baseline-corrected trace of a branch (µA): the
 * robust sigma (1.4826·MAD) of the second differences, divided by sqrt(6), the
 * factor for white noise. Second differences cancel a smooth wave, so a real
 * peak does not inflate it, and few points are affected by a peak, so the MAD
 * ignores them. Returns 0 when it cannot be estimated.
 */
function pointNoiseOfBranch(
  branch: CVDataPoint[],
  baseline: ((E: number) => number) | null,
): number {
  if (branch.length < 8) return 0;
  const v = branch.map((p) => p.I - (baseline ? baseline(p.E) : 0));
  const d2: number[] = [];
  for (let i = 1; i < v.length - 1; i++) d2.push(v[i - 1] - 2 * v[i] + v[i + 1]);
  const sorted = [...d2].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const dev = d2.map((d) => Math.abs(d - med)).sort((a, b) => a - b);
  const mad = dev[Math.floor(dev.length / 2)];
  return (1.4826 * mad) / Math.sqrt(6);
}

/** Does the candidate stand out from the noise, and is it wide enough to be a peak? */
function standsOut(
  p: PeakCandidate | null,
  sigma_uA: number,
  minProminence_uA: number,
): { ok: boolean; reason?: string } {
  if (!p) return { ok: false };
  const need = Math.max(PEAK_MIN_PROMINENCE_SIGMA * sigma_uA, minProminence_uA);
  if (!(p.prominence >= need)) {
    return {
      ok: false,
      reason: `prominence ${p.prominence.toFixed(2)} µA is below ${need.toFixed(2)} µA (${PEAK_MIN_PROMINENCE_SIGMA}× the noise)`,
    };
  }
  if (p.widthPoints < PEAK_MIN_WIDTH_POINTS || p.widthMv < PEAK_MIN_WIDTH_MV) {
    return {
      ok: false,
      reason: `width ${p.widthPoints} points / ${p.widthMv.toFixed(0)} mV is below ${PEAK_MIN_WIDTH_POINTS} points / ${PEAK_MIN_WIDTH_MV} mV`,
    };
  }
  if (p.widthPoints > PEAK_MAX_WIDTH_FRACTION * p.branchLength) {
    return {
      ok: false,
      reason: `it spans ${Math.round((100 * p.widthPoints) / p.branchLength)} % of the branch, which is a curved baseline and not a peak`,
    };
  }
  return { ok: true };
}

/**
 * The line between the two ends of a branch: the medians of a window just past the first
 * points of the branch (which carry the charging transient of the vertex) and of a window at
 * its end, joined by a straight line. It is interpolated across the peak, never extrapolated,
 * so a curved tail cannot throw it off.
 */
function anchorsBaseline(branch: CVDataPoint[]): ((E: number) => number) | null {
  const n = branch.length;
  if (n < 20) return null;
  const skip = Math.max(1, Math.round(0.05 * n));
  const w = Math.max(3, Math.round(0.1 * n));
  const a = branch.slice(skip, skip + w);
  const b = branch.slice(n - w);
  const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
  const median = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];
  const eA = mean(a.map((p) => p.E));
  const eB = mean(b.map((p) => p.E));
  if (!(Math.abs(eB - eA) > 1e-9)) return null;
  const iA = median(a.map((p) => p.I));
  const iB = median(b.map((p) => p.I));
  const slope = (iB - iA) / (eB - eA);
  return (E: number) => iA + slope * (E - eA);
}

/**
 * Noise of a branch for the peak decision. The residual of the first 15 % under a line is the
 * usual estimate, but on the reverse branch those points are the curved tail of the first
 * sweep and the charging transient of the vertex, which a line does not follow: the residual
 * then measures the tail and not the noise (a measured CV gave 2.9 µA for a trace that is
 * smooth to a fraction of a µA). Under the line between the ends of the branch the
 * point-to-point noise, which a smooth tail does not affect, is used instead.
 */
function branchNoise(
  branch: CVDataPoint[],
  baseline: ((E: number) => number) | null,
  trendFree: boolean,
): number {
  if (trendFree) {
    const pointToPoint = pointNoiseOfBranch(branch, baseline);
    if (pointToPoint > 0) return pointToPoint;
  }
  return noiseFromBranch(branch, baseline);
}

/** The peak a branch gives under a baseline, and whether it counts as one (tall enough, prominent, wide). */
function branchPeakVerdict(
  branch: CVDataPoint[],
  baseline: ((E: number) => number) | null,
  kind: "anodic" | "cathodic",
  minProminence_uA: number,
  trendFreeNoise: boolean,
): { peak: PeakCandidate | null; ok: boolean } {
  const peak = findPeak(branch, baseline, kind);
  const noise = branchNoise(branch, baseline, trendFreeNoise);
  const effectiveNoise = Number.isFinite(noise) && noise > 0 ? noise : FIXED_PEAK_THRESHOLD_UA / 3;
  const threshold = Math.max(FIXED_PEAK_THRESHOLD_UA, 3 * effectiveNoise);
  const sigma = Math.max(pointNoiseOfBranch(branch, baseline), effectiveNoise);
  const tall = peak != null && (kind === "anodic" ? peak.Icorr > threshold : peak.Icorr < -threshold);
  return { peak, ok: tall && standsOut(peak, sigma, minProminence_uA).ok };
}

/**
 * A peak current that the baseline extrapolated from the first points of a leg after a vertex gives
 * more than this fraction below the one the line between the two ends of the leg gives is an
 * under-reading, and the second is used.
 */
export const REVERSE_BASELINE_DISAGREEMENT = 0.25;

/**
 * Baseline of a leg that follows a vertex (the reverse leg, the return leg). The first sweep rises
 * from a flat baseline, so a line fitted to its first points and extrapolated is right there. A leg
 * after a vertex starts on the decaying tail of the sweep before it (and the charging transient of
 * the vertex), which is curved: a line fitted to its first 15 % and extrapolated to the peak, a few
 * hundred mV away, can be well off, up to hiding the peak. In "auto" the line between the two ends
 * of the leg is therefore tried too, and used when the usual baseline leaves no peak where it shows
 * one, or gives a peak more than REVERSE_BASELINE_DISAGREEMENT below this one's.
 * It is not used when the peak is in or next to the window at the end of the leg (a leg that stops
 * inside the wave, such as a return to a start potential just past the peak): that window would be
 * part of the wave. Where both agree, or neither finds a peak (noise, a resistor, a capacitor),
 * nothing changes. An explicit choice of baseline is always respected.
 */
function resolveReverseBaseline(
  rev: CVDataPoint[],
  kind: "anodic" | "cathodic",
  input: BaselineMethodInput,
  minProminence_uA: number,
): { fit: ((E: number) => number) | null; method: BranchBaselineMethod; note?: string } {
  const usual = resolveBranchBaseline(rev, input);
  if (input !== "auto") return usual;
  const anchors = anchorsBaseline(rev);
  if (!anchors) return usual;
  const alt = branchPeakVerdict(rev, anchors, kind, minProminence_uA, true);
  if (!alt.ok || !alt.peak) return usual;
  const window = Math.max(3, Math.round(0.1 * rev.length));
  if (alt.peak.idx >= rev.length - 2 * window) return usual;
  const cur = branchPeakVerdict(rev, usual.fit, kind, minProminence_uA, false);
  if (cur.ok && cur.peak) {
    const a = cur.peak.Icorr;
    const b = alt.peak.Icorr;
    // Only an under-reading is corrected: a peak the usual baseline gives larger than the other one is kept.
    if (Math.abs(a) >= (1 - REVERSE_BASELINE_DISAGREEMENT) * Math.abs(b)) return usual;
    return {
      fit: anchors,
      method: "linear-anchors",
      note: `Baseline of a leg after a vertex: the line extrapolated from its first points (${usual.method}) gave ${a.toFixed(1)} µA, more than ${Math.round(REVERSE_BASELINE_DISAGREEMENT * 100)} % below the ${b.toFixed(1)} µA of the line between its two ends; the second was used.`,
    };
  }
  return {
    fit: anchors,
    method: "linear-anchors",
    note: `Baseline of a leg after a vertex: the line extrapolated from its first points (${usual.method}) left no ${kind} peak; the line between its two ends was used.`,
  };
}

export function computeCVMetrics(
  data: CVDataPoint[],
  input: CVMetricsInput,
): CVMetrics | null {
  if (data.length < 10) return null;

  // Operate on the first cycle when available.
  const cyc1 = data.filter((d) => d.cycle === 1);
  const sample = cyc1.length >= 10 ? cyc1 : data;
  if (sample.length < 10) return null;
  const metricsCycle = cyc1.length >= 10 ? 1 : (sample[0]?.cycle ?? 1);

  const warnings: string[] = [];
  const baselineInput: BaselineMethodInput = input.baselineMethodInput ?? "auto";

  // Prefer the branch tags emitted by the simulator/hardware when present.
  const hasBranches = sample.some(
    (p) => p.branch === "forward" || p.branch === "reverse",
  );
  let fwd: CVDataPoint[];
  let rev: CVDataPoint[];
  let goesPositive: boolean;
  // A CV that starts between its vertices has a third leg (back to the start): the legs are found from
  // dE/dt, whatever the branch names say, and the first two are what "forward" and "reverse" always were.
  const legs = splitLegs(sample);
  const extraLegs: CVDataPoint[][] = legs.length >= 3 ? legs.slice(2) : [];
  if (legs.length >= 3) {
    fwd = legs[0];
    rev = legs[1];
    goesPositive = legGoesPositive(legs[0]);
  } else if (hasBranches) {
    fwd = sample.filter((p) => p.branch === "forward");
    rev = sample.filter((p) => p.branch === "reverse");
    if (fwd.length < 2 || rev.length < 2) {
      const fb = findSwitchIdx(sample);
      fwd = sample.slice(0, fb.switchIdx + 1);
      rev = sample.slice(fb.switchIdx);
      goesPositive = fb.goesPositive;
    } else {
      goesPositive = fwd[fwd.length - 1].E > fwd[0].E;
    }
  } else {
    const fb = findSwitchIdx(sample);
    fwd = sample.slice(0, fb.switchIdx + 1);
    rev = sample.slice(fb.switchIdx);
    goesPositive = fb.goesPositive;
  }

  // Per-branch baseline — actually evaluate candidates when "auto".
  const minPeakProminence_uA = input.minPeakProminence_uA ?? PEAK_MIN_PROMINENCE_UA;
  const fwdResolved = resolveBranchBaseline(fwd, baselineInput);
  const revResolved = resolveReverseBaseline(rev, goesPositive ? "cathodic" : "anodic", baselineInput, minPeakProminence_uA);
  if (revResolved.note) warnings.push(revResolved.note);
  const fwdBase = fwdResolved.fit;
  const revBase = revResolved.fit;
  let baselineMethod: BaselineMethod;
  if (baselineInput === "none") {
    baselineMethod = "none";
    warnings.push("Baseline disabled");
  } else if (fwdBase && revBase) {
    baselineMethod =
      fwdResolved.method === "linear-edges" && revResolved.method === "linear-edges"
        ? "linear-edges"
        : "per-branch-linear";
  } else if (fwdBase || revBase) {
    baselineMethod = "partial-per-branch-linear";
    warnings.push("Baseline fallback used — only one branch fitted");
  } else {
    baselineMethod = "none";
    warnings.push("Baseline fit failed; using raw currents");
  }

  // Resolved auto method label (or echo of explicit input).
  let baselineResolvedMethod: BaselineResolvedMethod;
  if (baselineInput === "none" || (!fwdBase && !revBase)) {
    baselineResolvedMethod = "none";
  } else if (baselineInput === "linear-first-15") {
    baselineResolvedMethod = "linear-first-15";
  } else if (baselineInput === "linear-edges") {
    baselineResolvedMethod = "linear-edges";
  } else {
    // auto
    const a = fwdResolved.method;
    const b = revResolved.method;
    if (a === b && a !== "none") {
      baselineResolvedMethod = a;
      warnings.push(
        a === "linear-edges"
          ? "Auto baseline selected edge regions."
          : a === "linear-anchors"
            ? "Auto baseline selected the line between the two ends of the branch."
            : "Auto baseline selected first-15 region.",
      );
    } else if (a !== "none" && b !== "none") {
      baselineResolvedMethod = "mixed";
      warnings.push(
        `Auto baseline picked ${a} (forward) and ${b} (reverse).`,
      );
    } else {
      baselineResolvedMethod = (a !== "none" ? a : b) as BaselineResolvedMethod;
    }
  }

  // If the scan goes positive first, the anodic peak lives on the forward
  // branch and the cathodic peak on the reverse branch (and vice versa).
  let anodicBranch = goesPositive ? fwd : rev;
  let anodicBase = goesPositive ? fwdBase : revBase;
  let cathodicBranch = goesPositive ? rev : fwd;
  let cathodicBase = goesPositive ? revBase : fwdBase;
  let anodicTrendFree = revResolved.method === "linear-anchors" && anodicBranch === rev;
  let cathodicTrendFree = revResolved.method === "linear-anchors" && cathodicBranch === rev;

  // Further legs (the return to the start) can hold the peak the first two do not: the cathodic peak of a CV
  // that goes 0 -> -0.3 -> 0.6 -> 0 V is on the way back, on the third leg. A leg is taken when it holds a
  // peak that stands out and the current one does not, or a larger one.
  extraLegs.forEach((leg, n) => {
    const kind = legGoesPositive(leg) ? "anodic" : "cathodic";
    const resolved = resolveReverseBaseline(leg, kind, baselineInput, minPeakProminence_uA);
    const trendFree = resolved.method === "linear-anchors";
    const candidate = branchPeakVerdict(leg, resolved.fit, kind, minPeakProminence_uA, trendFree);
    if (!candidate.ok || !candidate.peak) return;
    const holder =
      kind === "anodic"
        ? { branch: anodicBranch, base: anodicBase, trendFree: anodicTrendFree }
        : { branch: cathodicBranch, base: cathodicBase, trendFree: cathodicTrendFree };
    const current = branchPeakVerdict(holder.branch, holder.base ?? null, kind, minPeakProminence_uA, holder.trendFree);
    if (current.ok && current.peak && Math.abs(current.peak.Icorr) >= Math.abs(candidate.peak.Icorr)) return;
    if (kind === "anodic") {
      anodicBranch = leg;
      anodicBase = resolved.fit;
      anodicTrendFree = trendFree;
    } else {
      cathodicBranch = leg;
      cathodicBase = resolved.fit;
      cathodicTrendFree = trendFree;
    }
    warnings.push(`The ${kind} peak is on leg ${n + 3} of the cycle (the return towards the start potential).`);
    if (resolved.note) warnings.push(resolved.note);
  });

  const anodic = findPeak(anodicBranch, anodicBase ?? null, "anodic");
  const cathodic = findPeak(cathodicBranch, cathodicBase ?? null, "cathodic");

  // Estimate noise from residuals on each branch and combine.
  const noiseAn = branchNoise(anodicBranch, anodicBase ?? null, anodicTrendFree);
  const noiseCa = branchNoise(cathodicBranch, cathodicBase ?? null, cathodicTrendFree);
  const noise_uA = Math.max(noiseAn, noiseCa);
  // SNR must remain finite for clean simulated curves where MAD≈0. Use a
  // fixed fallback noise floor so peak detection and SNR stay coherent.
  const effectiveNoise_uA =
    Number.isFinite(noise_uA) && noise_uA > 0
      ? noise_uA
      : FIXED_PEAK_THRESHOLD_UA / 3;
  if (!(Number.isFinite(noise_uA) && noise_uA > 0)) {
    warnings.push(
      "Noise estimate unavailable or zero; SNR uses fixed fallback noise.",
    );
  }
  const peakThreshold_uA = Math.max(
    FIXED_PEAK_THRESHOLD_UA,
    3 * effectiveNoise_uA,
  );
  // A candidate has to be tall enough (above) and also stand out from the local
  // baseline by a minimum prominence and be several points wide, or it is noise.
  const minProminence_uA = minPeakProminence_uA;
  const anodicSigma = Math.max(pointNoiseOfBranch(anodicBranch, anodicBase ?? null), effectiveNoise_uA);
  const cathodicSigma = Math.max(pointNoiseOfBranch(cathodicBranch, cathodicBase ?? null), effectiveNoise_uA);
  const anodicShape = standsOut(anodic, anodicSigma, minProminence_uA);
  const cathodicShape = standsOut(cathodic, cathodicSigma, minProminence_uA);
  const hasAnodic = anodic != null && anodic.Icorr > peakThreshold_uA && anodicShape.ok;
  const hasCathodic = cathodic != null && cathodic.Icorr < -peakThreshold_uA && cathodicShape.ok;
  const SNR_anodic = anodic ? Math.abs(anodic.Icorr) / effectiveNoise_uA : 0;
  const SNR_cathodic = cathodic ? Math.abs(cathodic.Icorr) / effectiveNoise_uA : 0;

  if (!hasAnodic) {
    const why = anodic != null && anodic.Icorr > peakThreshold_uA ? anodicShape.reason : undefined;
    warnings.push(why ? `no clear anodic peak detected (${why})` : "no clear anodic peak detected");
  }
  if (!hasCathodic) {
    const why = cathodic != null && cathodic.Icorr < -peakThreshold_uA ? cathodicShape.reason : undefined;
    warnings.push(why ? `no clear cathodic peak detected (${why})` : "no clear cathodic peak detected");
  }

  // Only a peak that was detected is reported (and used for Ipa/Ipc, ΔEp, E0',
  // the ratio, D and the quality verdict). The largest excursion of a trace
  // with no peak in it is still kept apart, as IpaExcursion/IpcExcursion, for
  // the calibration: a blank has no peak, and the calibration reads what is at
  // the peak position there, as before (see buildCVCalibrationPoint).
  const IpaExcursion = anodic ? anodic.Icorr : NaN;
  const IpcExcursion = cathodic ? cathodic.Icorr : NaN;
  const IpaRaw = hasAnodic && anodic ? anodic.Iraw : NaN;
  const IpcRaw = hasCathodic && cathodic ? cathodic.Iraw : NaN;
  const IpaCorrected = hasAnodic && anodic ? anodic.Icorr : NaN;
  const IpcCorrected = hasCathodic && cathodic ? cathodic.Icorr : NaN;
  const Epa = hasAnodic && anodic ? anodic.E : NaN;
  const Epc = hasCathodic && cathodic ? cathodic.E : NaN;
  const deltaEp = hasAnodic && hasCathodic ? Math.abs(Epa - Epc) * 1000 : NaN;
  const E0prime = hasAnodic && hasCathodic ? (Epa + Epc) / 2 : NaN;
  const IpaIpcRatio =
    hasAnodic && hasCathodic ? Math.abs(IpaCorrected / IpcCorrected) : NaN;

  // Randles-Ševčík — only when current/area/conc/scan are physical and the
  // system is at least quasi-reversible.
  const cBulk = input.cMM * 1e-6;
  const vVs = input.scanRate_mVs / 1000;
  let D_apparent = NaN;
  let D_valid = false;
  let D_peak_source: "anodic" | "cathodic" | "none" = "none";
  if (
    input.n > 0 &&
    input.areaCm2 > 0 &&
    cBulk > 0 &&
    vVs > 0
  ) {
    // Randles–Ševčík describes the peak of the FIRST sweep, which rises from a
    // flat baseline. The second peak sits on the decaying tail of the first
    // one and its baseline has to be extrapolated, which under-reads it by
    // ~5 % even on ideal data (that bias carried straight into D). So use the
    // first-sweep peak when it exists and the couple looks reversible-ish
    // (ratio 0.8–1.25); otherwise fall back to whichever peak exists.
    let ipaUseMicroA: number | null = null;
    const firstIsAnodic = goesPositive;
    const firstDetected = firstIsAnodic ? hasAnodic : hasCathodic;
    const firstPeak = firstIsAnodic ? IpaCorrected : Math.abs(IpcCorrected);
    if (hasAnodic && hasCathodic && firstDetected && firstPeak > 0) {
      const ratio = Math.abs(IpaCorrected / IpcCorrected);
      if (Number.isFinite(ratio) && ratio >= 0.8 && ratio <= 1.25) {
        ipaUseMicroA = firstPeak;
        D_peak_source = firstIsAnodic ? "anodic" : "cathodic";
      }
    }
    if (ipaUseMicroA == null && hasAnodic && IpaCorrected > 0) {
      ipaUseMicroA = IpaCorrected;
      D_peak_source = "anodic";
    }
    if (ipaUseMicroA == null && hasCathodic && Math.abs(IpcCorrected) > 0) {
      ipaUseMicroA = Math.abs(IpcCorrected);
      D_peak_source = "cathodic";
    }
    if (ipaUseMicroA != null) {
      const ipaA = ipaUseMicroA * 1e-6;
      const denom =
        RS_PREFACTOR *
        Math.pow(input.n, 1.5) *
        input.areaCm2 *
        cBulk *
        Math.sqrt(vVs);
      if (denom > 0) {
        D_apparent = Math.pow(ipaA / denom, 2);
        D_valid = true;
      }
    }
  }

  // Reversibility — compare to expected ΔEp for n electrons at 25 °C.
  const expectedDeltaEp = CV_DELTA_EP_REVERSIBLE_MV / Math.max(1, input.n);
  let reversibility: CVReversibility;
  if (!hasAnodic || !hasCathodic) {
    reversibility = "irreversible";
  } else if (
    Math.abs(deltaEp - expectedDeltaEp) <= 20 &&
    IpaIpcRatio >= 0.9 &&
    IpaIpcRatio <= 1.1
  ) {
    reversibility = "reversible";
  } else if (deltaEp <= expectedDeltaEp + 200 && IpaIpcRatio >= 0.7 && IpaIpcRatio <= 1.3) {
    reversibility = "quasi-reversible";
  } else {
    reversibility = "irreversible";
  }

  // D status: only "valid" for fully reversible systems.
  let D_status: DStatus = "invalid";
  if (D_valid && reversibility === "reversible") {
    D_status = "valid";
  } else if (D_valid && reversibility === "quasi-reversible") {
    D_status = "apparent";
    warnings.push(
      "D apparent assumes reversible diffusion-controlled CV; value is informational for quasi-reversible data.",
    );
  } else if (!D_valid) {
    warnings.push("D apparent unavailable: reversible valid peaks required.");
  } else {
    D_status = "invalid";
    D_apparent = NaN;
    D_valid = false;
    D_peak_source = "none";
    warnings.push("D apparent suppressed — system is irreversible");
  }
  // Backward compat: keep D_valid true only when status is valid.
  D_valid = D_status === "valid";

  // n estimate — only meaningful for clean reversible diffusion-controlled
  // systems near 25 °C.
  let n_electrons = NaN;
  let n_est_valid = false;
  if (
    hasAnodic &&
    hasCathodic &&
    deltaEp > 0 &&
    reversibility === "reversible" &&
    IpaIpcRatio >= 0.9 &&
    IpaIpcRatio <= 1.1
  ) {
    n_electrons = CV_DELTA_EP_REVERSIBLE_MV / deltaEp;
    n_est_valid = true;
  }

  // Build corrected data covering ALL cycles (same length & order as `data`).
  // Uses the same baseline input for every cycle so the UI/CSV stays
  // consistent across multi-cycle sweeps.
  let correctedData: CVDataPoint[] | undefined;
  let correctedDataCoversAllCycles = false;
  if (baselineInput !== "none") {
    correctedData = new Array<CVDataPoint>(data.length);
    const cycles = new Map<number, number[]>();
    data.forEach((p, i) => {
      const arr = cycles.get(p.cycle) ?? [];
      arr.push(i);
      cycles.set(p.cycle, arr);
    });
    let anyMissing = false;
    for (const [, idxs] of cycles) {
      const pts = idxs.map((i) => data[i]);
      const legsC = splitLegs(pts);
      if (legsC.length >= 3) {
        // Three legs or more: a baseline per leg, the first from its start, the others as after a vertex.
        const baseOf = new Map<CVDataPoint, ((E: number) => number) | null>();
        legsC.forEach((leg, n) => {
          const fit =
            n === 0
              ? resolveBranchBaseline(leg, baselineInput).fit
              : resolveReverseBaseline(leg, legGoesPositive(leg) ? "anodic" : "cathodic", baselineInput, minPeakProminence_uA).fit;
          for (const p of leg) baseOf.set(p, fit);
        });
        // A few points around a vertex belong to no leg: they take the baseline of the leg before them.
        let last: ((E: number) => number) | null = null;
        for (let k = 0; k < idxs.length; k++) {
          const p = pts[k];
          const own: ((E: number) => number) | null = baseOf.has(p) ? baseOf.get(p) ?? null : last;
          last = own;
          const i = idxs[k];
          if (!own) {
            correctedData[i] = { ...data[i] };
            anyMissing = true;
          } else {
            const bl = own(p.E);
            correctedData[i] = { ...data[i], baseline: bl, Icorr: p.I - bl };
          }
        }
        continue;
      }
      const hasBr = pts.some(
        (p) => p.branch === "forward" || p.branch === "reverse",
      );
      let fwdC: CVDataPoint[];
      let revC: CVDataPoint[];
      if (hasBr) {
        fwdC = pts.filter((p) => p.branch === "forward");
        revC = pts.filter((p) => p.branch === "reverse");
        if (fwdC.length < 2 || revC.length < 2) {
          const fb = findSwitchIdx(pts);
          fwdC = pts.slice(0, fb.switchIdx + 1);
          revC = pts.slice(fb.switchIdx);
        }
      } else {
        const fb = findSwitchIdx(pts);
        fwdC = pts.slice(0, fb.switchIdx + 1);
        revC = pts.slice(fb.switchIdx);
      }
      const goesPositiveC = fwdC.length > 1 ? fwdC[fwdC.length - 1].E > fwdC[0].E : goesPositive;
      const fwdR = resolveBranchBaseline(fwdC, baselineInput);
      const revR = resolveReverseBaseline(revC, goesPositiveC ? "cathodic" : "anodic", baselineInput, minPeakProminence_uA);
      const fwdSet = new Set(fwdC);
      for (let k = 0; k < idxs.length; k++) {
        const i = idxs[k];
        const p = data[i];
        const isFwd = hasBr ? p.branch === "forward" : fwdSet.has(p);
        const base = isFwd ? fwdR.fit : revR.fit;
        if (!base) {
          correctedData[i] = { ...p };
          anyMissing = true;
        } else {
          const bl = base(p.E);
          correctedData[i] = { ...p, baseline: bl, Icorr: p.I - bl };
        }
      }
    }
    correctedDataCoversAllCycles = !anyMissing;
    if (anyMissing) {
      warnings.push("Baseline unavailable for one or more cycles.");
    }
  }
  const correctedDataAvailable =
    !!correctedData && correctedData.some((p) => Number.isFinite(p.Icorr));

  return {
    IpaRaw,
    IpcRaw,
    IpaCorrected,
    IpcCorrected,
    Ipa: IpaCorrected,
    Ipc: IpcCorrected,
    IpaExcursion,
    IpcExcursion,
    Epa,
    Epc,
    E0prime,
    deltaEp,
    IpaIpcRatio,
    n_electrons,
    n_est_valid,
    D_apparent,
    D_valid,
    D_status,
    D_peak_source,
    reversibility,
    baselineMethod,
    baselineMethodInput: baselineInput,
    baselineResolvedMethod,
    metricsCycle,
    correctedDataAvailable,
    correctedDataCoversAllCycles,
    noise_uA,
    SNR_anodic,
    SNR_cathodic,
    hasAnodic,
    hasCathodic,
    warnings,
    correctedData,
  };
}
