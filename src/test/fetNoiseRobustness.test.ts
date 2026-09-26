import { describe, it, expect } from "vitest";
import { computeFETTransferMetrics } from "@/utils/fetMetrics";
import { computeFETMetrics } from "@/components/SignalQuality";
import { fetPair, trueShift_mV, mean } from "./fetSimHelper";

/**
 * How the BioFET Baseline Noise thresholds (green < 5 %, yellow < 15 %) relate
 * to the accuracy of the reported shift as relative noise is added to the
 * 25 nM sweep (true shift 200 mV). 15 sweeps per level. Thesis Figure 18.
 */
function level(pct: number, runs = 15) {
  const noise: number[] = [], err: number[] = [];
  let fallbacks = 0;
  for (let s = 1; s <= runs; s++) {
    const p = fetPair(25, Math.round(pct * 100) * 100 + s, { rel: pct / 100 });
    const m = computeFETTransferMetrics(p.baseline, p.analyte);
    noise.push(computeFETMetrics(p.analyte, p.baseline).baselineStability);
    err.push(Math.abs(m.deltaVt_mV! - trueShift_mV(25)));
    if (m.vtAnalyteMethod !== "sqrt_extrapolation" || m.vtBaselineMethod !== "sqrt_extrapolation") fallbacks++;
  }
  return { noise: mean(noise), err: mean(err), fallbacks };
}

describe("BioFET Baseline Noise vs the accuracy of the reported shift", () => {
  it("the indicator reads back the injected noise up to about 20 %", () => {
    expect(level(1).noise).toBeGreaterThan(0.7);
    expect(level(1).noise).toBeLessThan(1.4);
    expect(level(10).noise).toBeGreaterThan(8);
    expect(level(10).noise).toBeLessThan(12.5);
    expect(level(20).noise).toBeGreaterThan(14);
    expect(level(20).noise).toBeLessThan(23);
  });

  it("green below about 5 % noise, yellow between 5 and 15 %, red beyond", () => {
    expect(level(2).noise).toBeLessThan(5);
    const at7 = level(7.5).noise;
    expect(at7).toBeGreaterThan(5);
    expect(at7).toBeLessThan(15);
    expect(level(30).noise).toBeGreaterThan(15);
  });

  it("the error in the shift grows with the noise: ~16 mV at the simulator default, ~28 mV at the green limit, above 100 mV at the yellow/red limit", () => {
    const e2 = level(2).err, e5 = level(5).err, e15 = level(15).err;
    expect(e2).toBeGreaterThan(8);
    expect(e2).toBeLessThan(25);
    expect(e5).toBeGreaterThan(15);
    expect(e5).toBeLessThan(45);
    expect(e15).toBeGreaterThan(100);
    expect(e2).toBeLessThan(e5);
    expect(e5).toBeLessThan(e15);
  });

  it("the sqrt extraction holds up to 10 % noise, then the fallback takes over and is used in every sweep from 30 %", () => {
    expect(level(10).fallbacks).toBe(0);
    expect(level(15).fallbacks).toBeGreaterThan(0);
    expect(level(20).fallbacks).toBeGreaterThan(level(15).fallbacks);
    expect(level(30).fallbacks).toBe(15);
  });

  it("the error peaks where the method is chosen curve by curve: sweeps whose two thresholds were read by different methods are off by hundreds of mV", () => {
    const SQ = "sqrt_extrapolation";
    const classify = (pct: number) => {
      const both: number[] = [], mixed: number[] = [], fb: number[] = [];
      for (let s = 1; s <= 15; s++) {
        const p = fetPair(25, Math.round(pct * 100) * 100 + s, { rel: pct / 100 });
        const m = computeFETTransferMetrics(p.baseline, p.analyte);
        const e = Math.abs(m.deltaVt_mV! - trueShift_mV(25));
        const a = m.vtAnalyteMethod === SQ, b = m.vtBaselineMethod === SQ;
        (a && b ? both : a !== b ? mixed : fb).push(e);
      }
      return { both, mixed, fb };
    };
    const at20 = classify(20), at30 = classify(30);
    // at 20 % most sweeps are mixed and their error is several hundred mV ...
    expect(at20.mixed.length).toBeGreaterThanOrEqual(7);
    expect(mean(at20.mixed)).toBeGreaterThan(250);
    // ... at 30 % nearly all fall back on both curves, and the error drops to that of the fallback alone.
    expect(at30.fb.length).toBeGreaterThanOrEqual(12);
    expect(mean(at30.fb)).toBeLessThan(150);
    expect(mean(at30.fb)).toBeLessThan(mean(at20.mixed));
  });
});
