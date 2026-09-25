import { describe, it, expect } from "vitest";
import { analyzeSWV, normalizeSWVBaselineMethod } from "@/utils/swvMetrics";
import { simulateReversibleDiffusionSWV } from "@/utils/swvDiffusionSolver";
import type { SWVParameters } from "@/types/swv";

/**
 * The SWV solvers contain neither charging current nor drift, so baseline
 * correction is only exercised when a known drift is added by hand. Thesis Table 13.
 */
const P = {
  startE: -0.2, endE: 0.6, step_mV: 2, amplitude_mV: 25, frequency_Hz: 25,
  quietTime_s: 2, direction: "anodic", area_cm2: 0.0707, nElectrons: 1, cMM: 5,
} as SWVParameters;

const clean = simulateReversibleDiffusionSWV(P);
const Ip = Math.abs(analyzeSWV(clean, "none").metrics.peakCurrentCorrected_uA!);
const u = (E: number) => (E + 0.2) / 0.8;
const drifts: Record<string, (E: number) => number> = {
  line: (E) => Ip * (0.10 + 0.20 * u(E)),
  curved: (E) => Ip * 0.40 * (1 - u(E)) ** 2,
  both: (E) => Ip * (0.10 + 0.20 * u(E)) + Ip * 0.40 * (1 - u(E)) ** 2,
};

function errPct(drift: (E: number) => number, method: "none" | "linear_edges" | "quadratic" | "auto") {
  const drifted = clean.map((p) => ({ ...p, INet: p.INet + drift(p.E) }));
  const m = analyzeSWV(drifted, method).metrics;
  return { err: (100 * (Math.abs(m.peakCurrentCorrected_uA!) - Ip)) / Ip, used: m.baselineMethodUsed };
}

describe("SWV baseline correction against a known added drift", () => {
  it("without correction the drift inflates the peak by roughly 9 to 30 %", () => {
    expect(errPct(drifts.line, "none").err).toBeGreaterThan(15);
    expect(errPct(drifts.curved, "none").err).toBeGreaterThan(5);
    expect(errPct(drifts.both, "none").err).toBeGreaterThan(20);
  });

  it("a straight-line baseline removes a linear drift but not a curved one", () => {
    expect(Math.abs(errPct(drifts.line, "linear_edges").err)).toBeLessThan(0.5);
    expect(Math.abs(errPct(drifts.curved, "linear_edges").err)).toBeGreaterThan(5);
    expect(Math.abs(errPct(drifts.both, "linear_edges").err)).toBeGreaterThan(5);
  });

  it("the quadratic baseline, and the automatic choice, recover the peak within 0.2 % for all three", () => {
    for (const d of Object.values(drifts)) {
      expect(Math.abs(errPct(d, "quadratic").err)).toBeLessThan(0.2);
      const auto = errPct(d, "auto");
      expect(Math.abs(auto.err)).toBeLessThan(0.2);
      expect(auto.used).toBe("quadratic");
    }
  });
});

describe("SWV baseline method ids", () => {
  it("still accepts the old \"polynomial\" id as the quadratic baseline", () => {
    expect(normalizeSWVBaselineMethod("polynomial")).toBe("quadratic");
    const drifted = clean.map((p) => ({ ...p, INet: p.INet + drifts.curved(p.E) }));
    const legacy = analyzeSWV(drifted, "polynomial" as never).metrics;
    const current = analyzeSWV(drifted, "quadratic").metrics;
    expect(legacy.baselineMethodUsed).toBe("quadratic");
    expect(legacy.peakCurrentCorrected_uA).toBe(current.peakCurrentCorrected_uA);
  });
});
