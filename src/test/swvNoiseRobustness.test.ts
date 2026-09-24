import { describe, it, expect } from "vitest";
import { analyzeSWV } from "@/utils/swvMetrics";
import { simulateReversibleDiffusionSWV } from "@/utils/swvDiffusionSolver";
import type { SWVDataPoint, SWVParameters } from "@/types/swv";

/**
 * How the SWV signal-to-noise ratio (green >= 10, yellow >= 3) relates to the
 * accuracy of the reported peak current as noise is added to the 100 nM sweep
 * (peak 4.06 nA). Thesis Figure 16.
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
  quietTime_s: 2, direction: "anodic", area_cm2: 0.0707, nElectrons: 1, concentration_nM: 100,
} as SWVParameters;
const base = simulateReversibleDiffusionSWV(P);
const ip0 = Math.abs(analyzeSWV(base, "auto").metrics.peakCurrentCorrected_uA!);

function sweep(ampNA: number, runs = 15) {
  const snrs: number[] = [];
  const errs: number[] = [];
  let noPeak = 0;
  for (let s = 1; s <= runs; s++) {
    const m = analyzeSWV(withNoise(base, ampNA / 1000, Math.round(ampNA * 1000) * 100 + s), "auto").metrics;
    if (!m.peakDetected) noPeak++;
    snrs.push(m.snr ?? 0);
    errs.push((100 * Math.abs(Math.abs(m.peakCurrentCorrected_uA!) - ip0)) / ip0);
  }
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  return { snr: mean(snrs), err: mean(errs), noPeak };
}

describe("SWV noise robustness vs the SNR thresholds", () => {
  it("noise of +-0.2 nA leaves the ratio deep in green and the peak within about 5 %", () => {
    const r = sweep(0.2);
    expect(r.snr).toBeGreaterThan(20);
    expect(r.err).toBeLessThan(5);
  });

  it("the ratio crosses from green to yellow near +-0.6 nA, where the peak is already about 12 % high", () => {
    const r = sweep(0.6);
    expect(r.snr).toBeGreaterThan(9);
    expect(r.snr).toBeLessThan(11.5);
    expect(r.err).toBeGreaterThan(8);
    expect(r.err).toBeLessThan(16);
  });

  it("the error keeps growing through the yellow band", () => {
    expect(sweep(1).err).toBeGreaterThan(sweep(0.6).err);
    expect(sweep(2).err).toBeGreaterThan(sweep(1).err);
  });

  it("the peak is lost (SNR < 3) at +-4 nA in every run", () => {
    const r = sweep(4);
    expect(r.noPeak).toBe(15);
    expect(r.snr).toBeLessThan(3);
  });
});
