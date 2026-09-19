/**
 * ============================================================
 * SWV — physical solvers (reversible & quasi-reversible)
 * ------------------------------------------------------------
 * Two variants share the staircase + square-wave pulse train
 * produced by `generateSWVProgram`. Every staircase step applies a
 * forward pulse E_forward = E_step + pulseSign · Esw for
 * dt_half = 1/(2·frequency_Hz), then a reverse pulse
 * E_reverse = E_step − pulseSign · Esw for another dt_half. The
 * current is sampled at the END of each half-pulse and
 * INet = IForward − IReverse falls out of the simulation, it is
 * never fabricated from a peak shape. The potential is held at the
 * first staircase value during `quietTime_s` before the train starts.
 *
 * `pulseSign` follows the scan direction: for an anodic ramp
 * (endE > startE) the forward pulse steps toward more positive
 * potentials, and vice-versa for a cathodic ramp. This matches
 * the "IForward at the end of the forward pulse" convention
 * documented in src/types/swv.ts.
 *
 * Both variants model planar semi-infinite diffusion with equal
 * D for O and R, starting from uniform bulk O.
 *
 *  A) Reversible — exact. With a Nernstian surface the surface
 *     concentration of R is a known piecewise-constant function of
 *     time, a(t) = 1/(1 + e^{nF(E(t) − E0')/RT}) · C*, so each
 *     potential jump Δa_k at time t_k adds a Cottrell response and
 *       I(t) = −nFA·C*·√(D/π) · Σ_{t_k < t} Δa_k / √(t − t_k).
 *     No mesh and no time stepping, hence no discretisation error.
 *
 *  B) Quasi-reversible — Butler–Volmer kinetics with the same
 *     Cottrell-kernel convolution as `buildQuasiReversibleCV`, but
 *     each half-pulse is split into `K` sub-steps on a Chebyshev-
 *     spaced grid (dense right after the potential jump, where the
 *     1/√t transient is steep, and at the sampling instant).
 *     A single step per half-pulse overestimates a fresh Cottrell
 *     transient by 57 %. Accuracy is set by K and is checked against
 *     the exact reversible solution in the tests.
 *
 * Sign convention (kept consistent with the rest of the app):
 *   anodic current   → positive
 *   cathodic current → negative
 *   currents reported in µA
 * ============================================================
 */

import {
  CV_F,
  CV_R,
  CV_T_DEFAULT_K,
  CV_DEFAULT_D_CM2_S,
  CV_E0_PRIME_DEFAULT_V,
  CV_BV_K0,
  CV_BV_ALPHA,
  CV_BV_K_MAX,
} from "./cvConstants";
import { generateSWVProgram } from "./swvMetrics";
import type { SWVDataPoint, SWVParameters } from "@/types/swv";

const safeExp = (x: number) => Math.exp(Math.max(-60, Math.min(60, x)));
const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));

interface Resolved {
  D: number;
  E0: number;
  T: number;
  n: number;
  A: number;
  cBulk: number; // mol/cm³
  Esw: number;   // V (amplitude)
  f: number;     // Hz
  dtHalf: number;
  pulseSign: 1 | -1;
  K0: number;
  ALPHA: number;
}

function resolveParams(p: SWVParameters): Resolved | null {
  const prog = generateSWVProgram(p);
  if (prog.length === 0) return null;
  const f = p.frequency_Hz;
  if (!(f > 0)) return null;
  const D = p.D_cm2_s ?? p.diffusionCoeff ?? CV_DEFAULT_D_CM2_S;
  const E0 = p.E0Prime_V ?? p.formalPotential ?? CV_E0_PRIME_DEFAULT_V;
  const T = p.temperature_K ?? CV_T_DEFAULT_K;
  const n = p.nElectrons ?? 1;
  const A = p.area_cm2 ?? 0.0707;
  const K0 = p.k0 ?? CV_BV_K0;
  const ALPHA = p.alpha ?? CV_BV_ALPHA;
  // Prefer cMM (mM). Fallback: convert concentration_nM (1 nM = 1e-6 mM).
  const cMM =
    p.cMM != null
      ? p.cMM
      : p.concentration_nM != null
        ? p.concentration_nM * 1e-6
        : 0;
  const cBulk = Math.max(0, cMM) * 1e-6; // mol/cm³
  const Esw = Math.max(0, p.amplitude_mV) / 1000;
  const dtHalf = 1 / (2 * f);
  const pulseSign: 1 | -1 = p.endE >= p.startE ? 1 : -1;
  if (![D, E0, T, n, A].every((x) => Number.isFinite(x) && x > 0)) return null;
  return { D, E0, T, n, A, cBulk, Esw, f, dtHalf, pulseSign, K0, ALPHA };
}

