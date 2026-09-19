/**
 * ============================================================
 * SWV — physical solvers (reversible & quasi-reversible)
 * ------------------------------------------------------------
 * Two variants share the staircase + square-wave pulse train
 * produced by `generateSWVProgram`. For each staircase step
 * the potential is evaluated twice — a forward pulse
 * E_forward = E_step + pulseSign · Esw and a reverse pulse
 * E_reverse = E_step − pulseSign · Esw — each advanced by
 * dt_half = 1/(2·frequency_Hz). The differential current
 * INet = IForward − IReverse falls out of the simulation, it
 * is never fabricated from a peak shape.
 *
 * `pulseSign` follows the scan direction: for an anodic ramp
 * (endE > startE) the forward pulse steps toward more positive
 * potentials, and vice-versa for a cathodic ramp. This matches
 * the "IForward at the end of the forward pulse" convention
 * documented in src/types/swv.ts.
 *
 *  A) Reversible variant — 1-D semi-infinite diffusion (backward
 *     Euler + Thomas tridiagonal via `solveTridiagonal` reused
 *     from cvDiffusionSolver.ts) with a Nernst surface boundary
 *     condition CO(0)/CR(0) = exp(nF(E − E0')/RT). Faradaic
 *     current from the diffusive flux of O at the surface,
 *     I = nFA·J_O with J_O = −D·(CO[1] − CO[0])/dx.
 *
 *  B) Quasi-reversible variant — Butler–Volmer kinetics plus a
 *     semi-infinite diffusion approximation via
 *     product-integration of the Cottrell kernel, solved
 *     semi-implicitly per half-pulse. Same K0/α/K_max regime as
 *     `buildQuasiReversibleCV`. Educational approximation only;
 *     NOT a full finite-difference Butler–Volmer solver — the
 *     Cottrell-kernel convolution assumes a semi-infinite
 *     planar geometry with equal D for O and R.
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
import { solveTridiagonal } from "./cvDiffusionSolver";
import { generateSWVProgram } from "./swvMetrics";
import type { SWVDataPoint, SWVParameters } from "@/types/swv";

// Fixed at the mesh size the SWV results were produced with; independent of
// the CV mesh so tightening that one does not silently change SWV numbers.
const SWV_SPATIAL_NODES = 180;

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

// ────────────────── reversible ──────────────────

export function simulateReversibleDiffusionSWV(
  params: SWVParameters,
): SWVDataPoint[] {
  const r = resolveParams(params);
  if (!r) return [];
  const prog = generateSWVProgram(params);
  const { D, E0, T, n, A, cBulk, Esw, dtHalf, pulseSign } = r;

  const out: SWVDataPoint[] = [];
  if (cBulk <= 0) {
    return prog.map((s) => emptyPoint(s.E, s.time, s.index, s.direction));
  }

  // Total time budget for the semi-infinite mesh L ≈ 6·√(D·tMax).
  const tMax = Math.max(
    prog.length * 2 * dtHalf + (params.quietTime_s ?? 0),
    dtHalf,
  );
  const N = Math.max(20, Math.floor(SWV_SPATIAL_NODES));
  const L = 6 * Math.sqrt(D * tMax);
  const dx = L / (N - 1);
  const lambda = (D * dtHalf) / (dx * dx);

  const CO = new Array<number>(N).fill(cBulk);
  const CR = new Array<number>(N).fill(0);

  const M = N - 2;
  const a = new Array<number>(M).fill(-lambda);
  const b = new Array<number>(M).fill(1 + 2 * lambda);
  const c = new Array<number>(M).fill(-lambda);
  a[0] = 0;
  c[M - 1] = 0;

  const solveHalfPulse = (Epulse: number): number => {
    const theta = safeExp((n * CV_F * (Epulse - E0)) / (CV_R * T));

    // Impose Nernst BC using local mass conservation with the neighbour.
    const surfTot0 = clamp(CO[1] + CR[1], 0, cBulk);
    CO[0] = (surfTot0 * theta) / (1 + theta);
    CR[0] = surfTot0 / (1 + theta);

    if (M >= 1) {
      const dO = new Array<number>(M);
      const dR = new Array<number>(M);
      for (let i = 0; i < M; i++) {
        const idx = i + 1;
        dO[i] = CO[idx];
        dR[i] = CR[idx];
        if (i === 0) {
          dO[i] += lambda * CO[0];
          dR[i] += lambda * CR[0];
        }
        if (i === M - 1) {
          dO[i] += lambda * cBulk;
          dR[i] += lambda * 0;
        }
      }
      const xO = solveTridiagonal(a, b, c, dO);
      const xR = solveTridiagonal(a, b, c, dR);
      for (let i = 0; i < M; i++) {
        CO[i + 1] = Math.max(0, xO[i]);
        CR[i + 1] = Math.max(0, xR[i]);
      }
    }
    CO[N - 1] = cBulk;
    CR[N - 1] = 0;

    const surfTot1 = clamp(CO[1] + CR[1], 0, cBulk);
    CO[0] = (surfTot1 * theta) / (1 + theta);
    CR[0] = surfTot1 / (1 + theta);

    const J_O = (-D * (CO[1] - CO[0])) / dx;
    return n * CV_F * A * J_O * 1e6; // µA
  };

  for (const s of prog) {
    const Ef = s.E + pulseSign * Esw;
    const Er = s.E - pulseSign * Esw;
    const iForward = solveHalfPulse(Ef);
    const iReverse = solveHalfPulse(Er);
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

  const sqrtPiD = Math.sqrt(Math.PI * D);
  const sqrtDt = Math.sqrt(dtHalf);
  const Afac = n * CV_F * A;
  const beta = (2 * sqrtDt) / (Afac * sqrtPiD);

  // Butler–Volmer rate coefficients — same regime as buildQuasiReversibleCV.
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

  // History of currents at each half-pulse, in amperes — indexed 0..k-1
  // when computing the k-th half-pulse. Both forward and reverse pulses
  // are separate points feeding the next step's convolution.
  const Iamps: number[] = [];

  // Cottrell product-integration weights 2·(√k − √(k−1)) depend only on the
  // lag k — precompute them instead of two sqrt calls per inner iteration.
  // Two half-pulses are pushed per staircase step, hence the 2× sizing.
  const maxHistory = 2 * prog.length + 1;
  const cottrellW = new Float64Array(maxHistory + 1);
  for (let k = 1; k <= maxHistory; k++) {
    cottrellW[k] = 2 * (Math.sqrt(k) - Math.sqrt(k - 1));
  }

  const solveHalfPulse = (Epulse: number): number => {
    const { kRed, kOx } = rate(Epulse);

    let sumHist = 0;
    for (let j = 0; j < Iamps.length; j++) {
      sumHist += Iamps[j] * cottrellW[Iamps.length - j];
    }
    const convKnown = (sumHist * sqrtDt) / (Afac * sqrtPiD);

    const denom = 1 + Afac * beta * (kOx + kRed);
    let Iamp = -Afac * (kRed * cBulk + (kOx + kRed) * convKnown) / denom;

    // Mass-balance clamp — same fallback as buildQuasiReversibleCV.
    const CR_raw = -(convKnown + beta * Iamp);
    const thetaR = clamp(CR_raw / cBulk, 0, 1);
    const CR = thetaR * cBulk;
    const CO = cBulk - CR;
    if (thetaR <= 0 || thetaR >= 1) {
      Iamp = Afac * (kOx * CR - kRed * CO);
    }

    Iamps.push(Iamp);
    return Iamp * 1e6; // µA
  };

  const out: SWVDataPoint[] = [];
  for (const s of prog) {
    const Ef = s.E + pulseSign * Esw;
    const Er = s.E - pulseSign * Esw;
    const iForward = solveHalfPulse(Ef);
    const iReverse = solveHalfPulse(Er);
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
