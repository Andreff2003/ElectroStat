import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { computeCVMetrics, REVERSE_BASELINE_DISAGREEMENT } from "@/utils/computeCVMetrics";
import { parseImportedCsv } from "@/utils/csvImport";
import { buildCVPointsForTest, DEFAULT_CV_PARAMS, type CVDataPoint } from "@/hooks/useSimulatedCVData";
import { GOLD_SPE_FERRI_FERRO_50MVS, GOLD_SPE_VERTEX_INDEX } from "./fixtures/goldSpeFerriFerro50mVs";

/**
 * The baseline of a leg after a vertex (resolveReverseBaseline). A line fitted to the first 15 % of such a leg and
 * extrapolated to the peak, a few hundred mV away, can under-read the peak or lose it when the leg starts on a
 * steep, curved tail. In "auto" the line between the two ends of the leg is tried too, and used when the usual
 * baseline finds nothing or reads the peak more than 25 % below it, while a trace with no peak in it (noise, a
 * resistor, a capacitor) still gives none. (The missing cathodic peak of the measured CV that starts at 0 V had
 * another cause, the "return" leg: see cvReturnLeg.test.ts.)
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
const gauss = (r: () => number) => (r() + r() + r() + r() - 2) * 1.7;   // about unit sigma

/** The measured CV, with an optional extra decaying tail on the reverse branch (A uA, tau points). */
function measured(tail?: { A: number; tau: number }): CVDataPoint[] {
  return GOLD_SPE_FERRI_FERRO_50MVS.map(([E, I], k) => ({
    E,
    I: I + (tail && k > GOLD_SPE_VERTEX_INDEX ? tail.A * Math.exp(-(k - GOLD_SPE_VERTEX_INDEX - 1) / tail.tau) : 0),
    cycle: 1,
    t: k * 0.1,
    branch: k <= GOLD_SPE_VERTEX_INDEX ? ("forward" as const) : ("reverse" as const),
  }));
}

/** -0.3 -> 0.6 -> -0.3 V at 5 mV, one cycle, with a current function of (E, branch, index after the vertex). */
function cycle(current: (E: number, branch: "forward" | "reverse", j: number) => number): CVDataPoint[] {
  const out: CVDataPoint[] = [];
  let t = 0;
  for (let k = 0; k <= 180; k++) { out.push({ E: -0.3 + 0.005 * k, I: current(-0.3 + 0.005 * k, "forward", k), cycle: 1, t, branch: "forward" }); t += 0.1; }
  for (let k = 1; k <= 180; k++) { out.push({ E: 0.6 - 0.005 * k, I: current(0.6 - 0.005 * k, "reverse", k - 1), cycle: 1, t, branch: "reverse" }); t += 0.1; }
  return out;
}

describe("the measured gold-SPE CV", () => {
  it("is the shape the fixture says", () => {
    expect(GOLD_SPE_FERRI_FERRO_50MVS).toHaveLength(359);
    expect(GOLD_SPE_FERRI_FERRO_50MVS[0][0]).toBeCloseTo(-0.3, 2);
    expect(GOLD_SPE_FERRI_FERRO_50MVS[GOLD_SPE_VERTEX_INDEX][0]).toBeCloseTo(0.6, 2);
    expect(GOLD_SPE_FERRI_FERRO_50MVS[358][0]).toBeCloseTo(-0.3, 2);
  });

  it("both peaks are detected in auto, and D is kept", () => {
    const m = computeCVMetrics(measured(), INPUT)!;
    expect(m.hasAnodic).toBe(true);
    expect(m.hasCathodic).toBe(true);
    expect(m.Epa).toBeGreaterThan(0.27);
    expect(m.Epa).toBeLessThan(0.31);
    expect(m.Epc).toBeGreaterThan(0.03);
    expect(m.Epc).toBeLessThan(0.07);
    expect(m.Ipa).toBeGreaterThan(250);
    expect(m.Ipa).toBeLessThan(330);
    expect(m.Ipc).toBeLessThan(-200);
    expect(m.Ipc).toBeGreaterThan(-300);
    expect(m.deltaEp).toBeGreaterThan(200);
    expect(m.deltaEp).toBeLessThan(260);
    expect(m.IpaIpcRatio).toBeGreaterThan(0.8);
    expect(m.IpaIpcRatio).toBeLessThan(1.25);
    expect(Number.isFinite(m.D_apparent)).toBe(true);
    expect(m.D_status).not.toBe("invalid");
    expect(m.warnings.some((w) => /no clear/.test(w))).toBe(false);
  });

  it("where both baselines agree the usual one is kept (nothing changes for a clean tail)", () => {
    const m = computeCVMetrics(measured(), INPUT)!;
    expect(m.baselineResolvedMethod).toBe("linear-first-15");
    expect(m.warnings.some((w) => /Baseline of a leg after a vertex/.test(w))).toBe(false);
  });
});

