import { useState, useEffect, useRef, useCallback } from "react";
import { fetDrainCurrent, addCurrentNoise, KT_Q_300K } from "@/utils/fetModel";
import {
  FET_TIME_DURATION_S,
  FET_TIME_DT_S,
  FET_TIME_VG_READ_V,
} from "@/utils/fetConstants";

/**
 * ============================================================
 * SIMULATED DATA HOOKS FOR THE ELECTROSTAT BIOSENSOR DASHBOARD
 * ============================================================
 * Curves change with the user-supplied "concentration" (nM)
 * using a Langmuir binding model.
 * ============================================================
 */

export interface EISDataPoint {
  zReal: number;
  zImag: number;
  frequency: number;
  zMag: number;
  phase: number;
}

export interface FETTransferPoint {
  vg: number;
  id: number;
  /** Live hardware only: HSTIA output fell outside the AD5941's usable ADC window for this point. */
  outOfRange?: boolean;
}

export interface FETTimePoint {
  time: number;
  id: number;
  /** Live hardware only: HSTIA output fell outside the AD5941's usable ADC window for this point. */
  outOfRange?: boolean;
}

// Shared simulated binding parameters
const KD = 25;          // nM — simulated aptamer dissociation constant
const RCT_MIN = 300;    // Ω
const RCT_MAX = 800;    // Ω
const RS = 200;         // Ω — solution resistance (constant)
const CDL = 20e-6;      // F — double-layer capacitance (20 µF)
const AW_BASE = 80;     // Ω/√s — Warburg coefficient (concentration-independent)
const VT_BASELINE = 0.30;   // V
const VT_MAX_SHIFT = 0.40;  // V
const ID_MAX = 50;          // µA at top of analyte curve

function noise(amp: number) {
  return (Math.random() - 0.5) * amp;
}

/**
 * EIS — Nyquist semicircle whose diameter Rct grows with concentration.
 */
export function useSimulatedEIS(speed: number = 200) {
  const [data, setData] = useState<EISDataPoint[]>([]);
  const indexRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);
  const allPoints = useRef<EISDataPoint[]>([]);

  const buildPoints = useCallback((concentration: number, totalPoints = 61, freqMin = 0.1, freqMax = 1e5) => {
    const deltaRct =
      concentration > 0
        ? (RCT_MAX - RCT_MIN) * concentration / (concentration + KD)
        : 0;
    const Rct = RCT_MIN + deltaRct;

    const logMin = Math.log10(freqMin);
    const logMax = Math.log10(freqMax);

    const points: EISDataPoint[] = [];
    for (let i = 0; i < totalPoints; i++) {
      const frequency = Math.pow(10, logMax - (i / (totalPoints - 1)) * (logMax - logMin));
      const omega = 2 * Math.PI * frequency;

      // Warburg impedance: Zw = Aw/√ω · (1 − j)
      const wMag = AW_BASE / Math.sqrt(omega);
      const zwRe = wMag;
      const zwIm = -wMag;

      // Faradaic branch: Zf = Rct + Zw
      const zfRe = Rct + zwRe;
      const zfIm = zwIm;

      // Admittance of faradaic branch: Yf = 1/Zf
      const zfMag2 = zfRe * zfRe + zfIm * zfIm;
      const yfRe = zfRe / zfMag2;
      const yfIm = -zfIm / zfMag2;

      // Parallel with Cdl: Ycdl = jωCdl
      const yTotRe = yfRe;
      const yTotIm = yfIm + omega * CDL;

      // Parallel impedance: Zp = 1/Ytot
      const yMag2 = yTotRe * yTotRe + yTotIm * yTotIm;
      const zpRe = yTotRe / yMag2;
      const zpIm = -yTotIm / yMag2;

      // Total impedance: Z = Rs + Zp
      const zReal = RS + zpRe + noise(2);
      const zImag = zpIm + noise(2); // true Im(Z); negative for capacitive behavior
      const zMag = Math.sqrt(zReal * zReal + zImag * zImag);
      const phase = Math.atan2(zImag, zReal) * (180 / Math.PI);
      points.push({
        zReal: Math.round(zReal * 10) / 10,
        zImag: Math.round(zImag * 10) / 10,
        frequency: Math.round(frequency * 100) / 100,
        zMag: Math.round(zMag * 10) / 10,
        phase: Math.round(phase * 10) / 10,
      });
    }
    return points;
  }, []);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      if (indexRef.current >= allPoints.current.length) {
        setIsRunning(false);
        return;
      }
      const pt = allPoints.current[indexRef.current];
      indexRef.current++;
      if (!pt) return; // guard against a rebuilt/shorter buffer mid-sweep
      setData(prev => [...prev, pt]);
    }, speed);
    return () => clearInterval(interval);
  }, [isRunning, speed]);

  const start = useCallback((concentration: number = 0, totalPoints?: number, freqMin?: number, freqMax?: number) => {
    allPoints.current = buildPoints(concentration, totalPoints, freqMin, freqMax);
    setData([]);
    indexRef.current = 0;
    setIsRunning(true);
  }, [buildPoints]);

  const reset = useCallback(() => {
    setIsRunning(false);
    setData([]);
    indexRef.current = 0;
  }, []);

  const stop = useCallback(() => {
    setIsRunning(false);
  }, []);

  return { data, isRunning, start, reset, stop };
}

