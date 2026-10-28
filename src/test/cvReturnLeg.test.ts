import { describe, it, expect } from "vitest";
import { computeCVMetrics, splitLegs } from "@/utils/computeCVMetrics";
import { buildCVPointsForTest, DEFAULT_CV_PARAMS, type CVDataPoint } from "@/hooks/useSimulatedCVData";
import { GOLD_SPE_CV_FROM_0V, GOLD_SPE_CV_LEG_ENDS } from "./fixtures/goldSpeCvFrom0V";

/**
 * The firmware returns a CV to its start potential, so a CV that starts between its vertices has three legs
 * (forward, reverse, return). computeCVMetrics used to look at "forward" and "reverse" only. On a gold-SPE CV that
 * goes 0 -> -0.3 -> 0.6 -> 0 V at 50 mV/s the cathodic peak lies on the way back, on the "return" leg, so the app
 * reported "no clear cathodic peak" (the only cathodic leg it looked at, 0 to -0.3 V, is past the peak, with
 * 1 uA of ripple) and dropped D. The legs are now found from the sign of dE/dt, whatever the branch names say.
 */

const INPUT = { scanRate_mVs: 50, n: 1, cMM: 2.5, areaCm2: 0.0707 };

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
const gauss = (r: () => number) => (r() + r() + r() + r() - 2) * 1.7;

type Tag = "forward" | "reverse" | "return";
const measured = (tagged: boolean): CVDataPoint[] =>
  GOLD_SPE_CV_FROM_0V.map(([E, I], k) => ({
    E, I, cycle: 1, t: k * 0.1,
    ...(tagged ? { branch: (k <= GOLD_SPE_CV_LEG_ENDS[0] ? "forward" : k <= GOLD_SPE_CV_LEG_ENDS[1] ? "reverse" : "return") as Tag } : {}),
  })) as CVDataPoint[];

/** The simulated CV (0.6 -> -0.3 -> 0.6 V), rotated to start at 0 V: the same voltammogram of a CV that starts between its vertices. */
function simulatedFrom0V(model: "reversible" | "quasi-reversible", tagged = true): CVDataPoint[] {
  const sim = buildCVPointsForTest({
    ...DEFAULT_CV_PARAMS, cvModel: model, eStart: 0.6, eVertex1: -0.3, eVertex2: 0.6, scanRate: 50, cMM: 2.5,
  });
  const vertexLow = sim.reduce((best, p, i) => (p.E < sim[best].E ? i : best), 0);
  const first = sim.findIndex((p) => p.E <= 0);                       // where the way down crosses 0 V
  const back = sim.findIndex((p, i) => i > vertexLow && p.E >= 0.6 - 1e-9);   // the end of the way up
  const rotated = [...sim.slice(first, vertexLow + 1), ...sim.slice(vertexLow + 1, back + 1), ...sim.slice(1, first)];
  const n1 = vertexLow + 1 - first;
  const n2 = back - vertexLow;
  return rotated.map((p, k) => ({
    ...p, cycle: 1, t: k * 0.1,
    ...(tagged ? { branch: (k < n1 ? "forward" : k < n1 + n2 ? "reverse" : "return") as Tag } : { branch: undefined }),
  })) as CVDataPoint[];
}

/** 0 -> -0.3 -> 0.6 -> 0 V at 5 mV with a current function of (E, leg, index in the leg). */
function threeLegs(current: (E: number, leg: 1 | 2 | 3, j: number) => number): CVDataPoint[] {
  const out: CVDataPoint[] = [];
  let t = 0;
  const push = (E: number, leg: 1 | 2 | 3, j: number) => {
    out.push({ E, I: current(E, leg, j), cycle: 1, t, branch: leg === 1 ? "forward" : leg === 2 ? "reverse" : "return" });
    t += 0.1;
  };
  for (let k = 0; k <= 60; k++) push(-0.005 * k, 1, k);
  for (let k = 1; k <= 180; k++) push(-0.3 + 0.005 * k, 2, k - 1);
  for (let k = 1; k <= 120; k++) push(0.6 - 0.005 * k, 3, k - 1);
  return out;
}

describe("legs from the sign of dE/dt", () => {
  it("the measured CV has three legs of 61, 179 and 118 points, tagged or not", () => {
    expect(splitLegs(measured(true)).map((l) => l.length)).toEqual([61, 179, 118]);
    expect(splitLegs(measured(false)).map((l) => l.length)).toEqual([61, 179, 118]);
  });

  it("a CV that starts at a vertex has two legs, as before", () => {
    const sim = buildCVPointsForTest({ ...DEFAULT_CV_PARAMS, cvModel: "reversible" });
    expect(splitLegs(sim)).toHaveLength(2);
  });

  it("a few points around a vertex are not a leg", () => {
    const pts: CVDataPoint[] = [];
    for (let k = 0; k < 30; k++) pts.push({ E: 0.005 * k, I: k, cycle: 1, t: k });
    for (let k = 1; k <= 2; k++) pts.push({ E: 0.145 - 0.005 * k, I: 0, cycle: 1, t: 30 + k });
    expect(splitLegs(pts)).toHaveLength(1);
  });
});

