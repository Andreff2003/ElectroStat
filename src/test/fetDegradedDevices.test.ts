import { describe, it, expect } from "vitest";
import { computeFETMetrics } from "@/components/SignalQuality";
import { fetPair, mean } from "./fetSimHelper";

/**
 * BioFET quality panel on simulated transistors that are deliberately worse
 * than the default: a wider transition (higher ideality factor, hence a larger
 * subthreshold slope) and a constant leakage current. Thesis Table 17.
 */
const panel = (o: { n?: number; leak?: number }, seed = 3) => {
  const p = fetPair(25, seed, o);
  return computeFETMetrics(p.analyte, p.baseline);
};
const theorySS = (n: number) => Math.log(10) * n * 25.85; // mV/dec, kT/q = 25.85 mV

describe("BioFET quality panel on degraded simulated devices", () => {
  it("the default device is green on every criterion", () => {
    const q = panel({});
    expect([q.ionLevel, q.ssLevel, q.ioffLevel, q.stabilityLevel, q.level]).toEqual(["green", "green", "green", "green", "green"]);
  });

  it("a very wide transition (n = 8, ~476 mV/dec) is caught by the slope alone", () => {
    const q = panel({ n: 8 });
    expect(q.ssLevel).not.toBe("green");
    expect(q.ionLevel).toBe("green");
    expect(q.ioffLevel).toBe("green");
    expect(q.level).toBe("yellow");
  });

  it("2 uA of leakage turns Ion/Ioff red and Ioff yellow, 8 uA turns all of them red", () => {
    const a = panel({ leak: 2 });
    expect([a.ionLevel, a.ioffLevel, a.level]).toEqual(["red", "yellow", "red"]);
    const b = panel({ leak: 8 });
    expect([b.ionLevel, b.ioffLevel, b.ssLevel, b.level]).toEqual(["red", "red", "red", "red"]);
    // the noise criterion is about scatter, so it does not react to a constant offset
    expect(a.stabilityLevel).toBe("green");
    expect(b.stabilityLevel).toBe("green");
  });
});

describe("BioFET subthreshold slope: what the panel reads against ln(10) n kT/q", () => {
  it("noise-free, it follows theory (within 2 % up to n = 4, 6 % up to n = 8)", () => {
    for (const [n, tol] of [[1.5, 0.02], [2, 0.02], [3, 0.02], [4, 0.02], [6, 0.06], [8, 0.06]] as const) {
      const p = fetPair(25, 3, { n, noise: false });
      const ss = computeFETMetrics(p.analyte, p.baseline).subthresholdSlope;
      expect(Math.abs(ss / theorySS(n) - 1)).toBeLessThan(tol);
    }
  });

  it("with the simulator's noise floor it reads low, increasingly so for wide transitions", () => {
    const noisy = (n: number) =>
      mean(Array.from({ length: 10 }, (_, s) => panel({ n }, 50 + s).subthresholdSlope));
    // n = 4: theory 238 mV/dec (yellow), the panel reads ~140 (green)
    expect(noisy(4)).toBeLessThan(0.75 * theorySS(4));
    expect(noisy(6)).toBeLessThan(0.8 * theorySS(6));
    expect(noisy(8)).toBeLessThan(theorySS(8));
    // and around n = 2 it is within about 15 % of theory
    expect(Math.abs(noisy(2) / theorySS(2) - 1)).toBeLessThan(0.2);
  });

  it("the noise floor is the cause: without the 0.005 uA floor the panel reads n = 2 and 4 within 5 % of theory", () => {
    for (const n of [2, 4]) {
      const v = Array.from({ length: 10 }, (_, s) => {
        const p = fetPair(25, 50 + s, { n, abs: 0 });
        return computeFETMetrics(p.analyte, p.baseline).subthresholdSlope;
      });
      expect(Math.abs(mean(v) / theorySS(n) - 1)).toBeLessThan(0.05);
    }
  });

  it("so a device with n = 4 (theory 238 mV/dec, yellow) is graded green on slope in most sweeps", () => {
    const levels = Array.from({ length: 10 }, (_, s) => panel({ n: 4 }, 50 + s).ssLevel);
    expect(levels.filter((l) => l === "green").length).toBeGreaterThanOrEqual(7);
  });

  it("over 30 sweeps the grades are stable except for the wide transition, whose slope sits around the 400 mV/dec limit", () => {
    const grades = (o: { n?: number; leak?: number }) =>
      Array.from({ length: 30 }, (_, s) => panel(o, 100 + s));
    expect(grades({}).every((q) => q.level === "green")).toBe(true);
    expect(grades({ leak: 2 }).every((q) => q.level === "red")).toBe(true);
    expect(grades({ leak: 8 }).every((q) => q.level === "red")).toBe(true);
    const wide = grades({ n: 8 }).map((q) => q.ssLevel);
    expect(wide.filter((l) => l === "green").length).toBe(0);
    expect(wide.filter((l) => l === "yellow").length).toBeGreaterThan(10);
    expect(wide.filter((l) => l === "red").length).toBeGreaterThan(5);
  });
});