function emptyPoint(
  E: number,
  time: number,
  index: number,
  direction: SWVDataPoint["direction"],
): SWVDataPoint {
  return {
    E,
    IForward: 0,
    IReverse: 0,
    INet: 0,
    time,
    index,
    direction,
  };
}


// ────────────────── reversible (exact) ──────────────────

export function simulateReversibleDiffusionSWV(
  params: SWVParameters,
): SWVDataPoint[] {
  const r = resolveParams(params);
  if (!r) return [];
  const prog = generateSWVProgram(params);
  const { D, E0, T, n, A, cBulk, Esw, dtHalf, pulseSign } = r;

  if (cBulk <= 0) {
    return prog.map((s) => emptyPoint(s.E, s.time, s.index, s.direction));
  }

  const nf = (n * CV_F) / (CV_R * T);
  // Surface concentration of R as a fraction of the bulk O concentration.
  const surfaceR = (E: number) => 1 / (1 + safeExp(nf * (E - E0)));

  // Potential jumps: times and the change in surface R fraction at each.
  const jumpT: number[] = [];
  const jumpDa: number[] = [];
  let aPrev = 0;
  const jump = (t: number, a: number) => {
    jumpT.push(t);
    jumpDa.push(a - aPrev);
    aPrev = a;
  };
  const quiet = Math.max(0, params.quietTime_s ?? 0);
  if (quiet > 0) jump(0, surfaceR(prog[0].E));

  // I(t) = −nFA·C*·√(D/π)·Σ Δa_k/√(t − t_k), in µA (anodic +).
  const prefactor = -n * CV_F * A * cBulk * Math.sqrt(D / Math.PI) * 1e6;
  const currentAt = (t: number) => {
    let sum = 0;
    for (let k = 0; k < jumpT.length; k++) sum += jumpDa[k] / Math.sqrt(t - jumpT[k]);
    return prefactor * sum;
  };

  const out: SWVDataPoint[] = [];
  for (const s of prog) {
    const tForward = s.time;
    jump(tForward, surfaceR(s.E + pulseSign * Esw));
    const iForward = currentAt(tForward + dtHalf);
    jump(tForward + dtHalf, surfaceR(s.E - pulseSign * Esw));
    const iReverse = currentAt(tForward + 2 * dtHalf);
    out.push({
      E: s.E,
      IForward: iForward,
      IReverse: iReverse,
      INet: iForward - iReverse,
      time: s.time,
      index: s.index,
      direction: s.direction,
    });
  }
  return out;
}

// ────────────────── quasi-reversible ──────────────────

/** Chebyshev-spaced sub-step boundaries on [0, 1]: dense at both ends. */
function pulseGrid(K: number): number[] {
  const g = new Array<number>(K + 1);
  for (let j = 0; j <= K; j++) g[j] = 0.5 * (1 - Math.cos((Math.PI * j) / K));
  return g;
}

// The history convolution costs O(n²) in the number of sub-steps n, so the
// sub-steps per half-pulse shrink for long programs instead of freezing the page.
const QUASI_SUBSTEP_BUDGET = 10000;
const QUASI_MAX_SUBSTEPS_PER_PULSE = 24;
const QUASI_MIN_SUBSTEPS_PER_PULSE = 4;

