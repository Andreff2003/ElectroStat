import { describe, it, expect } from "vitest";
import { analyzeSWV } from "@/utils/swvMetrics";
import {
  simulateReversibleDiffusionSWV,
  simulateQuasiReversibleSWV,
} from "@/utils/swvDiffusionSolver";
import { fitLinearSWV, computeLODSWV, type CalibrationPoint } from "@/components/CalibrationPanel";
import type { SWVDataPoint, SWVParameters } from "@/types/swv";

/**
 * SWV calibration through the whole pipeline (solver -> baseline correction ->
 * peak detection -> the calibration panel's linear fit), in the nanomolar range
 * the panel works in. Like CV, and unlike EIS/BioFET, the response is a straight
 * line because the analyte diffuses freely and nothing saturates. Thesis Figure 15
 * and Table 14.
 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function withNoise(pts: SWVDataPoint[], ampUA: number, seed: number): SWVDataPoint[] {
  const r = rng(seed);
  return pts.map((p) => ({ ...p, INet: p.INet + (r() - 0.5) * 2 * ampUA }));
}

const P = {
  startE: -0.2, endE: 0.6, step_mV: 2, amplitude_mV: 25, frequency_Hz: 25,
  quietTime_s: 2, direction: "anodic", area_cm2: 0.0707, nElectrons: 1,
} as SWVParameters;
const CONCS_NM = [0, 0, 0, 10, 25, 50, 100, 200, 500];

function series(model: "reversible" | "quasi", noiseUA: number): CalibrationPoint[] {
  return CONCS_NM.map((c, i) => {
    const params = { ...P, concentration_nM: c } as SWVParameters;
    const sim = model === "reversible"
      ? simulateReversibleDiffusionSWV(params)
      : simulateQuasiReversibleSWV(params);
    const data = noiseUA > 0 ? withNoise(sim, noiseUA, 4242 + i) : sim;
    const m = analyzeSWV(data, "auto").metrics;
    return {
      concentration: c,
      signal: m.peakCurrentCorrected_uA ?? 0,
      raw: m.peakCurrentRaw_uA ?? 0,
      timestamp: i,
    };
  });
}

describe("SWV calibration recovers a straight line down to the nanomolar range", () => {
  it("noise-free reversible: exactly linear (R2 = 1) with the solver's own sensitivity", () => {
    const fit = fitLinearSWV(series("reversible", 0))!;
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(Math.abs(fit.intercept)).toBeLessThan(1e-9);
    // 0.0406 nA per nM, i.e. 203.1 uA at 5 mM.
    expect(fit.slope * 1000).toBeGreaterThan(0.0405);
    expect(fit.slope * 1000).toBeLessThan(0.0408);
  });

  it("the quasi-reversible sensitivity is ~22% below the reversible one", () => {
    const rev = fitLinearSWV(series("reversible", 0))!;
    const qr = fitLinearSWV(series("quasi", 0))!;
    expect(qr.r2).toBeCloseTo(1, 6);
    const ratio = qr.slope / rev.slope;
    expect(ratio).toBeGreaterThan(0.76);
    expect(ratio).toBeLessThan(0.80);
  });

  it("with +-0.05 nA of noise: slope within 0.5%, R2 > 0.99999, finite sub-nM LOD/LOQ", () => {
    const clean = fitLinearSWV(series("reversible", 0))!;
    const pts = series("reversible", 0.00005);
    const fit = fitLinearSWV(pts)!;
    expect(Math.abs(fit.slope / clean.slope - 1)).toBeLessThan(0.005);
    expect(fit.r2).toBeGreaterThan(0.99999);
    const lod = computeLODSWV(pts)!;
    expect(lod.sigmaSource).toBe("replicates");
    expect(lod.value).toBeGreaterThan(0.05);
    expect(lod.value).toBeLessThan(0.5);
    expect(lod.loq).toBeGreaterThan(lod.value);
    // The blanks read at about the noise amplitude, not zero: the "peak" of a
    // trace with nothing in it is its largest excursion.
    const blanks = pts.filter((p) => p.concentration === 0).map((p) => p.signal * 1000);
    for (const b of blanks) {
      expect(b).toBeGreaterThan(0.03);
      expect(b).toBeLessThan(0.07);
    }
  });
});
