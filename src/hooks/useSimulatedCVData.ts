import { useState, useEffect, useRef, useCallback } from "react";
import {
  CV_F as F,
  CV_R as R,
  CV_T_DEFAULT_K as T,
  CV_DEFAULT_D_CM2_S as D,
  CV_E0_PRIME_DEFAULT_V as E0_PRIME,
  CV_BV_K0,
  CV_BV_ALPHA,
  CV_BV_K_MAX,
} from "@/utils/cvConstants";
import { simulateReversibleDiffusionCV } from "@/utils/cvDiffusionSolver";


/**
 * ============================================================
 * SIMULATED CV DATA — two models
 * ------------------------------------------------------------
 * Two CV models are exposed:
 *
 *  A) "reversible" — physical solver: 1-D semi-infinite diffusion
 *     on a finite domain (L ≈ 6·√(D·tMax)) with a Nernst surface
 *     boundary condition. Time integration is backward Euler with
 *     a Thomas tridiagonal solve. Faradaic current is computed
 *     from the diffusive flux of O at the surface. Implementation:
 *     `simulateReversibleDiffusionCV` in
 *     `src/utils/cvDiffusionSolver.ts`. This is the DEFAULT model.
 *     More physical than the older parametric reversible model,
 *     but still a finite-domain numerical approximation, not a
 *     full Nicholson–Shain solver.
 *
 *  B) "quasi-reversible" — Butler–Volmer kinetics + semi-infinite
 *     diffusion (product-integration of the Cottrell kernel),
 *     solved semi-implicitly per step. Equal D for O and R,
 *     first-order mass balance CO_surf + CR_surf ≈ cBulk.
 *     Educational approximation only; D_apparent from
 *     Randles–Ševčík may be biased for this regime. NOT a full
 *     finite-difference Butler–Volmer solver yet.
 *
 *  Diffusion solver is used only for simulated reversible CV.
 *  Live hardware data (ESP32 cv_data frames) is parsed by
 *  `parseCVWebSocketMessage` and analysed directly — it never
 *  touches the solver.
 *
 * Sign convention (kept consistent across the whole project):
 *   anodic current  → positive (oxidation, R → O)
 *   cathodic current → negative (reduction, O → R)
 *   potentials in V vs reference, currents reported in µA
 * ============================================================
 */

export interface CVDataPoint {
  E: number;                                  // V vs reference
  I: number;                                  // µA (signed: anodic +, cathodic -)
  cycle: number;                              // 1-based
  t: number;                                  // s
  branch?: "forward" | "reverse" | "return"; // sweep segment
  baseline?: number;                          // µA — modelled baseline at this E (optional)
  Icorr?: number;                             // µA — baseline-corrected current (optional)
  /** Live hardware only: HSTIA output fell outside the AD5941's usable ADC window for this point. */
  outOfRange?: boolean;
}

export type CVModel = "reversible" | "quasi-reversible";

export interface CVSimParams {
  scanRate: number;   // mV/s
  eStart: number;     // V
  eVertex1: number;   // V
  eVertex2: number;   // V
  nCycles: number;
  n: number;          // electrons transferred
  cMM: number;        // bulk concentration of O, mM
  areaCm2: number;    // electrode area, cm²
  cvModel?: CVModel;  // default: "reversible"
  // Analyte / kinetic parameters (all optional — fall back to cvConstants)
  diffusionCoeff?: number;   // cm²/s
  formalPotential?: number;  // V
  k0?: number;               // cm/s
  alpha?: number;            // 0–1
  // Acquisition
  stepPotential?: number;    // mV
  quietTime?: number;        // s — informational only in the simulator
}

export const DEFAULT_CV_PARAMS: CVSimParams = {
  scanRate: 100,
  eStart: 0.6,
  eVertex1: -0.2,
  eVertex2: 0.6,
  nCycles: 1,
  n: 1,
  cMM: 5,
  areaCm2: 0.0707,
  cvModel: "reversible",
  diffusionCoeff: D,
  formalPotential: E0_PRIME,
  k0: CV_BV_K0,
  alpha: CV_BV_ALPHA,
  stepPotential: 2,
  quietTime: 2,
};

const K_MAX = CV_BV_K_MAX;

/** Kept for backwards compatibility — default formal potential. */
export const CV_E0_PRIME = E0_PRIME;


const safeExp = (x: number) => Math.exp(Math.max(-60, Math.min(60, x)));

const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));

