import { describe, it, expect } from "vitest";
import {
  computeCVMetrics,
  PEAK_MIN_PROMINENCE_SIGMA,
  PEAK_MIN_WIDTH_MV,
} from "@/utils/computeCVMetrics";
import { buildCVCalibrationPoint } from "@/utils/cvCalibration";
import { computeCVSignalQuality } from "@/utils/cvSignalQuality";
import { buildCVPointsForTest, DEFAULT_CV_PARAMS, type CVDataPoint } from "@/hooks/useSimulatedCVData";

/**
 * A peak has to stand out from the local baseline by a minimum prominence (5×
 * the point-to-point noise, or a minimum in µA) and be several points wide,
 * before it is reported or used for Ipa/Ipc, ΔEp and the quality verdict. On a
 * dummy cell (1 kOhm + 100 uF) the largest excursion of a flat capacitive
 * plateau with a few µA of ripple used to be reported as "Epc -0.286 V".
 */

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

interface TraceOpts {
  seed?: number;
  ripple?: number;       // ± µA, uniform
  plateau?: number;      // µA, magnitude of the capacitive plateau
  offset?: number;       // µA, constant current offset
  bow?: number;          // µA, the plateau curves away from the baseline by this much at mid-branch (a parabola, toward the peak direction)
  transient?: number;    // µA, RC charging right after each vertex (default 30)
  spike?: { at: number; height: number; points: number }; // on the reverse branch
  peaks?: { ip: number; sigmaV?: number };                 // add a reversible-looking pair
}

/** 0.6 V -> -0.2 V -> 0.6 V at 2 mV, the capacitor plateau flips sign with the scan direction. */
function trace(o: TraceOpts = {}): CVDataPoint[] {
  const r = rng(o.seed ?? 1);
  const plateau = o.plateau ?? 10;
  const ripple = o.ripple ?? 0;
  const offset = o.offset ?? 0;
  const bow = o.bow ?? 0;
  const fwdE: number[] = [];
  for (let k = 0; k <= 400; k++) fwdE.push(+(0.6 - 0.002 * k).toFixed(4));
  const out: CVDataPoint[] = [];
  let t = 0;
  const n = fwdE.length;
  const sigmaV = o.peaks?.sigmaV ?? 0.035;
  const push = (E: number, I: number, branch: "forward" | "reverse") => {
    out.push({ E, I, cycle: 1, t, branch });
    t += 0.02;
  };
  fwdE.forEach((E, k) => {
    const x = (2 * k) / (n - 1) - 1;
    const transient = -(o.transient ?? 30) * Math.exp(-k / 5);   // RC charging after the vertex
    const pk = o.peaks ? -o.peaks.ip * Math.exp(-0.5 * ((E - 0.19) / sigmaV) ** 2) : 0;
    push(E, -plateau + offset - bow * (1 - x * x) + transient + pk + (r() - 0.5) * 2 * ripple, "forward");
  });
  [...fwdE].reverse().forEach((E, k) => {
    const x = (2 * k) / (n - 1) - 1;
    const transient = (o.transient ?? 30) * Math.exp(-k / 5);
    const pk = o.peaks ? o.peaks.ip * Math.exp(-0.5 * ((E - 0.25) / sigmaV) ** 2) : 0;
    let I = plateau + offset + bow * (1 - x * x) + transient + pk + (r() - 0.5) * 2 * ripple;
    if (o.spike && k >= o.spike.at && k < o.spike.at + o.spike.points) I += o.spike.height;
    push(E, I, "reverse");
  });
  return out;
}

const INPUT = { scanRate_mVs: 100, n: 1, cMM: 0, areaCm2: 0.0707 };