describe("a steep tail after the vertex (the measured trace plus a decaying anodic current)", () => {
  const tails = [
    { A: 80, tau: 10 },
    { A: 150, tau: 10 },
    { A: 150, tau: 25 },
    { A: 300, tau: 10 },
    { A: 300, tau: 25 },
  ];

  for (const tail of tails) {
    it(`A=${tail.A} uA, tau=${tail.tau} points: the cathodic peak is found at the right size`, () => {
      const m = computeCVMetrics(measured(tail), INPUT)!;
      expect(m.hasAnodic).toBe(true);
      expect(m.hasCathodic).toBe(true);
      expect(m.Epc).toBeGreaterThan(0.03);
      expect(m.Epc).toBeLessThan(0.08);
      expect(m.Ipc).toBeLessThan(-200);          // the usual baseline gave -45 uA or nothing
      expect(m.Ipc).toBeGreaterThan(-300);
      expect(Number.isFinite(m.D_apparent)).toBe(true);
      expect(m.D_status).not.toBe("invalid");
      expect(m.warnings.some((w) => /Baseline of a leg after a vertex/.test(w))).toBe(true);
      expect(m.baselineResolvedMethod).toBe("mixed");
    });
  }

  it("an explicit baseline is respected: first-15 still loses the peak, which is why auto does not use it here", () => {
    const m = computeCVMetrics(measured({ A: 150, tau: 10 }), { ...INPUT, baselineMethodInput: "linear-first-15" })!;
    expect(m.hasCathodic).toBe(false);
    expect(m.baselineResolvedMethod).toBe("linear-first-15");
    const e = computeCVMetrics(measured({ A: 150, tau: 10 }), { ...INPUT, baselineMethodInput: "linear-edges" })!;
    expect(e.baselineResolvedMethod).toBe("linear-edges");
  });

  it("the corrected trace of the plot uses the same baseline as the metrics", () => {
    const m = computeCVMetrics(measured({ A: 150, tau: 10 }), INPUT)!;
    const rev = m.correctedData!.filter((p) => p.branch === "reverse");
    const lowest = Math.min(...rev.map((p) => p.Icorr as number));
    // the largest excursion of the corrected reverse branch is the reported peak (the peak is on the smoothed trace, so a little less)
    expect(Math.abs(lowest - m.Ipc)).toBeLessThan(0.1 * Math.abs(m.Ipc));
  });

  it("the disagreement threshold is a quarter of the larger peak current", () => {
    expect(REVERSE_BASELINE_DISAGREEMENT).toBe(0.25);
  });
});

