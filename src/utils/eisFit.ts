import { levenbergMarquardt } from "ml-levenberg-marquardt";
import type { EISDataPoint } from "@/hooks/useSimulatedData";

/**
 * ============================================================
 *  ElectroStat — Scientific CNLS EIS Fitting
 * ============================================================
 *
 *  Implements Complex Non-Linear Least Squares fitting using
 *  the "vector splitting" trick to allow the real-valued LM
 *  algorithm to fit complex impedance:
 *
 *     Y_exp = [Z'_1, ..., Z'_N, Z''_1, ..., Z''_N]
 *
 *  Weighting: MODULUS weighting
 *     w_i = 1 / |Z_exp,i|^2
 *
 *  Quality metric: modulus-weighted SSR per degree of freedom.
 *     S = Σ w_i ((Z'-Z'_c)^2 + (Z''-Z''_c)^2) / (2N - P)
 *  This is NOT a classical statistical goodness-of-fit value — the
 *  weights here are 1/|Z|² rather than 1/σ_exp², so the unit-criterion
 *  used for reduced statistics does not apply. Use it as a relative
 *  quality indicator; sqrt(S)*100 ≈ modulus-weighted RMSE %.
 *
 *  Parameter uncertainty: APPROXIMATE local uncertainty derived
 *  from the local Jacobian/covariance:
 *     Cov ≈ S · (Jᵀ J)⁻¹   (J in log-space for log params)
 *  SE% is NOT guaranteed when parameters are strongly correlated,
 *  data are insufficient, or the covariance is ill-conditioned —
 *  treat the value as an order-of-magnitude indicator only.
 *
 *  Supported equivalent circuits:
 *    1. "randles"          Rs + (Rct // Cdl)
 *    2. "randles-cpe"      Rs + (Rct // CPE), Z_CPE = 1/(Q(jω)^n)
 *    3. "randles-warburg"  Rs + (Cdl // (Rct + Zw)), Zw = Aw(1 − j)/√ω
 *
 *  Models 1 and 2 describe the semicircle only: on a spectrum that also
 *  contains a diffusion tail, Re(Zw) leaks into Rct and biases it upwards
 *  (+5 % on the default simulated sweep). Model 3 carries the Warburg
 *  element itself, so Rct is the charge-transfer resistance proper; it must
 *  be fitted on the whole spectrum, not on the semicircle region only
 *  (see `fitRegionFor`).
 * ============================================================
 */


export type CircuitModel = "randles" | "randles-cpe" | "randles-warburg";

export interface EISFitResult {
  model:        CircuitModel;
  params:       Record<string, number>; // natural-space values
  errors:       Record<string, number>; // approximate standard error in %
  units:        Record<string, string>;
  /**
   * Modulus-weighted SSR / dof. With w_i = 1/|Z_i|² the weights are
   * unitless (not 1/σ²), so this is NOT a classical statistical
   * goodness-of-fit value and the unit-criterion that applies to
   * reduced statistics is irrelevant here. Use it as a relative
   * goodness indicator; sqrt(value)*100 ≈ modulus-weighted RMSE %.
   * Legacy field name `chiSquared` is kept for backward compatibility
   * with stored sessions; `weightedSsrPerDof` is the preferred name.
   */
  chiSquared:   number;
  /** Alias for `chiSquared` — preferred name in new code. */
  weightedSsrPerDof?: number;
  /** Fitted curve sampled across the SELECTED fit range only. */
  fittedCurve:  { zReal: number; zImag: number; frequency: number }[];
  /** Same model evaluated across the full measured frequency range (for extrapolation overlays). */
  fittedCurveFull?: { zReal: number; zImag: number; frequency: number }[];
  /** True when fittedCurveFull extends beyond fittedCurve frequencies. */
  extrapolationPresent?: boolean;
  /** True when the covariance matrix was ill-conditioned (SE% may be unreliable / NaN). */
  covarianceWarning?: boolean;
  /** How the parameter covariance was computed. "log_space" = Jacobian in optimization (log) space. */
  covarianceMethod?: "log_space" | "natural_space";
  /** Frequency range used for fitting (closed interval). */
  fitFreqRange?: { min: number; max: number };
  nPoints:      number;
  nFreeParams:  number;
  converged:    boolean;
  warnings?:    string[];
}