/**
 * Overridable simulation parameters for the BioFET hooks. All fields are
 * optional; missing values fall back to the module-level constants above so
 * behaviour is unchanged when the caller doesn't customise anything.
 */
export interface FETSimOverrides {
  kd_nM?: number;
  vtBaseline_V?: number;
  deltaVtMax_V?: number;
  idMax_uA?: number;
  idealityFactor?: number;
  bindingRate_perS?: number;
  readoutBias_V?: number;
  timeDuration_s?: number;
  timeStep_s?: number;
  injectionTime_s?: number;
}

/**
 * BioFET — transfer curve. Analyte Vt shifts right with concentration.
 */
export function useSimulatedFETTransfer(speed: number = 100) {
  const [baseline, setBaseline] = useState<FETTransferPoint[]>([]);
  const [withAnalyte, setWithAnalyte] = useState<FETTransferPoint[]>([]);
  const indexRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);

  const allBaseline = useRef<FETTransferPoint[]>([]);
  const allAnalyte = useRef<FETTransferPoint[]>([]);

  const buildPoints = useCallback((
    concentration: number,
    vgMin = -0.5,
    vgMax = 1.5,
    totalPoints = 51,
    overrides: FETSimOverrides = {},
  ) => {
    const kd = overrides.kd_nM ?? KD;
    const vtBase = overrides.vtBaseline_V ?? VT_BASELINE;
    const dVtMax = overrides.deltaVtMax_V ?? VT_MAX_SHIFT;
    const idMax = overrides.idMax_uA ?? ID_MAX;
    const n = overrides.idealityFactor ?? 2.0;

    const deltaVt =
      concentration > 0 ? dVtMax * concentration / (concentration + kd) : 0;
    const VtBase = vtBase;
    const VtAnalyte = vtBase + deltaVt;

    const base: FETTransferPoint[] = [];
    const analyte: FETTransferPoint[] = [];

    // Softplus-smoothed MOSFET model — see src/utils/fetModel.ts. K is chosen
    // so that strong-inversion Id at Vg = vgMax matches idMax for baseline.
    const K = idMax / ((vgMax - VtBase) ** 2);
    const params = { K, n, vt_thermal: KT_Q_300K };

    for (let i = 0; i < totalPoints; i++) {
      const vg = vgMin + (i / (totalPoints - 1)) * (vgMax - vgMin);
      const idB = addCurrentNoise(fetDrainCurrent(vg, VtBase, params));
      const idA = addCurrentNoise(fetDrainCurrent(vg, VtAnalyte, params));
      base.push({ vg: Math.round(vg * 100) / 100, id: idB });
      analyte.push({ vg: Math.round(vg * 100) / 100, id: idA });
    }
    return { base, analyte };
  }, []);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      if (indexRef.current >= allBaseline.current.length) {
        setIsRunning(false);
        return;
      }
      const idx = indexRef.current;
      const b = allBaseline.current[idx];
      const a = allAnalyte.current[idx];
      indexRef.current++;
      if (!b || !a) return; // guard against a rebuilt/shorter buffer mid-sweep
      setBaseline(prev => [...prev, b]);
      setWithAnalyte(prev => [...prev, a]);
    }, speed);
    return () => clearInterval(interval);
  }, [isRunning, speed]);

  const start = useCallback((
    concentration: number = 0,
    vgMin?: number,
    vgMax?: number,
    totalPoints?: number,
    overrides?: FETSimOverrides,
  ) => {
    const { base, analyte } = buildPoints(concentration, vgMin, vgMax, totalPoints, overrides);
    allBaseline.current = base;
    allAnalyte.current = analyte;
    setBaseline([]);
    setWithAnalyte([]);
    indexRef.current = 0;
    setIsRunning(true);
  }, [buildPoints]);

  const reset = useCallback(() => {
    setIsRunning(false);
    setBaseline([]);
    setWithAnalyte([]);
    indexRef.current = 0;
  }, []);

  const stop = useCallback(() => {
    setIsRunning(false);
  }, []);

  return { baseline, withAnalyte, isRunning, start, reset, stop };
}