describe("what is not a peak is still not one", () => {
  const baselines = ["auto", "none", "linear-first-15", "linear-edges"] as const;

  for (const noise of [0, 0.3, 1.0]) {
    it(`a resistor (1 kOhm, hysteresis, ${noise} uA of noise) has no peaks`, () => {
      const r = rng(11);
      const data = cycle((E, br, j) => (E / 1000) * 1e6 + (br === "reverse" ? 1.5 : 0) + 0.8 * Math.sin(j * 0.9) + noise * gauss(r));
      for (const b of baselines) {
        const m = computeCVMetrics(data, { ...INPUT, cMM: 0, baselineMethodInput: b })!;
        expect(m.hasAnodic, `anodic, baseline ${b}`).toBe(false);
        expect(m.hasCathodic, `cathodic, baseline ${b}`).toBe(false);
        expect(Number.isNaN(m.Ipa) && Number.isNaN(m.Ipc)).toBe(true);
      }
    });
  }

  for (const noise of [0, 0.3, 1.0]) {
    it(`a capacitor rectangle (+-25 uA, charging transient at each vertex, ${noise} uA of noise) has no peaks`, () => {
      const r = rng(5);
      const data = cycle((_E, br, j) => (br === "forward" ? 25 - 50 * Math.exp(-j / 5) : -25 + 50 * Math.exp(-j / 5)) + noise * gauss(r));
      for (const b of baselines) {
        const m = computeCVMetrics(data, { ...INPUT, cMM: 0, baselineMethodInput: b })!;
        expect(m.hasAnodic, `anodic, baseline ${b}`).toBe(false);
        expect(m.hasCathodic, `cathodic, baseline ${b}`).toBe(false);
      }
    });
  }

  it("a flat noisy trace has no peaks", () => {
    const r = rng(3);
    const data = cycle(() => 3 * gauss(r));
    for (const b of baselines) {
      const m = computeCVMetrics(data, { ...INPUT, cMM: 0, baselineMethodInput: b })!;
      expect(m.hasAnodic && m.hasCathodic, `baseline ${b}`).toBe(false);
      expect(m.hasAnodic || m.hasCathodic, `baseline ${b}`).toBe(false);
    }
  });

  it("a curved capacitive plateau with a tail after the vertex has no peaks either", () => {
    const data = cycle((_E, br, j) => (br === "forward" ? 20 : -20) + (br === "reverse" ? 90 * Math.exp(-j / 12) : 0));
    const m = computeCVMetrics(data, { ...INPUT, cMM: 0 })!;
    expect(m.hasAnodic).toBe(false);
    expect(m.hasCathodic).toBe(false);
  });
});

describe("the simulated reversible CV is not changed", () => {
  it("both peaks, the same currents and a 58 mV separation", () => {
    const params = { ...DEFAULT_CV_PARAMS, cvModel: "reversible" as const };
    const m = computeCVMetrics(buildCVPointsForTest(params), { scanRate_mVs: params.scanRate, n: 1, cMM: params.cMM, areaCm2: params.areaCm2 })!;
    expect(m.hasAnodic).toBe(true);
    expect(m.hasCathodic).toBe(true);
    expect(m.Ipa).toBeCloseTo(76.969, 2);
    expect(m.Ipc).toBeCloseTo(-80.568, 2);
    expect(m.Epa).toBeCloseTo(0.248, 3);
    expect(m.Epc).toBeCloseTo(0.19, 3);
    expect(m.deltaEp).toBeCloseTo(58, 0);
    expect(m.baselineResolvedMethod).toBe("linear-first-15");
    expect(m.warnings.some((w) => /Baseline of a leg after a vertex/.test(w))).toBe(false);
  });
});

// The export of the run in question (cv_20261027_121444) was not on the machine this was written on.
// Put the CSV in src/test/fixtures/ under that name and this test reads it.
const EXPORT = new URL("./fixtures/cv_20261027_121444.csv", import.meta.url);
describe.skipIf(!existsSync(EXPORT))("the ElectroStat export cv_20261027_121444", () => {
  it("shows both peaks", () => {
    const parsed = parseImportedCsv(readFileSync(EXPORT, "utf8"), "cv");
    if ("error" in parsed || parsed.mode !== "cv") throw new Error("not a CV export");
    const points = parsed.measurements[0].points as CVDataPoint[];
    const m = computeCVMetrics(points, INPUT)!;
    expect(m.hasAnodic).toBe(true);
    expect(m.hasCathodic).toBe(true);
    expect(m.Ipc).toBeLessThan(-150);
  });
});