const TWO_PI = 2 * Math.PI;

// Physical bounds for the CPE exponent n. Enforced during the LM itself
// (not only at the end) via a logistic transform — see thetaFromN/nFromTheta.
export const CPE_N_MIN = 0.3;
export const CPE_N_MAX = 1.0;

/**
 * Map an unbounded optimization variable θ ∈ ℝ onto the physical
 * interval n ∈ (CPE_N_MIN, CPE_N_MAX) via the logistic function.
 * This guarantees the CPE exponent never leaves the physical range
 * during any LM step — bounds are enforced by construction.
 */
function nFromTheta(theta: number): number {
  const t = Math.max(-40, Math.min(40, theta));
  return CPE_N_MIN + (CPE_N_MAX - CPE_N_MIN) / (1 + Math.exp(-t));
}

/** Inverse of nFromTheta; clipped away from the open-interval endpoints. */
function thetaFromN(n: number): number {
  const span = CPE_N_MAX - CPE_N_MIN;
  const x = Math.min(1 - 1e-9, Math.max(1e-9, (n - CPE_N_MIN) / span));
  return Math.log(x / (1 - x));
}

/** dn/dθ for the logistic — used for chain-rule SE propagation. */
function dNdTheta(theta: number): number {
  const t = Math.max(-40, Math.min(40, theta));
  const sig = 1 / (1 + Math.exp(-t));
  return (CPE_N_MAX - CPE_N_MIN) * sig * (1 - sig);
}

interface ModelDef {
  paramNames: string[];
  units:      Record<string, string>;
  /** true if the parameter is fitted in log-space (must be > 0). */
  isLog:      boolean[];
  /** true if the parameter is bounded via a logistic transform (e.g. CPE n). */
  isLogistic: boolean[];
  initial:    (d: EISDataPoint[]) => number[]; // returns optimization-space values
  bounds:     { lower: number[]; upper: number[] };
  Z:          (lp: number[], omega: number) => { re: number; im: number };
}


// ─── Randles simplified: Rs + (Rct // Cdl) ───────────────────
// Z(ω) = Rs + Rct / (1 + jωRctCdl)
const MODEL_RANDLES: ModelDef = {
  paramNames: ["Rs", "Rct", "Cdl"],
  units:      { Rs: "Ω", Rct: "Ω", Cdl: "F" },
  isLog:      [true, true, true],
  isLogistic: [false, false, false],
  initial: (d) => {
    const s   = [...d].sort((a, b) => b.frequency - a.frequency);
    const Rs  = Math.max(s[0].zReal, 1);
    const Rct = Math.max(s[s.length - 1].zReal - Rs, 10);
    const peak = s.reduce(
      (b, p) => (Math.abs(p.zImag) > Math.abs(b.zImag) ? p : b),
      s[0],
    );
    const Cdl = 1 / (TWO_PI * Math.max(peak.frequency, 1) * Math.max(Rct, 1));
    return [Math.log(Rs), Math.log(Rct), Math.log(Cdl)];
  },
  bounds: {
    lower: [Math.log(0.01), Math.log(0.01), Math.log(1e-12)],
    upper: [Math.log(1e6),  Math.log(1e9),  Math.log(1.0)],
  },
  Z: (lp, omega) => {
    const Rs = Math.exp(lp[0]), Rct = Math.exp(lp[1]), Cdl = Math.exp(lp[2]);
    // Rct / (1 + jωRctCdl)
    const dRe = 1;
    const dIm = omega * Rct * Cdl;
    const m2  = dRe * dRe + dIm * dIm;
    return {
      re: Rs + (Rct * dRe) / m2,
      im: -(Rct * dIm) / m2,
    };
  },
};

