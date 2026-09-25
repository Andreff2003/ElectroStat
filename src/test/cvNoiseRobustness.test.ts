import { describe, it, expect } from "vitest";
import { computeCVMetrics } from "@/utils/computeCVMetrics";
import { computeCVSignalQuality, estimateCVStepMv } from "@/utils/cvSignalQuality";
import { simulateReversibleDiffusionCV } from "@/utils/cvDiffusionSolver";
import type { CVDataPoint } from "@/hooks/useSimulatedCVData";

/**
 * How far the CV signal-quality SNR thresholds (green >=10, yellow >=3, see
 * cvSignalQuality.ts) sit from where the reported peak current itself starts
 * to drift under noise. Unlike EIS (see eisNoiseRobustness.test.ts), the peak
 * current is more exposed to noise than the SNR suggests, and the cause is the
 * baseline: a straight line fitted to a short stretch of each branch and
 * extended to the peak. The SNR itself follows the scatter of the points
 * correctly. Thesis Figure 14.
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
const cMM = 5;
const SOLVER_DEFAULTS = {
  eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6,
  scanRate_mVs: 100, nCycles: 1, n: 1, areaCm2: A, cMM,
};

function sweep(ampUA: number, runs: number, baseline: "auto" | "none" = "auto") {
  const basePts = simulateReversibleDiffusionCV(SOLVER_DEFAULTS);
  const m0 = computeCVMetrics(basePts, { scanRate_mVs: 100, n: 1, cMM, areaCm2: A, baselineMethodInput: baseline })!;
  const snrs: number[] = [];
  const errs: number[] = [];
  for (let s = 1; s <= runs; s++) {
    const noisy = withNoise(basePts, ampUA, 1000 * ampUA + s);
    const m = computeCVMetrics(noisy, { scanRate_mVs: 100, n: 1, cMM, areaCm2: A, baselineMethodInput: baseline })!;
    snrs.push(m.SNR_cathodic);
    errs.push(100 * Math.abs(Math.abs(m.IpcCorrected) - Math.abs(m0.IpcCorrected)) / Math.abs(m0.IpcCorrected));
  }
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  return { meanSNR: mean(snrs), meanErr: mean(errs) };
}

describe("CV noise robustness vs the SNR thresholds (green >=10, yellow >=3)", () => {
  it("the default noise-free scan sits far into the green band (SNR > 1000)", () => {
    const pts = simulateReversibleDiffusionCV(SOLVER_DEFAULTS);
    const m = computeCVMetrics(pts, { scanRate_mVs: 100, n: 1, cMM, areaCm2: A })!;
    expect(m.SNR_cathodic).toBeGreaterThan(1000);
    expect(computeCVSignalQuality(m, { stepMv: estimateCVStepMv(pts), n: 1 }).snrLevel).toBe("green");
  });

  it("SNR crosses from green to yellow around +-8 to +-10 uA of injected noise", () => {
    const { meanSNR: snr8 } = sweep(8, 15);
    const { meanSNR: snr10 } = sweep(10, 15);
    expect(snr8).toBeGreaterThan(10);
    expect(snr10).toBeLessThanOrEqual(10.5);
  });

  it("the reported peak current already drifts >10% at +-4 uA, while SNR is still deep green (>20)", () => {
    const { meanSNR, meanErr } = sweep(4, 15);
    expect(meanSNR).toBeGreaterThan(20); // deep green, threshold is 10
    expect(meanErr).toBeGreaterThan(8); // already close to/over the 10% mark
  });

  it("so peak-current accuracy degrades before the SNR indicator would warn (asymmetric with EIS)", () => {
    // At +-2 uA (SNR deep green, ~55) the error is still small...
    const low = sweep(2, 15);
    expect(low.meanErr).toBeLessThan(3);
    // ...but by +-6 uA (SNR still green, ~16, well above the yellow cutoff of 10)
    // the error is already an order of magnitude larger.
    const mid = sweep(6, 15);
    expect(mid.meanSNR).toBeGreaterThan(10);
    expect(mid.meanErr).toBeGreaterThan(8);
  });

  it("the error comes from the extrapolated baseline: with correction off, the same noise leaves the peak within ~4% at +-4 uA", () => {
    const withBaseline = sweep(4, 15, "auto");
    const without = sweep(4, 15, "none");
    expect(withBaseline.meanErr).toBeGreaterThan(8);
    expect(without.meanErr).toBeLessThan(4);
  });
});
