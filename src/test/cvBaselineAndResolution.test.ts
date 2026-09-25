import { describe, it, expect } from "vitest";
import { computeCVMetrics } from "@/utils/computeCVMetrics";
import { simulateReversibleDiffusionCV } from "@/utils/cvDiffusionSolver";
import { computeCVSignalQuality, estimateCVStepMv } from "@/utils/cvSignalQuality";
import { CV_DEFAULT_D_CM2_S } from "@/utils/cvConstants";

/**
 * What baseline correction and the scan step do to the default (noise-free,
 * reversible, 5 mM) voltammogram. Thesis, CV Results.
 */
const A = 0.0707;
const BASE = { eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6, scanRate_mVs: 100, nCycles: 1, n: 1, areaCm2: A, cMM: 5 };
const input = { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: A };
const clean = simulateReversibleDiffusionCV(BASE);

describe("CV baseline correction decides the reversibility verdict", () => {
  it("without it the default trace reads quasi-reversible with D ~39% low; with it, reversible and valid", () => {
    const raw = computeCVMetrics(clean, { ...input, baselineMethodInput: "none" })!;
    const auto = computeCVMetrics(clean, { ...input, baselineMethodInput: "auto" })!;
    expect(raw.IpaIpcRatio).toBeGreaterThan(0.77);
    expect(raw.IpaIpcRatio).toBeLessThan(0.79);
    expect(raw.reversibility).toBe("quasi-reversible");
    expect(Math.abs(raw.D_apparent / CV_DEFAULT_D_CM2_S - 1)).toBeGreaterThan(0.35);
    expect(auto.IpaIpcRatio).toBeGreaterThan(0.95);
    expect(auto.reversibility).toBe("reversible");
    expect(auto.D_status).toBe("valid");
  });

  it("a sloping offset (10% to 25% of the cathodic peak) is removed by the first-15% and auto baselines, not by the edges line", () => {
    const ip = 80.57;
    const drifted = clean.map((p) => ({ ...p, I: p.I + ip * (0.10 + 0.15 * (p.E + 0.2) / 0.8) }));
    const err = (m: "none" | "linear-first-15" | "linear-edges" | "auto") => {
      const r = computeCVMetrics(drifted, { ...input, baselineMethodInput: m })!;
      return { e: (100 * (Math.abs(r.IpcCorrected) - ip)) / ip, used: r.baselineResolvedMethod, cls: r.reversibility };
    };
    expect(err("none").e).toBeLessThan(-15);
    expect(err("none").cls).toBe("quasi-reversible");
    expect(Math.abs(err("linear-first-15").e)).toBeLessThan(0.5);
    expect(Math.abs(err("auto").e)).toBeLessThan(0.5);
    expect(err("auto").used).toBe("linear-first-15");
    expect(err("linear-edges").e).toBeLessThan(-15);
  });
});

describe("CV scan-step resolution criterion on the default trace", () => {
  it("2 mV green, 10 mV yellow, 20 mV red, and at 20 mV the peak separation reads ~80 mV instead of 58", () => {
    const at = (stepMv: number) => {
      const pts = simulateReversibleDiffusionCV({ ...BASE, stepV: stepMv / 1000 });
      const m = computeCVMetrics(pts, input)!;
      return { m, q: computeCVSignalQuality(m, { stepMv: estimateCVStepMv(pts), n: 1 }) };
    };
    expect(at(2).q.resolutionLevel).toBe("green");
    expect(at(10).q.resolutionLevel).toBe("yellow");
    expect(at(20).q.resolutionLevel).toBe("red");
    expect(at(2).m.deltaEp).toBeCloseTo(58, 0);
    expect(at(20).m.deltaEp).toBeGreaterThan(76);
  });
});

describe("CV baseline correction against the same three backgrounds used for SWV", () => {
  const ip = 80.57;
  const u = (E: number) => (E + 0.2) / 0.8;
  const shapes: Record<string, (E: number) => number> = {
    line: (E) => ip * (0.10 + 0.20 * u(E)),
    curved: (E) => ip * 0.40 * (1 - u(E)) ** 2,
    both: (E) => ip * (0.10 + 0.20 * u(E)) + ip * 0.40 * (1 - u(E)) ** 2,
  };
  const run = (shape: string, m: "none" | "linear-first-15" | "linear-edges" | "auto") => {
    const dr = clean.map((p) => ({ ...p, I: p.I + shapes[shape](p.E) }));
    const r = computeCVMetrics(dr, { ...input, baselineMethodInput: m })!;
    return { e: (100 * (Math.abs(r.IpcCorrected) - ip)) / ip, cls: r.reversibility };
  };

  it("a straight background is removed by the first-15% and automatic lines, not by the edges line", () => {
    expect(run("line", "none").e).toBeLessThan(-18);
    expect(Math.abs(run("line", "linear-first-15").e)).toBeLessThan(0.5);
    expect(Math.abs(run("line", "auto").e)).toBeLessThan(0.5);
    expect(run("line", "linear-edges").e).toBeLessThan(-16);
    expect(run("line", "linear-edges").e).toBeGreaterThan(-18);
  });

  it("no CV method removes a curved background: the cathodic peak stays 7-11% low and the verdict moves off reversible", () => {
    for (const shape of ["curved", "both"]) {
      for (const m of ["linear-first-15", "linear-edges", "auto"] as const) {
        const r = run(shape, m);
        expect(r.e).toBeLessThan(-7);
        expect(r.e).toBeGreaterThan(-10);
        expect(r.cls).not.toBe("reversible");
      }
    }
    expect(run("curved", "none").e).toBeLessThan(-9);
    expect(run("both", "none").e).toBeLessThan(-28);
  });
});