// ─── Randles + CPE: Rs + (Rct // CPE) ────────────────────────
// Y_CPE = Q (jω)^n = Q ω^n (cos(nπ/2) + j sin(nπ/2))
//
// IMPORTANT: n is bounded to [CPE_N_MIN, CPE_N_MAX] DURING the LM via a
// logistic transform. The 4th optimization variable is θ_n (unbounded);
// the model itself applies n = nFromTheta(θ_n). This is materially
// different from clamping after the fact — the optimizer can never
// propose a non-physical n value.
const MODEL_RANDLES_CPE: ModelDef = {
  paramNames: ["Rs", "Rct", "Q", "n"],
  units:      { Rs: "Ω", Rct: "Ω", Q: "S·sⁿ", n: "" },
  isLog:      [true, true, true, false],
  isLogistic: [false, false, false, true],
  initial: (d) => {
    const s   = [...d].sort((a, b) => b.frequency - a.frequency);
    const Rs  = Math.max(s[0].zReal, 1);
    const Rct = Math.max(s[s.length - 1].zReal - Rs, 10);
    const peak = s.reduce(
      (b, p) => (Math.abs(p.zImag) > Math.abs(b.zImag) ? p : b),
      s[0],
    );
    const Q0  = 1 / (TWO_PI * Math.max(peak.frequency, 1) * Math.max(Rct, 1));
    return [Math.log(Rs), Math.log(Rct), Math.log(Q0), thetaFromN(0.9)];
  },
  bounds: {
    // θ_n bounds are generous; the logistic compresses ±20 onto the
    // physical (CPE_N_MIN, CPE_N_MAX) interval.
    lower: [Math.log(0.01), Math.log(0.01), Math.log(1e-12), -20],
    upper: [Math.log(1e6),  Math.log(1e9),  Math.log(1.0),   +20],
  },
  Z: (lp, omega) => {
    const Rs  = Math.exp(lp[0]);
    const Rct = Math.exp(lp[1]);
    const Q   = Math.exp(lp[2]);
    const n   = nFromTheta(lp[3]);
    const a   = (n * Math.PI) / 2;
    const wn  = Math.pow(omega, n);
    const ycRe = Q * wn * Math.cos(a);
    const ycIm = Q * wn * Math.sin(a);
    const yRe  = 1 / Rct + ycRe;
    const yIm  = ycIm;
    const m2   = yRe * yRe + yIm * yIm || 1e-30;
    return {
      re: Rs +  yRe / m2,
      im: -yIm / m2,
    };
  },
};


// ─── Randles + Warburg: Rs + (Cdl // (Rct + Zw)) ─────────────
// Semi-infinite Warburg, Zw = Aw/√ω · (1 − j), in series with Rct (the same
// element the simulator uses). Aw in Ω/√s.
const MODEL_RANDLES_WARBURG: ModelDef = {
  paramNames: ["Rs", "Rct", "Cdl", "Aw"],
  units:      { Rs: "Ω", Rct: "Ω", Cdl: "F", Aw: "Ω/√s" },
  isLog:      [true, true, true, true],
  isLogistic: [false, false, false, false],
  initial: (d) => {
    const s   = [...d].sort((a, b) => b.frequency - a.frequency);
    const Rs  = Math.max(s[0].zReal, 1);
    const low = s[s.length - 1];
    // Low-frequency tail: −Z'' ≈ Aw/√ω (+ a Cdl term that is small there).
    const Aw  = Math.max(-low.zImag * Math.sqrt(TWO_PI * Math.max(low.frequency, 1e-6)), 1e-3);
    const Rct = Math.max(low.zReal - Rs - Aw / Math.sqrt(TWO_PI * Math.max(low.frequency, 1e-6)), 10);
    const peak = s.reduce(
      (b, p) => (Math.abs(p.zImag) > Math.abs(b.zImag) ? p : b),
      s[0],
    );
    const Cdl = 1 / (TWO_PI * Math.max(peak.frequency, 1) * Math.max(Rct, 1));
    return [Math.log(Rs), Math.log(Rct), Math.log(Cdl), Math.log(Aw)];
  },
  bounds: {
    lower: [Math.log(0.01), Math.log(0.01), Math.log(1e-12), Math.log(1e-6)],
    upper: [Math.log(1e6),  Math.log(1e9),  Math.log(1.0),   Math.log(1e6)],
  },
  Z: (lp, omega) => {
    const Rs = Math.exp(lp[0]), Rct = Math.exp(lp[1]);
    const Cdl = Math.exp(lp[2]), Aw = Math.exp(lp[3]);
    const w  = Aw / Math.sqrt(omega);
    // Faradaic branch Zf = Rct + w − j w ; admittance Y = 1/Zf + jωCdl
    const zfRe = Rct + w, zfIm = -w;
    const zf2  = zfRe * zfRe + zfIm * zfIm || 1e-30;
    const yRe  = zfRe / zf2;
    const yIm  = -zfIm / zf2 + omega * Cdl;
    const y2   = yRe * yRe + yIm * yIm || 1e-30;
    return { re: Rs + yRe / y2, im: -yIm / y2 };
  },
};

