import { describe, it, expect } from "vitest";
import { analyzeSWV } from "@/utils/swvMetrics";
import { simulateReversibleDiffusionSWV } from "@/utils/swvDiffusionSolver";
import { estimateCVStepMv } from "@/utils/cvSignalQuality";
import type { SWVParameters } from "@/types/swv";

/**
 * The SWV analogue of the CV checks: expected-vs-recovered values for the
 * default reversible probe (thesis Table 12) and the scan-step resolution
 * criterion (points across the half-peak width: >=10 green, >=5 yellow).
 * SWV peaks are ~100 mV wide at half height (CV pairs span 59 mV), so a
 * coarser step is needed before the resolution degrades.
 */
const P = {
  startE: -0.2, endE: 0.6, step_mV: 2, amplitude_mV: 25, frequency_Hz: 25,
  quietTime_s: 2, direction: "anodic", area_cm2: 0.0707, nElectrons: 1, cMM: 5,
} as SWVParameters;
const peak = (p: Partial<SWVParameters>) =>
  analyzeSWV(simulateReversibleDiffusionSWV({ ...P, ...p }), "auto").metrics;

describe("SWV: expected vs recovered on the default reversible probe", () => {
  it("peak at E0' within the 2 mV step, current x10 for 10x concentration, x2 for 4x frequency", () => {
    expect(Math.abs(peak({}).peakPotential_V! - 0.22)).toBeLessThanOrEqual(0.002);
    const c1 = peak({ cMM: 1 }).peakCurrentCorrected_uA!;
    const c10 = peak({ cMM: 10 }).peakCurrentCorrected_uA!;
    expect(c10 / c1).toBeCloseTo(10, 3);
    const f25 = peak({ frequency_Hz: 25 }).peakCurrentCorrected_uA!;
    const f100 = peak({ frequency_Hz: 100 }).peakCurrentCorrected_uA!;
    expect(f100 / f25).toBeGreaterThan(1.998);
    expect(f100 / f25).toBeLessThan(2.004);
  });
});

describe("SWV scan-step resolution criterion", () => {
  const grade = (stepMv: number) => {
    const d = simulateReversibleDiffusionSWV({ ...P, step_mV: stepMv });
    const m = analyzeSWV(d, "auto").metrics;
    const pts = (m.halfPeakWidth_mV ?? 0) / estimateCVStepMv(d)!;
    return { level: pts >= 10 ? "green" : pts >= 5 ? "yellow" : "red", ep: m.peakPotential_V! };
  };
  it("2 mV green, 20 mV yellow, 50 mV red, and at 50 mV the peak sits 30 mV from E0'", () => {
    expect(grade(2).level).toBe("green");
    expect(grade(20).level).toBe("yellow");
    expect(grade(50).level).toBe("red");
    expect(Math.abs(grade(50).ep - 0.22)).toBeGreaterThan(0.028);
  });
});