export function simulateQuasiReversibleSWV(
  params: SWVParameters,
): SWVDataPoint[] {
  const r = resolveParams(params);
  if (!r) return [];
  const prog = generateSWVProgram(params);
  const { D, E0, T, n, A, cBulk, Esw, dtHalf, pulseSign, K0, ALPHA } = r;

  if (cBulk <= 0) {
    return prog.map((s) => emptyPoint(s.E, s.time, s.index, s.direction));
  }

  const quiet = Math.max(0, params.quietTime_s ?? 0);
  const halfPulses = 2 * prog.length + (quiet > 0 ? 1 : 0);
  const K = clamp(
    Math.floor(QUASI_SUBSTEP_BUDGET / halfPulses),
    QUASI_MIN_SUBSTEPS_PER_PULSE,
    QUASI_MAX_SUBSTEPS_PER_PULSE,
  );
  const grid = pulseGrid(K);

  // Sub-step boundaries (absolute time), the potential of each sub-step, and
  // the sub-step that ends each half-pulse (where the current is sampled).
  const tb: number[] = [0];
  const Epot: number[] = [];
  const addHalfPulse = (t0: number, duration: number, E: number) => {
    for (let j = 1; j <= K; j++) {
      tb.push(t0 + duration * grid[j]);
      Epot.push(E);
    }
    return Epot.length - 1;
  };
  if (quiet > 0) addHalfPulse(0, quiet, prog[0].E);
  const forwardEnd: number[] = [];
  const reverseEnd: number[] = [];
  for (const s of prog) {
    forwardEnd.push(addHalfPulse(s.time, dtHalf, s.E + pulseSign * Esw));
    reverseEnd.push(addHalfPulse(s.time + dtHalf, dtHalf, s.E - pulseSign * Esw));
  }

  const Afac = n * CV_F * A;
  const pref = 1 / (Afac * Math.sqrt(Math.PI * D));
  const rate = (E: number) => {
    const eta = E - E0;
    const kRed = Math.min(
      CV_BV_K_MAX,
      K0 * safeExp((-ALPHA * n * CV_F * eta) / (CV_R * T)),
    );
    const kOx = Math.min(
      CV_BV_K_MAX,
      K0 * safeExp(((1 - ALPHA) * n * CV_F * eta) / (CV_R * T)),
    );
    return { kRed, kOx };
  };

  // Piecewise-constant current per sub-step (A). The surface concentration of
  // R at the end of sub-step i follows from the Cottrell kernel:
  //   CR_i = −pref · Σ_m I_m · 2(√(t_i − t_m) − √(t_i − t_{m+1})),
  // where the m = i term is the unknown current itself.
  const nSub = Epot.length;
  const I = new Float64Array(nSub);
  const S = new Float64Array(nSub + 1);
  for (let i = 0; i < nSub; i++) {
    const tEnd = tb[i + 1];
    for (let m = 0; m <= i; m++) S[m] = Math.sqrt(tEnd - tb[m]);
    let hist = 0;
    for (let m = 0; m < i; m++) hist += I[m] * (S[m] - S[m + 1]);
    hist *= 2 * pref;
    const beta = 2 * S[i] * pref;

    const { kRed, kOx } = rate(Epot[i]);
    const denom = 1 + Afac * beta * (kOx + kRed);
    let Iamp = (-Afac * (kRed * cBulk + (kOx + kRed) * hist)) / denom;

    // Mass-balance clamp — same fallback as buildQuasiReversibleCV.
    const CR_raw = -(hist + beta * Iamp);
    const thetaR = clamp(CR_raw / cBulk, 0, 1);
    const CR = thetaR * cBulk;
    const CO = cBulk - CR;
    if (thetaR <= 0 || thetaR >= 1) {
      Iamp = Afac * (kOx * CR - kRed * CO);
    }
    I[i] = Iamp;
  }

  return prog.map((s, i) => {
    const iForward = I[forwardEnd[i]] * 1e6;
    const iReverse = I[reverseEnd[i]] * 1e6;
    return {
      E: s.E,
      IForward: iForward,
      IReverse: iReverse,
      INet: iForward - iReverse,
      time: s.time,
      index: s.index,
      direction: s.direction,
    };
  });
}