const MODELS: Record<CircuitModel, ModelDef> = {
  "randles":         MODEL_RANDLES,
  "randles-cpe":     MODEL_RANDLES_CPE,
  "randles-warburg": MODEL_RANDLES_WARBURG,
};

/**
 * Data a model must be fitted on. The Randles models describe the semicircle
 * only, so they get the semicircle region; Randles + Warburg contains the
 * diffusion tail in the model and therefore needs the whole spectrum.
 */
export function fitRegionFor(
  model: CircuitModel,
  semicircle: EISDataPoint[],
  full: EISDataPoint[],
): EISDataPoint[] {
  return model === "randles-warburg" ? full : semicircle;
}

export function getCircuitParamNames(m: CircuitModel): string[] {
  return MODELS[m].paramNames.slice();
}

export function getCircuitLabel(m: CircuitModel): string {
  if (m === "randles") return "Randles (Rs + Rct ∥ Cdl)";
  if (m === "randles-warburg") return "Randles + Warburg (Rs + Cdl ∥ (Rct + Zw))";
  return "Randles + CPE (Rs + Rct ∥ CPE)";
}

// ─── Core fitter ─────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);

export function fitEIS(
  data: EISDataPoint[],
  model: CircuitModel,
  fullData?: EISDataPoint[],
): EISFitResult | null {
  if (!data || data.length < 4) return null;

  const def = MODELS[model];
  const P   = def.paramNames.length;
  const fit = [...data].sort((a, b) => b.frequency - a.frequency);
  const N   = fit.length;

  // Modulus weighting: residual divided by |Z|  →  weight = 1/|Z|²
  const invMod = fit.map(d =>
    1 / Math.max(Math.sqrt(d.zReal * d.zReal + d.zImag * d.zImag), 1e-9),
  );

  // Vector splitting:  y = [Z'/|Z|, Z''/|Z|]
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < N; i++) { xs.push(i);     ys.push(fit[i].zReal * invMod[i]); }
  for (let i = 0; i < N; i++) { xs.push(i + N); ys.push(fit[i].zImag * invMod[i]); }

  const initial = def
    .initial(fit)
    .map((v, i) => clamp(v, def.bounds.lower[i], def.bounds.upper[i]));

  const modelFn = (p: number[]) => (idx: number) => {
    const isReal = idx < N;
    const i      = isReal ? idx : idx - N;
    const z      = def.Z(p, TWO_PI * fit[i].frequency);
    return (isReal ? z.re : z.im) * invMod[i];
  };

  let converged = true;
  let params    = initial;
  try {
    const r = levenbergMarquardt({ x: xs, y: ys }, modelFn, {
      initialValues:  initial,
      damping:        1e-3,
      maxIterations:  500,
      errorTolerance: 1e-10,
    });
    if (r?.parameterValues?.length === P) {
      params = r.parameterValues.map((v: number, i: number) =>
        clamp(v, def.bounds.lower[i], def.bounds.upper[i]),
      );
    } else converged = false;
  } catch (err) {
    console.warn("[ElectroStat] CNLS LM failed", err);
    converged = false;
  }

  // ── Modulus-weighted SSR / dof ────────────────────────────
  let chiNum = 0;
  for (let i = 0; i < N; i++) {
    const z  = def.Z(params, TWO_PI * fit[i].frequency);
    const wi = invMod[i] * invMod[i];
    const dr = fit[i].zReal - z.re;
    const di = fit[i].zImag - z.im;
    chiNum += wi * (dr * dr + di * di);
  }
  const dof = Math.max(2 * N - P, 1);
  const chiSquared = chiNum / dof;

  // ── Convert to natural-space parameter values ──────────────
  //  isLog       → real = exp(θ)
  //  isLogistic  → real = nFromTheta(θ)  (physical-bound parameters like CPE n)
  //  otherwise   → real = θ
  const realParams = params.map((v, i) => {
    if (def.isLog[i]) return Math.exp(v);
    if (def.isLogistic[i]) return nFromTheta(v);
    return v;
  });

  // ── Numerical Jacobian in OPTIMIZATION space (log for log params,
  // logistic θ for bounded params, raw otherwise). Working in this space
  // removes the scale disparity between Rs/Rct (~1e2 Ω) and Cdl (~1e-5 F)
  // that previously made JᵀJ artificially ill-conditioned. For p = exp(θ),
  // SE(p)/|p| = SE(θ), so percentage uncertainty for log params drops out
  // directly from the optimization-space covariance. For logistic-bounded
  // params we apply the chain rule SE(n) = |dn/dθ|·SE(θ).
  const eps = 1e-5;
  const J: number[][] = Array.from({ length: 2 * N }, () => new Array(P).fill(0));
  for (let p = 0; p < P; p++) {
    const plus  = params.slice(); plus[p]  += eps;
    const minus = params.slice(); minus[p] -= eps;
    for (let i = 0; i < N; i++) {
      const om = TWO_PI * fit[i].frequency;
      const zP = def.Z(plus,  om);
      const zM = def.Z(minus, om);
      J[i][p]     = -((zP.re - zM.re) / (2 * eps)) * invMod[i];
      J[i + N][p] = -((zP.im - zM.im) / (2 * eps)) * invMod[i];
    }
  }

  // (JᵀJ)
  const JtJ: number[][] = Array.from({ length: P }, () => new Array(P).fill(0));
  for (let a = 0; a < P; a++) {
    for (let b = 0; b < P; b++) {
      let s = 0;
      for (let i = 0; i < 2 * N; i++) s += J[i][a] * J[i][b];
      JtJ[a][b] = s;
    }
  }
  const covRes = invertMatrixSafe(JtJ);
  const cov = covRes?.inv ?? null;
  const covarianceWarning = covRes?.illConditioned ?? (cov == null);

  const errors: Record<string, number> = {};
  for (let i = 0; i < P; i++) {
    const stdSq = cov && !covarianceWarning ? cov[i][i] * chiSquared : NaN;
    const stdOpt = Number.isFinite(stdSq) && stdSq >= 0 ? Math.sqrt(stdSq) : NaN;
    // log         → SE(p)/|p| = SE(θ), so pct = stdOpt*100.
    // logistic    → SE(n) = |dn/dθ|·SE(θ); report pct of natural value.
    // otherwise   → SE(p) = SE(θ); pct of natural value.
    let pct: number;
    if (!Number.isFinite(stdOpt)) {
      pct = NaN;
    } else if (def.isLog[i]) {
      pct = stdOpt * 100;
    } else if (def.isLogistic[i]) {
      const dN = dNdTheta(params[i]);
      const seNat = Math.abs(dN) * stdOpt;
      pct = realParams[i] !== 0 ? (seNat / Math.abs(realParams[i])) * 100 : NaN;
    } else {
      pct = realParams[i] !== 0 ? (stdOpt / Math.abs(realParams[i])) * 100 : NaN;
    }
    errors[def.paramNames[i]] = pct;
  }


  const paramsOut: Record<string, number> = {};
  def.paramNames.forEach((n, i) => { paramsOut[n] = realParams[i]; });

  // ── Fitted curve sampled across the SELECTED fit range only. The full-range
  // version is exposed separately as `fittedCurveFull` for plotting code that
  // wants to render extrapolation as a dashed segment.
  const fitFreqs = fit.map(d => d.frequency).filter(f => f > 0);
  const fitFmin = Math.min(...fitFreqs);
  const fitFmax = Math.max(...fitFreqs);
  const DENSE = 250;
  const sampleCurve = (fLo: number, fHi: number) => {
    const out: { zReal: number; zImag: number; frequency: number }[] = [];
    const logLo = Math.log10(Math.max(fLo, 1e-12));
    const logHi = Math.log10(Math.max(fHi, fLo * 10));
    for (let k = 0; k < DENSE; k++) {
      const f = Math.pow(10, logHi - (k * (logHi - logLo)) / (DENSE - 1));
      const z = def.Z(params, TWO_PI * f);
      out.push({ zReal: z.re, zImag: z.im, frequency: f });
    }
    return out;
  };
  const fittedCurve = sampleCurve(fitFmin, fitFmax);
  const allFreq = (fullData ?? fit).map(d => d.frequency).filter(f => f > 0);
  const fullFmin = Math.min(...allFreq);
  const fullFmax = Math.max(...allFreq);
  const extrapolationPresent = fullFmin < fitFmin * 0.999 || fullFmax > fitFmax * 1.001;
  const fittedCurveFull = extrapolationPresent ? sampleCurve(fullFmin, fullFmax) : fittedCurve;

  const warnings: string[] = [];
  if (!converged) warnings.push("LM did not converge — using initial estimates");
  if (chiSquared > 1e-2)
    warnings.push(`High weighted SSR/dof (${chiSquared.toExponential(2)}) — model may not describe the data`);
  if (covarianceWarning)
    warnings.push("Parameter uncertainty estimate unreliable due to strong parameter correlation or insufficient information.");
  for (const name of def.paramNames) {
    const e = errors[name];
    if (Number.isFinite(e) && e > 50)
      warnings.push(`${name} poorly determined (±${e.toFixed(0)}%)`);
  }

  // ── Guardrail: parameter hit a bound (within 1%) ───────────
  // For logistic-bounded params (e.g. CPE n) compare the physical value
  // against the physical bounds; θ-space bounds are essentially infinite.
  for (let i = 0; i < P; i++) {
    if (def.isLogistic[i]) {
      const nVal = realParams[i];
      const span = CPE_N_MAX - CPE_N_MIN;
      if ((nVal - CPE_N_MIN) / span < 0.01)
        warnings.push(`${def.paramNames[i]} at lower physical bound (${CPE_N_MIN}) — fit pinned`);
      else if ((CPE_N_MAX - nVal) / span < 0.01)
        warnings.push(`${def.paramNames[i]} at upper physical bound (${CPE_N_MAX}) — fit pinned`);
      continue;
    }
    const lo = def.bounds.lower[i];
    const hi = def.bounds.upper[i];
    const v  = params[i];
    const span = Math.max(Math.abs(hi - lo), 1e-9);
    const dLo = Math.abs(v - lo) / span;
    const dHi = Math.abs(hi - v) / span;
    if (dLo < 0.01) warnings.push(`${def.paramNames[i]} hit lower bound — fit unreliable`);
    else if (dHi < 0.01) warnings.push(`${def.paramNames[i]} hit upper bound — fit unreliable`);
  }


  // ── Guardrail: peak of −Im(Z) must be interior to selection ─
  let peakIdx = 0;
  let peakVal = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = -fit[i].zImag;
    if (v > peakVal) { peakVal = v; peakIdx = i; }
  }
  // (Randles + Warburg is fitted on the whole spectrum, whose low-frequency
  // tail can rise above the semicircle, so this check only applies to the others.)
  if (model !== "randles-warburg" && N >= 3 && (peakIdx === 0 || peakIdx === N - 1)) {
    warnings.push("Semicircle peak not interior to selection — move separator RIGHT to include more of the arc");
  }

  // ── Guardrail: geometric consistency checks ────────────────
  // (a) Rs should match Z'(f_max) within ~20%
  const hiF = fit[0]; // sorted high→low
  if (hiF && paramsOut.Rs > 0) {
    const rel = Math.abs(paramsOut.Rs - hiF.zReal) / Math.max(paramsOut.Rs, 1e-9);
    if (rel > 0.2)
      warnings.push(`Rs (${paramsOut.Rs.toFixed(2)}Ω) inconsistent with Z'(f_max)=${hiF.zReal.toFixed(2)}Ω`);
  }
  // (b) model peak frequency vs. observed peak frequency (≤1 decade)
  const fPeakObs = fit[peakIdx]?.frequency;
  let fPeakModel = NaN;
  if (model === "randles" || model === "randles-warburg") {
    const Rct = paramsOut.Rct, Cdl = paramsOut.Cdl;
    if (Rct > 0 && Cdl > 0) fPeakModel = 1 / (TWO_PI * Rct * Cdl);
  } else {
    const Rct = paramsOut.Rct, Q = paramsOut.Q, n = paramsOut.n;
    if (Rct > 0 && Q > 0 && n > 0)
      fPeakModel = Math.pow(Q * Rct, -1 / n) / TWO_PI;
  }
  if (model !== "randles-warburg" && Number.isFinite(fPeakModel) && fPeakObs && fPeakObs > 0) {
    const decades = Math.abs(Math.log10(fPeakModel / fPeakObs));
    if (decades > 1)
      warnings.push(`Model peak (${fPeakModel.toExponential(2)}Hz) ≠ data peak (${fPeakObs.toExponential(2)}Hz) — geometry mismatch`);
  }

  return {
    model,
    params:      paramsOut,
    errors,
    units:       def.units,
    chiSquared,
    weightedSsrPerDof: chiSquared,
    fittedCurve,
    fittedCurveFull,
    extrapolationPresent,
    covarianceWarning,
    covarianceMethod: "log_space",
    fitFreqRange: { min: fitFmin, max: fitFmax },
    nPoints:     N,
    nFreeParams: P,
    converged,
    warnings:    warnings.length ? warnings : undefined,
  };
}

