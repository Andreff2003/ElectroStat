import { describe, it, expect } from "vitest";
import { computeFETTransferMetrics } from "@/utils/fetMetrics";
import { computeFETVtDetailed } from "@/utils/fetVt";
import { computeFETMetrics } from "@/components/SignalQuality";
import { KT_Q_300K } from "@/utils/fetModel";
import { fetPair, trueShift_mV, mean, sd } from "./fetSimHelper";

/**
 * BioFET: recovered vs known values on the simulated transistor (true Vt =
 * 0.30 V, shift 400 mV at saturation with Kd = 25 nM, ideality factor 2,
 * 2 % + 0.005 uA noise). Thesis Table 15.
 */
const noiseFreeShift = (c: number) => {
  const p = fetPair(c, 1, { noise: false });
  return computeFETTransferMetrics(p.baseline, p.analyte).deltaVt_mV!;
};
const noisyRuns = (c: number, seed0: number, n = 30) =>
  Array.from({ length: n }, (_, i) => {
    const p = fetPair(c, seed0 + i);
    const m = computeFETTransferMetrics(p.baseline, p.analyte);
    const q = computeFETMetrics(p.analyte, p.baseline);
    return { m, q };
  });

describe("BioFET Vt extraction on the noise-free simulated transistor", () => {
  it("baseline Vt within 2 mV of 0.30 V and no shift at the blank", () => {
    const p = fetPair(0, 1, { noise: false });
    const m = computeFETTransferMetrics(p.baseline, p.analyte);
    expect(Math.abs(m.vtBaseline! - 0.3)).toBeLessThan(0.002);
    expect(m.deltaVt_mV).toBe(0);
  });

  it("the shift is recovered 0.5-2.5 % low at every concentration, more so near the top of the sweep", () => {
    for (const c of [25, 200, 1e6]) {
      const ratio = noiseFreeShift(c) / trueShift_mV(c);
      expect(ratio).toBeGreaterThan(0.975);
      expect(ratio).toBeLessThan(0.995);
    }
    // 392.7 mV recovered against 400 mV at saturation
    expect(noiseFreeShift(1e6)).toBeGreaterThan(388);
    expect(noiseFreeShift(1e6)).toBeLessThan(396);
  });

  it("the bias is a property of the smooth transition: it disappears when the transition is sharp", () => {
    const p = fetPair(1e6, 1, { noise: false, n: 0.5 });
    const m = computeFETTransferMetrics(p.baseline, p.analyte);
    expect(Math.abs(m.vtBaseline! - 0.3)).toBeLessThan(0.0005);
    expect(Math.abs(m.deltaVt_mV! - 400)).toBeLessThan(0.5);
    // while at the default ideality factor the same curve reads 7 mV low
    expect(noiseFreeShift(1e6)).toBeLessThan(394);
  });

  it("the quality panel reads the subthreshold slope of the ideal curve within 1 % of ln(10) n kT/q", () => {
    const p = fetPair(25, 1, { noise: false });
    const theory = Math.log(10) * 2 * KT_Q_300K * 1000; // 119.0 mV/dec
    const ss = computeFETMetrics(p.analyte, p.baseline).subthresholdSlope;
    expect(Math.abs(ss / theory - 1)).toBeLessThan(0.01);
  });

  it("the constant-current fallback under-reads a 356 mV shift by about a third", () => {
    const p = fetPair(200, 7, { noise: false });
    const fb = (c: typeof p.baseline) => computeFETVtDetailed(c, { minPoints: 10000 });
    expect(fb(p.baseline).method).toBe("constant_current_fallback");
    const fbShift = (fb(p.analyte).vt! - fb(p.baseline).vt!) * 1000;
    const sqrtShift = computeFETTransferMetrics(p.baseline, p.analyte).deltaVt_mV!;
    expect(fbShift / sqrtShift).toBeGreaterThan(0.6);
    expect(fbShift / sqrtShift).toBeLessThan(0.75);
    // and the fallback threshold itself sits far above the true 0.30 V
    expect(fb(p.baseline).vt!).toBeGreaterThan(0.5);
  });
});

describe("BioFET Vt extraction with the simulator's own noise (30 sweeps per concentration)", () => {
  it("blank: Vt scatter of ~10 mV, shift consistent with zero, extraction never falls back", () => {
    const r = noisyRuns(0, 1);
    const vtB = r.map((x) => x.m.vtBaseline!);
    const d = r.map((x) => x.m.deltaVt_mV!);
    expect(Math.abs(mean(vtB) - 0.3)).toBeLessThan(0.005);
    expect(sd(vtB)).toBeGreaterThan(0.006);
    expect(sd(vtB)).toBeLessThan(0.02);
    expect(Math.abs(mean(d))).toBeLessThan(10);
    expect(sd(d)).toBeLessThan(25);
    expect(r.every((x) => x.m.vtAnalyteMethod === "sqrt_extrapolation" && x.m.vtBaselineMethod === "sqrt_extrapolation")).toBe(true);
    // the panel's noise reading matches the 2 % injected, and the sweep is green
    const noise = r.map((x) => x.q.baselineStability);
    expect(mean(noise)).toBeGreaterThan(1.5);
    expect(mean(noise)).toBeLessThan(2.6);
    expect(r.every((x) => x.q.level === "green")).toBe(true);
    // the noise exported with the measurement is the same on-state scatter, not the whole-curve std/mean (which read ~140 %)
    const exported = r.map((x) => x.m.baselineStabilityNoisePct!);
    expect(mean(exported)).toBeGreaterThan(1.5);
    expect(mean(exported)).toBeLessThan(2.6);
    expect(Math.abs(mean(exported) - mean(noise))).toBeLessThan(0.05);
  });

  it("25 nM and 200 nM: shifts within about 2 % of the true 200 and 356 mV", () => {
    const at25 = noisyRuns(25, 101).map((x) => x.m.deltaVt_mV!);
    const at200 = noisyRuns(200, 201).map((x) => x.m.deltaVt_mV!);
    expect(mean(at25)).toBeGreaterThan(190);
    expect(mean(at25)).toBeLessThan(200);
    expect(mean(at200)).toBeGreaterThan(340);
    expect(mean(at200)).toBeLessThan(356);
  });
});
