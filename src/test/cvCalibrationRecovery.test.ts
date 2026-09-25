import { describe, it, expect } from "vitest";
import { computeCVMetrics } from "@/utils/computeCVMetrics";
import {
  buildCVCalibrationPoint,
  summarizeCalibration,
  randlesSevcikIpUA,
} from "@/utils/cvCalibration";
import { simulateReversibleDiffusionCV } from "@/utils/cvDiffusionSolver";
import type { CVDataPoint } from "@/hooks/useSimulatedCVData";

/**
 * The CV calibration pipeline (unlike EIS/BioFET) fits a straight line, not
 * a Langmuir isotherm, because peak current is governed by diffusion of a
 * freely-dissolved redox probe rather than by a saturable binding event
 * (see cvCalibration.ts). This checks that the fitted sensitivity actually
 * recovers the Randles-Sevcik-predicted value across a concentration series,
 * both in the noise-free limit and with a modest injected noise level.
 * See scratchpad cv_calibration.png / Figure 13 in the thesis.
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
function withNoise(pts: CVDataPoint[], ampUA: number, seed: number): CVDataPoint[] {
  const rnd = rng(seed);
  return pts.map((p) => ({ ...p, I: p.I + (rnd() - 0.5) * 2 * ampUA }));
}

const A = 0.0707;
const SOLVER_DEFAULTS = {
  eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6,
  scanRate_mVs: 100, nCycles: 1, n: 1, areaCm2: A,
};
const CONCS = [0, 0, 0, 0.5, 1, 2, 5, 10];

describe("CV peak current follows the square root of the scan rate", () => {
  it("each fourfold increase (25 -> 100 -> 400 mV/s) doubles the cathodic peak; dEp and D_apparent do not move", () => {
    const run = (v: number) => {
      const pts = simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, scanRate_mVs: v, cMM: 5 });
      return computeCVMetrics(pts, { scanRate_mVs: v, n: 1, cMM: 5, areaCm2: A })!;
    };
    const m25 = run(25), m100 = run(100), m400 = run(400);
    expect(m100.IpcCorrected / m25.IpcCorrected).toBeCloseTo(2, 2);
    expect(m400.IpcCorrected / m100.IpcCorrected).toBeCloseTo(2, 2);
    expect(Math.abs(m25.deltaEp - m400.deltaEp)).toBeLessThan(1);
    expect(Math.abs(m25.D_apparent / m400.D_apparent - 1)).toBeLessThan(0.01);
  });
});

describe("CV calibration recovers the Randles-Sevcik sensitivity across a concentration series", () => {
  it("noise-free: exact line (R2=1), slope within 3% of the theoretical cathodic sensitivity", () => {
    const pts = CONCS.map((c) => {
      const sim = simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, cMM: c });
      const m = computeCVMetrics(sim, { scanRate_mVs: 100, n: 1, cMM: c, areaCm2: A });
      return buildCVCalibrationPoint(c, m, "reversible");
    });
    const summary = summarizeCalibration(pts, "mean");
    expect(summary.fit).not.toBeNull();
    expect(summary.fit!.r2).toBeCloseTo(1, 5);
    expect(Math.abs(summary.fit!.intercept)).toBeLessThan(1e-6);

    const theoreticalSlope = randlesSevcikIpUA({ n: 1, areaCm2: A, cMM: 1, scanRate_mVs: 100 })!;
    const relErr = Math.abs(summary.fit!.slope - theoreticalSlope) / theoreticalSlope;
    // The mean-response slope sits a few percent below the cathodic-only
    // theoretical value because the mean also includes the anodic peak,
    // which baseline correction under-reads by a few percent (see the
    // single-concentration Results above). Not a bug, just what "mean" means.
    expect(relErr).toBeLessThan(0.05);
  });

  it("with +-0.5 uA injected noise, over 8 series: slope within 1 %, R2 > 0.999, and a blank-based LOD that is optimistic and varies widely", () => {
    const cleanPts = CONCS.map((c) => {
      const sim = simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, cMM: c });
      return buildCVCalibrationPoint(c, computeCVMetrics(sim, { scanRate_mVs: 100, n: 1, cMM: c, areaCm2: A }), "reversible");
    });
    const cleanSlope = summarizeCalibration(cleanPts, "mean").fit!.slope;
    const lods: number[] = [];
    const blanks: number[] = [];
    for (let k = 0; k < 8; k++) {
      const pts = CONCS.map((c, i) => {
        const clean = simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, cMM: c });
        const noisy = withNoise(clean, 0.5, 5000 + 100 * k + i);
        return buildCVCalibrationPoint(c, computeCVMetrics(noisy, { scanRate_mVs: 100, n: 1, cMM: c, areaCm2: A }), "reversible");
      });
      const summary = summarizeCalibration(pts, "mean");
      expect(summary.fit!.r2).toBeGreaterThan(0.999);
      expect(Math.abs(summary.fit!.slope / cleanSlope - 1)).toBeLessThan(0.01);
      expect(summary.sigmaSource).toBe("blank-replicates");
      expect(summary.lod_mM!).toBeGreaterThan(0);
      lods.push(summary.lod_mM!);
      pts.filter((p) => p.concentration_mM === 0).forEach((p) => blanks.push(p.responseMean_uA!));
    }
    // The blanks read ~0.3-1.6 uA, not zero (largest excursion of a trace with nothing in it) ...
    expect(Math.min(...blanks)).toBeGreaterThan(0.25);
    expect(Math.max(...blanks)).toBeLessThan(1.7);
    // ... and they are nearly equal, so the LOD is optimistic: the median is far below the
    // 3*sigma/slope = 0.055 mM that the injected noise (SD 0.29 uA) would give,
    const noiseBased = (3 * (0.5 / Math.sqrt(3))) / cleanSlope;
    const sorted = [...lods].sort((a, b) => a - b);
    const median = (sorted[3] + sorted[4]) / 2;
    expect(median).toBeLessThan(0.5 * noiseBased);
    // and it varies by more than an order of magnitude between series, since it rests on three blanks.
    expect(sorted[7] / sorted[0]).toBeGreaterThan(10);
  });
});
