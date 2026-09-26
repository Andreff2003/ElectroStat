import { describe, it, expect } from "vitest";
import { computeFETTransferMetrics } from "@/utils/fetMetrics";
import { computeFETVtDetailed } from "@/utils/fetVt";
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

  it("the error in the shift grows with the noise: ~16 mV at the simulator default, ~28 mV at the green limit, ~70 mV at the yellow/red limit", () => {
    const e2 = level(2).err, e5 = level(5).err, e15 = level(15).err;
    expect(e2).toBeGreaterThan(8);
    expect(e2).toBeLessThan(25);
    expect(e5).toBeGreaterThan(15);
    expect(e5).toBeLessThan(45);
    expect(e15).toBeGreaterThan(55);
    expect(e2).toBeLessThan(e5);
    expect(e5).toBeLessThan(e15);
  });

  it("the sqrt extraction holds up to 10 % noise, then the fallback takes over and is used in every sweep from 30 %", () => {
    expect(level(10).fallbacks).toBe(0);
    expect(level(15).fallbacks).toBeGreaterThan(0);
    expect(level(20).fallbacks).toBeGreaterThan(level(15).fallbacks);
    expect(level(30).fallbacks).toBe(15);
  });

  it("both curves of a measurement are always read the same way, so the error levels off at the fallback's own bias instead of peaking", () => {
    const perLevel = (pct: number) => {
      const err: number[] = [], signed: number[] = []; let mixed = 0;
      for (let s = 1; s <= 15; s++) {
        const p = fetPair(25, Math.round(pct * 100) * 100 + s, { rel: pct / 100 });
        const m = computeFETTransferMetrics(p.baseline, p.analyte);
        if (m.vtAnalyteMethod !== m.vtBaselineMethod) mixed++;
        err.push(Math.abs(m.deltaVt_mV! - trueShift_mV(25))); signed.push(m.deltaVt_mV! - trueShift_mV(25));
      }
      return { mixed, err: mean(err), signed: mean(signed) };
    };
    const lv = [10, 15, 20, 30, 50].map(perLevel);
    expect(lv.every((x) => x.mixed === 0)).toBe(true);
    // 15 % -> 50 %: bounded between ~65 and ~110 mV (the fallback reads a third low), no peak above 150 mV
    for (const x of lv.slice(1)) { expect(x.err).toBeGreaterThan(55); expect(x.err).toBeLessThan(110); }
    // once every sweep uses the fallback the shift reads low by about a third of 200 mV
    expect(lv[3].signed).toBeLessThan(-55);
    expect(lv[3].signed).toBeGreaterThan(-90);
  });

  it("the constant-current method is biased low but far less sensitive to noise than the square-root fit", () => {
    const errOf = (pct: number, forced: "sqrt" | "fallback") => {
      const e: number[] = [];
      for (let s = 1; s <= 15; s++) {
        const p = fetPair(25, Math.round(pct * 100) * 100 + s, { rel: pct / 100 });
        const o = forced === "sqrt" ? { minR2: -1e9, minPoints: 2 } : { forceFallback: true };
        e.push(Math.abs((computeFETVtDetailed(p.analyte, o).vt! - computeFETVtDetailed(p.baseline, o).vt!) * 1000 - trueShift_mV(25)));
      }
      return mean(e);
    };
    for (const pct of [10, 20, 30, 50]) {
      expect(errOf(pct, "fallback")).toBeGreaterThan(50); // the bias: about a third of 200 mV
      expect(errOf(pct, "fallback")).toBeLessThan(120);
    }
    // the sqrt fit, forced on every sweep, grows without bound with the noise
    expect(errOf(50, "sqrt")).toBeGreaterThan(5 * errOf(50, "fallback"));
  });
});