describe("the measured CV that starts at 0 V", () => {
  for (const tagged of [true, false]) {
    it(`${tagged ? "with" : "without"} branch tags: both peaks, the cathodic one on the return leg, and D is kept`, () => {
      const m = computeCVMetrics(measured(tagged), INPUT)!;
      expect(m.hasAnodic).toBe(true);
      expect(m.hasCathodic).toBe(true);
      expect(m.Epa).toBeGreaterThan(0.27);
      expect(m.Epa).toBeLessThan(0.31);
      expect(m.Epc).toBeGreaterThan(0.03);
      expect(m.Epc).toBeLessThan(0.07);
      expect(m.Ipa).toBeGreaterThan(200);
      expect(m.Ipa).toBeLessThan(330);
      expect(m.Ipc).toBeLessThan(-200);
      expect(m.Ipc).toBeGreaterThan(-300);
      expect(m.deltaEp).toBeGreaterThan(200);
      expect(m.deltaEp).toBeLessThan(260);
      expect(Number.isFinite(m.D_apparent)).toBe(true);
      expect(m.D_status).not.toBe("invalid");
      expect(m.warnings.some((w) => /cathodic peak is on leg 3/.test(w))).toBe(true);
      expect(m.warnings.some((w) => /no clear/.test(w))).toBe(false);
    });
  }

  it("the corrected trace has a baseline on every point, the return leg included", () => {
    const m = computeCVMetrics(measured(true), INPUT)!;
    expect(m.correctedDataCoversAllCycles).toBe(true);
    expect(m.correctedData).toHaveLength(GOLD_SPE_CV_FROM_0V.length);
    expect(m.correctedData!.every((p) => Number.isFinite(p.baseline))).toBe(true);
  });

  it("the first-15 baseline chosen by hand finds the same cathodic peak on the return leg", () => {
    const m = computeCVMetrics(measured(true), { ...INPUT, baselineMethodInput: "linear-first-15" })!;
    expect(m.hasCathodic).toBe(true);
    expect(m.Ipc).toBeLessThan(-200);
  });
});

describe("a simulated CV that starts between its vertices", () => {
  for (const model of ["reversible", "quasi-reversible"] as const) {
    for (const tagged of [true, false]) {
      it(`${model}, ${tagged ? "tagged" : "untagged"}: three legs, both peaks`, () => {
        const data = simulatedFrom0V(model, tagged);
        expect(splitLegs(data)).toHaveLength(3);
        const m = computeCVMetrics(data, { scanRate_mVs: 50, n: 1, cMM: 2.5, areaCm2: DEFAULT_CV_PARAMS.areaCm2 })!;
        expect(m.hasAnodic).toBe(true);
        expect(m.hasCathodic).toBe(true);
        expect(m.Epa).toBeGreaterThan(0.22);
        expect(m.Epa).toBeLessThan(0.30);
        expect(m.Epc).toBeGreaterThan(0.15);
        expect(m.Epc).toBeLessThan(0.21);
        expect(m.deltaEp).toBeGreaterThan(40);
        expect(m.deltaEp).toBeLessThan(110);
        expect(m.D_status).not.toBe("invalid");
      });
    }
  }
});

describe("a simulated CV that starts at a vertex is not changed", () => {
  it("the same peaks as before, and no leg-3 warning", () => {
    const params = { ...DEFAULT_CV_PARAMS, cvModel: "reversible" as const, scanRate: 50, cMM: 2.5 };
    const m = computeCVMetrics(buildCVPointsForTest(params), { scanRate_mVs: 50, n: 1, cMM: 2.5, areaCm2: params.areaCm2 })!;
    expect(m.hasAnodic && m.hasCathodic).toBe(true);
    expect(m.Epa).toBeCloseTo(0.248, 3);
    expect(m.Epc).toBeCloseTo(0.19, 3);
    expect(m.deltaEp).toBeCloseTo(58, 0);
    expect(m.warnings.some((w) => /leg 3/.test(w))).toBe(false);
  });
});

describe("three legs and no peaks", () => {
  const baselines = ["auto", "none", "linear-first-15", "linear-edges"] as const;
  const noPeaks = (data: CVDataPoint[]) => {
    for (const b of baselines) {
      const m = computeCVMetrics(data, { ...INPUT, cMM: 0, baselineMethodInput: b })!;
      expect(m.hasAnodic, `anodic, baseline ${b}`).toBe(false);
      expect(m.hasCathodic, `cathodic, baseline ${b}`).toBe(false);
    }
  };

  for (const noise of [0, 0.3, 1]) {
    it(`a resistor (1 kOhm, ${noise} uA of noise)`, () => {
      const r = rng(21);
      noPeaks(threeLegs((E, leg, j) => (E / 1000) * 1e6 + (leg === 2 ? 1.2 : 0) + 0.7 * Math.sin(j * 0.8) + noise * gauss(r)));
    });
    it(`a capacitor rectangle (+-25 uA, charging transient at each vertex, ${noise} uA of noise)`, () => {
      const r = rng(8);
      noPeaks(threeLegs((_E, leg, j) => {
        const sign = leg === 2 ? 1 : -1;
        return sign * (25 - 50 * Math.exp(-j / 5)) + noise * gauss(r);
      }));
    });
  }

  it("flat noise", () => {
    const r = rng(4);
    noPeaks(threeLegs(() => 3 * gauss(r)));
  });
});