describe("CV peak detector: noise and a capacitive plateau are not peaks", () => {
  it("a flat capacitor trace with a constant offset and 3 uA of ripple has no peaks, for 25 noise draws", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const m = computeCVMetrics(trace({ seed, ripple: 3, offset: -2.7 }), INPUT)!;
      expect(m.hasAnodic, `seed ${seed}`).toBe(false);
      expect(m.hasCathodic, `seed ${seed}`).toBe(false);
      // nothing is reported for a peak that was not found
      for (const v of [m.Ipa, m.Ipc, m.IpaCorrected, m.IpcCorrected, m.IpaRaw, m.IpcRaw, m.Epa, m.Epc, m.deltaEp, m.E0prime, m.IpaIpcRatio]) {
        expect(Number.isNaN(v), `seed ${seed}`).toBe(true);
      }
      expect(m.reversibility).toBe("irreversible");
      expect(m.D_status).toBe("invalid");
    }
  });

  it("a plateau that bows by 8 uA (a curved baseline, prominent but as wide as the branch) is not a peak when no baseline is subtracted", () => {
    // A parabola stays above half its height over 71 % of the branch. With the baseline correction on, the line
    // fitted through the branch removes most of such a bow, so this is the case of correction off.
    const m = computeCVMetrics(trace({ seed: 3, ripple: 1.5, bow: 8, transient: 0 }), { ...INPUT, baselineMethodInput: "none" })!;
    // the old rule (height above 3x the noise) reported it
    expect(Math.abs(m.IpaExcursion!)).toBeGreaterThan(3 * m.noise_uA);
    expect(Math.abs(m.IpcExcursion!)).toBeGreaterThan(3 * m.noise_uA);
    expect(m.hasAnodic).toBe(false);
    expect(m.hasCathodic).toBe(false);
    expect(m.warnings.join(" ")).toMatch(/curved baseline/);
  });

  it("a spike of a few points is not a peak", () => {
    const m = computeCVMetrics(trace({ seed: 5, ripple: 1, spike: { at: 150, height: 40, points: 3 } }), INPUT)!;
    expect(m.hasAnodic).toBe(false);
    expect(m.warnings.join(" ")).toMatch(new RegExp(`below .* ${PEAK_MIN_WIDTH_MV} mV`));
  });

  it("the verdict is red: both peaks missing, and nothing in the metrics grid to read", () => {
    const m = computeCVMetrics(trace({ seed: 7, ripple: 3, offset: -2.7 }), INPUT)!;
    const q = computeCVSignalQuality(m, { stepMv: 2, n: 1 });
    expect(q.peakLevel).toBe("red");
    expect(q.level).toBe("red");
  });
});

describe("CV peak detector: real peaks are still found", () => {
  it("the simulated ferri/ferrocyanide CV has two peaks, with the usual values", () => {
    const pts = buildCVPointsForTest({ ...DEFAULT_CV_PARAMS, cvModel: "reversible" as const });
    const m = computeCVMetrics(pts, { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 })!;
    expect(m.hasAnodic).toBe(true);
    expect(m.hasCathodic).toBe(true);
    expect(m.deltaEp).toBeGreaterThan(54);
    expect(m.deltaEp).toBeLessThan(62);
    expect(m.IpaIpcRatio).toBeGreaterThan(0.9);
    expect(m.IpaIpcRatio).toBeLessThan(1.05);
    expect(Math.abs(m.Ipc) / 80.92).toBeGreaterThan(0.99);
    expect(m.reversibility).toBe("reversible");
  });

  it("a pair of peaks on the capacitive plateau, with noise, is found, and the numbers are reported", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const m = computeCVMetrics(trace({ seed, ripple: 0.5, offset: -2.7, peaks: { ip: 40 } }), INPUT)!;
      expect(m.hasAnodic && m.hasCathodic, `seed ${seed}`).toBe(true);
      expect(Math.abs(m.Epc - 0.19)).toBeLessThan(0.01);
      expect(Math.abs(m.Epa - 0.25)).toBeLessThan(0.01);
      expect(Number.isFinite(m.deltaEp)).toBe(true);
    }
  });

  it("a small peak of 6 uA over 0.4 uA of noise (SNR about 25) is still found", () => {
    const m = computeCVMetrics(trace({ seed: 2, ripple: 0.4, peaks: { ip: 6 } }), INPUT)!;
    expect(m.hasAnodic).toBe(true);
    expect(m.hasCathodic).toBe(true);
  });

  it("the minimum prominence in uA is configurable", () => {
    const small = trace({ seed: 4, ripple: 0.05, peaks: { ip: 3 } });
    expect(computeCVMetrics(small, INPUT)!.hasCathodic).toBe(true);
    const strict = computeCVMetrics(small, { ...INPUT, minPeakProminence_uA: 5 })!;
    expect(strict.hasAnodic).toBe(false);
    expect(strict.hasCathodic).toBe(false);
    expect(strict.warnings.join(" ")).toMatch(/prominence/);
  });

  it(`the rule is ${PEAK_MIN_PROMINENCE_SIGMA}x the noise: a peak of 4 sigma is not found, one of 12 sigma is`, () => {
    // uniform ripple of +-r has sigma r/sqrt(3); the point-to-point estimate recovers it
    const r = 3;
    const sigma = r / Math.sqrt(3);
    expect(computeCVMetrics(trace({ seed: 8, ripple: r, peaks: { ip: 4 * sigma } }), INPUT)!.hasCathodic).toBe(false);
    expect(computeCVMetrics(trace({ seed: 8, ripple: r, peaks: { ip: 12 * sigma } }), INPUT)!.hasCathodic).toBe(true);
  });
});

describe("the calibration still reads a blank", () => {
  it("a blank with no peak keeps a reading (its largest excursion), so there are blanks to estimate the noise from", () => {
    const m = computeCVMetrics(trace({ seed: 9, ripple: 0.5 }), INPUT)!;
    expect(m.hasAnodic).toBe(false);
    expect(Number.isNaN(m.IpaCorrected)).toBe(true);
    const p = buildCVCalibrationPoint(0, m, "reversible");
    expect(p.responseMean_uA).not.toBeNull();
    expect(Number.isFinite(p.responseMean_uA!)).toBe(true);
  });
});
