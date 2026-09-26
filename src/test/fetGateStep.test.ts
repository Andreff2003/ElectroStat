import { describe, it, expect } from "vitest";
import { computeFETTransferMetrics } from "@/utils/fetMetrics";
import { computeFETMetrics } from "@/components/SignalQuality";
import { computeFETQuality } from "@/utils/fetQuality";
import { fetPair, mean, sd } from "./fetSimHelper";

/**
 * Gate-sweep step (1-200 mV on the panel; the default 40 mV is 51 points across
 * -0.5 to 1.5 V). The step sets how many points fall in the 20-80 % window the
 * Vt line is fitted to, and with fewer than four the extraction falls back to
 * the constant-current method. The panel grades it through the number of points in that window.
 * 25 nM sweep (true shift 200 mV), 15 sweeps per step. Thesis, BioFET Results.
 */
function atPoints(points: number, runs = 15) {
  const d: number[] = [], levels: string[] = [];
  let fallbacks = 0;
  for (let s = 0; s < runs; s++) {
    const p = fetPair(25, 700 + s, { points });
    const m = computeFETTransferMetrics(p.baseline, p.analyte);
    d.push(m.deltaVt_mV!);
    levels.push(computeFETMetrics(p.analyte, p.baseline).level);
    if (m.vtAnalyteMethod !== "sqrt_extrapolation" || m.vtBaselineMethod !== "sqrt_extrapolation") fallbacks++;
  }
  return { d, sd: sd(d), mean: mean(d), fallbacks, levels };
}

describe("BioFET gate-sweep step", () => {
  it("the scatter of the shift grows with the step: ~5 mV at 10 mV, ~15 mV at the default 40 mV, ~30 mV at 80 mV, never falling back", () => {
    const s10 = atPoints(201), s40 = atPoints(51), s80 = atPoints(26);
    expect(s10.sd).toBeLessThan(s40.sd);
    expect(s40.sd).toBeLessThan(s80.sd);
    expect(s40.sd).toBeGreaterThan(10);
    expect(s40.sd).toBeLessThan(20);
    expect([s10, s40, s80].every((x) => x.fallbacks === 0)).toBe(true);
    for (const x of [s10, s40, s80]) expect(Math.abs(x.mean - 200)).toBeLessThan(10);
  });

  it("the panel grades the step through the points in the Vt window: green up to 40 mV, yellow at 80 mV (4-5 points)", () => {
    const win = (points: number) => Array.from({ length: 15 }, (_, s) => {
      const p = fetPair(25, 700 + s, { points }); return computeFETQuality(p.analyte, p.baseline);
    });
    for (const pts of [201, 101, 51]) expect(win(pts).every((q) => q.windowLevel === "green" && q.level === "green")).toBe(true);
    expect(win(51).every((q) => q.windowPoints >= 6)).toBe(true); // the default 40 mV puts ~10 points in the window
    const at80 = win(26);
    expect(at80.every((q) => q.windowPoints >= 4 && q.windowPoints < 6)).toBe(true);
    expect(at80.every((q) => q.windowLevel === "yellow" && q.level === "yellow")).toBe(true);
  });

  it("at 100 mV (3 to 5 points in the window) the scatter grows to ~37 mV, the sweeps with fewer than 4 points fall back, and the panel warns (yellow, red where it falls back)", () => {
    const s = atPoints(21);
    expect(s.sd).toBeGreaterThan(30);
    expect(s.sd).toBeLessThan(50);
    expect(s.sd).toBeGreaterThan(atPoints(26).sd);
    expect(s.fallbacks).toBeGreaterThan(0);
    expect(s.fallbacks).toBeLessThan(15);
    expect(s.levels.every((l) => l !== "green")).toBe(true);
    expect(s.levels.filter((l) => l === "red").length).toBe(s.fallbacks);
  });

  it("at 200 mV (2 points) every sweep falls back, also without noise, the shift reads about a third low, and the panel is red every time", () => {
    const s = atPoints(11);
    expect(s.fallbacks).toBe(15);
    expect(s.mean).toBeGreaterThan(110);
    expect(s.mean).toBeLessThan(160);
    const nf = fetPair(25, 1, { points: 11, noise: false });
    const m = computeFETTransferMetrics(nf.baseline, nf.analyte);
    expect(m.vtAnalyteMethod).toBe("constant_current_fallback");
    expect(m.deltaVt_mV!).toBeLessThan(150);
    expect(s.levels.every((l) => l === "red")).toBe(true);
  });
});