function gaussianNoise(amp: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return amp * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function validateParams(p: CVSimParams): string | null {
  if (!(p.scanRate > 0)) return "scanRate must be > 0";
  if (!(p.nCycles >= 1)) return "nCycles must be >= 1";
  if (!(p.n > 0)) return "n must be > 0";
  if (!(p.cMM >= 0)) return "cMM must be >= 0";
  if (!(p.areaCm2 > 0)) return "areaCm2 must be > 0";
  if (![p.eStart, p.eVertex1, p.eVertex2].every(Number.isFinite)) {
    return "eStart, eVertex1, eVertex2 must be finite";
  }
  return null;
}

type Seg = { E: number; branch: "forward" | "reverse" | "return"; cycle: number; dir: 1 | -1 };

function buildPotentialProgram(params: CVSimParams): { segs: Seg[]; dt: number; stepV: number } {
  const v = params.scanRate / 1000; // V/s
  const stepV = Math.max(1e-4, (params.stepPotential ?? 1) / 1000); // V per step
  const dt = stepV / v;

  let cur = params.eStart;
  const segs: Seg[] = [{ E: cur, branch: "forward", cycle: 1, dir: 1 }];
  const addRamp = (
    from: number,
    to: number,
    branch: Seg["branch"],
    cycle: number,
  ) => {
    const steps = Math.max(1, Math.round(Math.abs(to - from) / stepV));
    const dir: 1 | -1 = to >= from ? 1 : -1;
    for (let i = 1; i <= steps; i++) {
      segs.push({ E: from + (to - from) * (i / steps), branch, cycle, dir });
    }
  };
  for (let c = 1; c <= params.nCycles; c++) {
    addRamp(cur, params.eVertex1, "forward", c);
    cur = params.eVertex1;
    addRamp(cur, params.eVertex2, "reverse", c);
    cur = params.eVertex2;
    if (c < params.nCycles && Math.abs(cur - params.eStart) > 1e-9) {
      addRamp(cur, params.eStart, "return", c);
      cur = params.eStart;
    }
  }
  // first point has no defined direction yet; copy from next
  if (segs.length >= 2) segs[0].dir = segs[1].dir;
  return { segs, dt, stepV };
}

/**
 * Reversible model — delegates to the physical 1-D semi-infinite
 * diffusion solver with a Nernstian surface boundary condition.
 * No Gaussian shaping, no capacitive baseline: this is a real PDE
 * solve (backward Euler + Thomas tridiagonal), so ΔEp ≈ 59/n mV,
 * |Ipa/Ipc| ≈ 1 and ip ∝ C·√v emerge from the physics.
 */
function buildReversibleCV(params: CVSimParams): CVDataPoint[] {
  return simulateReversibleDiffusionCV({
    eStart: params.eStart,
    eVertex1: params.eVertex1,
    eVertex2: params.eVertex2,
    scanRate_mVs: params.scanRate,
    nCycles: params.nCycles,
    n: params.n,
    areaCm2: params.areaCm2,
    cMM: params.cMM,
    D_cm2_s: params.diffusionCoeff ?? D,
    E0Prime_V: params.formalPotential ?? E0_PRIME,
    stepV: Math.max(1e-4, (params.stepPotential ?? 1) / 1000),
  });
}

/**
 * Quasi-reversible model — Butler–Volmer + semi-infinite diffusion
 * solved semi-implicitly. Educational approximation; D_apparent from
 * Randles–Ševčík may be biased when ΔEp > the reversible value.
 */
function buildQuasiReversibleCV(params: CVSimParams): CVDataPoint[] {
  const { segs, dt } = buildPotentialProgram(params);
  const { n, cMM, areaCm2, scanRate } = params;

  const D_use = params.diffusionCoeff ?? D;
  const E0_use = params.formalPotential ?? E0_PRIME;
  const K0 = params.k0 ?? CV_BV_K0;
  const ALPHA = params.alpha ?? CV_BV_ALPHA;

  const cBulk = cMM * 1e-6;
  const sqrtPiD = Math.sqrt(Math.PI * D_use);
  const sqrtDt = Math.sqrt(dt);
  const noiseAmp = Math.sqrt(scanRate) * 0.005;

  const Afac = n * F * areaCm2;
  const beta = (2 * sqrtDt) / (Afac * sqrtPiD);

  const Iamps: number[] = [];
  const out: CVDataPoint[] = [];

  // Cottrell product-integration weights 2·(√k − √(k−1)) depend only on the
  // lag k, so precompute them once instead of calling sqrt twice per inner
  // iteration. The convolution itself is still O(n²) — the kernel decays as
  // 1/√k and truncating it would change the physics — so dense sweeps remain
  // expensive; the parameters panel warns before that becomes noticeable.
  const cottrellW = new Float64Array(segs.length + 2);
  for (let k = 1; k <= segs.length + 1; k++) {
    cottrellW[k] = 2 * (Math.sqrt(k) - Math.sqrt(k - 1));
  }

  for (let i = 0; i < segs.length; i++) {
    const { E, branch, cycle } = segs[i];
    const eta = E - E0_use;
    const kRed = Math.min(K_MAX, K0 * safeExp(-ALPHA * n * F * eta / (R * T)));
    const kOx  = Math.min(K_MAX, K0 * safeExp((1 - ALPHA) * n * F * eta / (R * T)));

    let sumHist = 0;
    for (let j = 0; j < i; j++) {
      // The current step already carries lag 1 (inside beta), so step j sits at lag i−j+1.
      sumHist += Iamps[j] * cottrellW[i - j + 1];
    }
    const convKnown = (sumHist * sqrtDt) / (Afac * sqrtPiD);

    let Iamp = 0;
    if (cBulk > 0) {
      const denom = 1 + Afac * beta * (kOx + kRed);
      Iamp = -Afac * (kRed * cBulk + (kOx + kRed) * convKnown) / denom;

      // Mass-balance safety net: clamp surface CR to [0, cBulk]. If we hit a
      // boundary, fall back to a non-implicit step bounded by the clamped CR
      // so the reported current is physically consistent with the surface
      // concentrations. Educational approximation only — not a full
      // finite-difference Nicholson–Shain solver.
      const CR_raw = -(convKnown + beta * Iamp);
      const thetaR = clamp(CR_raw / cBulk, 0, 1);
      const CR = thetaR * cBulk;
      const CO = cBulk - CR;
      if (thetaR <= 0 || thetaR >= 1) {
        Iamp = Afac * (kOx * CR - kRed * CO);
      }
    }
    // For blank (cBulk = 0) faradaic current is identically zero.
    Iamps.push(Iamp);
    out.push({
      E,
      I: Iamp * 1e6 + gaussianNoise(noiseAmp),
      cycle,
      t: i * dt,
      branch,
    });
  }
  return out;
}

function buildCVPoints(params: CVSimParams): CVDataPoint[] {
  const invalid = validateParams(params);
  if (invalid) {
    console.warn(`[CV simulation] invalid params — ${invalid}`);
    return [];
  }
  const model = params.cvModel ?? "reversible";
  return model === "quasi-reversible"
    ? buildQuasiReversibleCV(params)
    : buildReversibleCV(params);
}

/** Exported for tests — pure, deterministic apart from gaussianNoise. */
export function buildCVPointsForTest(params: CVSimParams): CVDataPoint[] {
  return buildCVPoints(params);
}

/**
 * Parse a CV WebSocket frame into a CVDataPoint. Pure helper exposed for
 * unit testing — guarantees no NaN / Infinity leaks into the dataset.
 */
export function parseCVWebSocketMessage(msg: unknown): CVDataPoint | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "cv_data") return null;
  if (m.E == null || m.I == null) return null;
  const E = Number(m.E);
  const I = Number(m.I);
  if (!Number.isFinite(E) || !Number.isFinite(I)) return null;
  const cycleRaw = m.cycle != null ? Number(m.cycle) : 1;
  const cycle =
    Number.isFinite(cycleRaw) && cycleRaw >= 1 ? Math.floor(cycleRaw) : 1;
  const tRaw =
    m.t != null ? Number(m.t) : m.timestamp != null ? Number(m.timestamp) : 0;
  const t = Number.isFinite(tRaw) ? tRaw : 0;
  const branch =
    m.branch === "forward" || m.branch === "reverse" || m.branch === "return"
      ? (m.branch as "forward" | "reverse" | "return")
      : undefined;
  const outOfRange = m.outOfRange === true ? true : undefined;
  return { E, I, cycle, t, branch, outOfRange };
}