// ─── Gauss–Jordan matrix inverse with conditioning flag ──────
function invertMatrixSafe(m: number[][]): { inv: number[][]; illConditioned: boolean } | null {
  const n = m.length;
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(m[i][i]));
  const absTol = 1e-20;
  const relTol = Math.max(1e-12, 1e-12 * maxDiag);
  let illConditioned = false;
  const a = m.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let k = i + 1; k < n; k++)
      if (Math.abs(a[k][i]) > Math.abs(a[pivot][i])) pivot = k;
    const piv = Math.abs(a[pivot][i]);
    if (piv < absTol) return null;
    if (piv < relTol) illConditioned = true;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const div = a[i][i];
    for (let j = 0; j < 2 * n; j++) a[i][j] /= div;
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = a[k][i];
      for (let j = 0; j < 2 * n; j++) a[k][j] -= f * a[i][j];
    }
  }
  return { inv: a.map(row => row.slice(n)), illConditioned };
}

// ─── Pretty-print helpers for the UI ─────────────────────────

/** Format a value with SI prefix for capacitance-like (F) quantities, etc. */
export function formatParamValue(name: string, value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";
  if (unit === "F") {
    if (value >= 1e-3) return `${(value * 1e3).toFixed(3)} mF`;
    if (value >= 1e-6) return `${(value * 1e6).toFixed(3)} µF`;
    if (value >= 1e-9) return `${(value * 1e9).toFixed(3)} nF`;
    return `${(value * 1e12).toFixed(3)} pF`;
  }
  if (unit === "S·sⁿ") {
    // CPE pre-factor — keep scientific for clarity
    return `${value.toExponential(3)} S·sⁿ`;
  }
  if (unit === "Ω") {
    if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(3)} MΩ`;
    if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(3)} kΩ`;
    return `${value.toFixed(2)} Ω`;
  }
  if (unit === "") {
    return value.toFixed(3);
  }
  return `${value.toPrecision(4)} ${unit}`;
}