/**
 * BioFET time response — drop magnitude scales with concentration.
 */
export function useSimulatedFETTime(speed: number = 200) {
  const [data, setData] = useState<FETTimePoint[]>([]);
  const timeRef = useRef(0);
  const concRef = useRef(0);
  const overridesRef = useRef<FETSimOverrides>({});
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (!isRunning) return;

    const concentration = concRef.current;
    const o = overridesRef.current;
    const kd = o.kd_nM ?? KD;
    const vtBase = o.vtBaseline_V ?? VT_BASELINE;
    const dVtMax = o.deltaVtMax_V ?? VT_MAX_SHIFT;
    const idMax = o.idMax_uA ?? ID_MAX;
    const n = o.idealityFactor ?? 2.0;
    const bindingRate = o.bindingRate_perS ?? 0.5;
    const vgRead = o.readoutBias_V ?? FET_TIME_VG_READ_V;
    const duration = o.timeDuration_s ?? FET_TIME_DURATION_S;
    const DT = o.timeStep_s ?? FET_TIME_DT_S;
    const injectionTime = o.injectionTime_s ?? 10;

    // Equilibrium ΔVt from the same Langmuir binding used in the transfer
    // curve so the two simulated signals are physically consistent.
    const deltaVtEq =
      concentration > 0 ? dVtMax * concentration / (concentration + kd) : 0;

    // Fixed read-out gate bias and FET parameters — mirrors useSimulatedFETTransfer.
    const VtBase = vtBase;
    const vgMaxRef = 1.5;
    const K = idMax / ((vgMaxRef - VtBase) ** 2);
    const fetParams = { K, n, vt_thermal: KT_Q_300K };

    const interval = setInterval(() => {
      const t = timeRef.current * DT;
      let vt = VtBase;
      if (t >= injectionTime) {
        const elapsed = t - injectionTime;
        vt = VtBase + deltaVtEq * (1 - Math.exp(-bindingRate * elapsed));
      }
      const id = addCurrentNoise(
        fetDrainCurrent(vgRead, vt, fetParams),
        0.01,
        0.05,
      );
      setData(prev => [...prev, {
        time: Math.round(t * 10) / 10,
        id: Math.round(id * 100) / 100,
      }]);
      timeRef.current++;
      if (t >= duration) setIsRunning(false);
    }, speed);

    return () => clearInterval(interval);
  }, [isRunning, speed]);

  const start = useCallback((concentration: number = 0, overrides: FETSimOverrides = {}) => {
    concRef.current = concentration;
    overridesRef.current = overrides;
    setData([]);
    timeRef.current = 0;
    setIsRunning(true);
  }, []);

  const reset = useCallback(() => {
    setIsRunning(false);
    setData([]);
    timeRef.current = 0;
  }, []);

  const stop = useCallback(() => {
    setIsRunning(false);
  }, []);

  return { data, isRunning, start, reset, stop };
}
