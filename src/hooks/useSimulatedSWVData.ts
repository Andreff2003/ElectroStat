/**
 * SWV simulation hook.
 *
 * MODELS — physical solvers with an empirical fallback.
 * -----------------------------------------------------
 * Two physical solvers back the SWV mode, mirroring the two CV models:
 *
 *  A) "reversible"      → simulateReversibleDiffusionSWV
 *     Exact solution of planar semi-infinite diffusion with a Nernst
 *     surface: the response is a sum of Cottrell terms, one per
 *     potential jump of the staircase + square wave train (no mesh, no
 *     time stepping). INet = IForward − IReverse falls out of the physics.
 *
 *  B) "quasi-reversible" → simulateQuasiReversibleSWV
 *     Butler–Volmer kinetics + Cottrell-kernel convolution with each
 *     half-pulse split into graded sub-steps. Same K0/α regime as
 *     buildQuasiReversibleCV; agrees with (A) to about 2 % for fast
 *     kinetics. Educational model, not a full finite-difference solver.
 *
 *  C) "empirical"        → legacy Gaussian × Langmuir peak (kept as a
 *     fallback path — model id "empirical_swv_peak_langmuir" — while
 *     the physical solvers are tuned; not the default).
 *
 * This hook only feeds the simulated modes; live SWV runs through the
 * bridge and the ESP32 firmware (start_swv).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { validateSWVParameters, generateSWVProgram } from "@/utils/swvMetrics";
import {
  simulateReversibleDiffusionSWV,
  simulateQuasiReversibleSWV,
} from "@/utils/swvDiffusionSolver";

import type {
  SWVDataPoint,
  SWVModel,
  SWVParameters,
  SWVSimulationModel,
} from "@/types/swv";

export interface UseSimulatedSWVDataReturn {
  data: SWVDataPoint[];
  isRunning: boolean;
  isComplete: boolean;
  start: (params: SWVParameters) => void;
  stop: () => void;
  reset: () => void;
}

// ────────── legacy empirical fallback (kept for tuning) ──────────
const IMAX_UA = 1.6;
const KD_NM = 30;
const EPEAK_V = 0.22;

function gaussianNoise(sigma: number): number {
  const u1 = Math.max(Number.EPSILON, Math.random());
  const u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function simulateEmpiricalSWV(params: SWVParameters): SWVDataPoint[] {

  const program = generateSWVProgram(params);
  if (program.length === 0) return [];
  const C = Math.max(0, params.concentration_nM ?? 0);
  const Ipeak = IMAX_UA * (C / (C + KD_NM));
  const sigma = Math.max(0.02, 0.03 + params.amplitude_mV / 4000);
  const cBg = 0.05;
  const bgSlope = 0.02;
  const noiseSigma = 0.01;
  return program.map((step) => {
    const baseline = cBg + bgSlope * step.E;
    const iNetClean =
      Ipeak * Math.exp(-0.5 * ((step.E - EPEAK_V) / sigma) ** 2) + baseline;
    const iNet = iNetClean + gaussianNoise(noiseSigma);
    const commonCap = cBg + bgSlope * step.E * 0.5;
    const iForward =
      commonCap + 0.5 * (iNet - baseline) + gaussianNoise(noiseSigma);
    const iReverse =
      commonCap - 0.5 * (iNet - baseline) + gaussianNoise(noiseSigma);
    return {
      E: step.E,
      IForward: iForward,
      IReverse: iReverse,
      INet: iForward - iReverse,
      time: step.time,
      index: step.index,
      direction: step.direction,
    };
  });
}

function simulateSWV(params: SWVParameters): SWVDataPoint[] {
  const model: SWVModel = params.swvModel ?? "reversible";
  if (model === "quasi-reversible") return simulateQuasiReversibleSWV(params);
  if (model === "empirical") return simulateEmpiricalSWV(params);
  return simulateReversibleDiffusionSWV(params);
}

export function simulationModelId(params: SWVParameters): SWVSimulationModel {
  const model: SWVModel = params.swvModel ?? "reversible";
  if (model === "quasi-reversible") return "quasi_reversible_approx";
  if (model === "empirical") return "empirical_swv_peak_langmuir";
  return "reversible_diffusion_approx";
}

export function useSimulatedSWVData(): UseSimulatedSWVDataReturn {
  const [data, setData] = useState<SWVDataPoint[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bufRef = useRef<SWVDataPoint[]>([]);
  const idxRef = useRef(0);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRunning(false);
  }, []);

  const reset = useCallback(() => {
    stop();
    setData([]);
    setIsComplete(false);
    bufRef.current = [];
    idxRef.current = 0;
  }, [stop]);

  const start = useCallback(
    (params: SWVParameters) => {
      const v = validateSWVParameters(params);
      if (!v.ok) return;
      reset();
      const points = simulateSWV(params);
      if (points.length === 0) return;
      bufRef.current = points;
      idxRef.current = 0;
      setIsRunning(true);
      setIsComplete(false);
      const period_ms = Math.max(5, 1000 / params.frequency_Hz);
      timerRef.current = setInterval(() => {
        if (idxRef.current >= bufRef.current.length) {
          stop();
          setIsComplete(true);
          return;
        }
        const pt = bufRef.current[idxRef.current++];
        setData((prev) => [...prev, pt]);
      }, period_ms);
    },
    [reset, stop],
  );

  useEffect(() => () => stop(), [stop]);

  return { data, isRunning, isComplete, start, stop, reset };
}

/**
 * Model id exported for CSV/metadata. The active id now depends on the
 * chosen physical solver — see `simulationModelId`. This top-level export
 * is kept as the default (reversible) for backwards compatibility with
 * code that reads it as a constant.
 */
export const SWV_SIMULATION_MODEL_ID: SWVSimulationModel =
  "reversible_diffusion_approx";