export function useSimulatedCVData(speed: number = 40) {
  const [data, setData] = useState<CVDataPoint[]>([]);
  const allRef = useRef<CVDataPoint[]>([]);
  const idxRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      if (idxRef.current >= allRef.current.length) {
        setIsRunning(false);
        return;
      }
      const batch = Math.max(1, Math.floor(allRef.current.length / 200));
      // Advance the cursor here, not inside the state updater: React may call
      // an updater twice (StrictMode), which would skip every other batch.
      const start = idxRef.current;
      const end = Math.min(start + batch, allRef.current.length);
      idxRef.current = end;
      const chunk = allRef.current.slice(start, end);
      setData((prev) => prev.concat(chunk));
    }, speed);
    return () => clearInterval(interval);
  }, [isRunning, speed]);

  const start = useCallback((params: CVSimParams) => {
    const points = buildCVPoints(params);
    if (points.length === 0) {
      console.warn("[CV simulation] aborted: invalid parameters");
      return;
    }
    allRef.current = points;
    idxRef.current = 0;
    setData([]);
    setIsRunning(true);
  }, []);

  const stop = useCallback(() => setIsRunning(false), []);
  const reset = useCallback(() => {
    setIsRunning(false);
    setData([]);
    idxRef.current = 0;
    allRef.current = [];
  }, []);

  return { data, isRunning, start, stop, reset };
}
