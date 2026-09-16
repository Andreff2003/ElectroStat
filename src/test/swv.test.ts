import { describe, expect, it } from "vitest";
import {
  analyzeSWV,
  computeINet,
  correctBaseline,
  detectSWVPeak,
  generateSWVProgram,
  validateSWVParameters,
} from "@/utils/swvMetrics";
import type { SWVDataPoint, SWVParameters } from "@/types/swv";
import {
  fitLinearSWV,
  computeLODSWV,
  type CalibrationPoint,
} from "@/components/CalibrationPanel";

const baseParams: SWVParameters = {
  startE: -0.2,
  endE: 0.6,
  step_mV: 4,
  amplitude_mV: 25,
  frequency_Hz: 25,
  quietTime_s: 1,
  direction: "anodic",
  baselineMethod: "auto",
};

function makeGaussianData(sign = 1, noise = 0.005): SWVDataPoint[] {
  const prog = generateSWVProgram({ ...baseParams, step_mV: 4 });
  const Ep = 0.22, sigma = 0.04, Ipk = 1.0 * sign;
  return prog.map((s) => {
    const iNet = Ipk * Math.exp(-0.5 * ((s.E - Ep) / sigma) ** 2)
      + 0.02 + 0.05 * s.E // baseline
      + (Math.random() - 0.5) * noise;
    const iFwd = 0.1 + 0.5 * iNet;
    const iRev = 0.1 - 0.5 * iNet;
    return {
      E: s.E,
      IForward: iFwd,
      IReverse: iRev,
      INet: iFwd - iRev,
      time: s.time,
      index: s.index,
      direction: s.direction,
    };
  });
}

describe("SWV — potential program", () => {
  it("generates expected number of steps", () => {
    const p = generateSWVProgram({ ...baseParams, step_mV: 10 }); // 0.8 V / 0.01 = 80 → 81 pts
    expect(p.length).toBe(81);
    expect(p[0].E).toBeCloseTo(-0.2, 6);
    expect(p[p.length - 1].E).toBeCloseTo(0.6, 6);
  });
  it("supports cathodic sweep (endE < startE)", () => {
    const p = generateSWVProgram({ ...baseParams, startE: 0.5, endE: -0.1, direction: "cathodic" });
    expect(p[0].E).toBe(0.5);
    expect(p[p.length - 1].E).toBeLessThan(0);
  });
});

describe("SWV — INet", () => {
  it("computes IForward - IReverse", () => {
    expect(computeINet(2.5, 1.0)).toBeCloseTo(1.5);
    expect(Number.isNaN(computeINet(NaN, 1))).toBe(true);
  });
});

describe("SWV — baseline correction", () => {
  it("removes a known linear baseline from a Gaussian", () => {
    const prog = generateSWVProgram({ ...baseParams, step_mV: 4 });
    const E = prog.map((s) => s.E);
    const a = 0.1, b = 0.02;
    const gauss = E.map((e) => Math.exp(-0.5 * ((e - 0.22) / 0.04) ** 2));
    const iNet = gauss.map((g, i) => g + a * E[i] + b);
    const res = correctBaseline(E, iNet, "linear_edges");
    // Peak-side corrected value should be close to Gaussian peak (~1), not raw (~1 + a*E+b).
    const corr = iNet.map((y, i) => y - res.baseline[i]);
    const peak = Math.max(...corr);
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThan(1.1);
  });
});

describe("SWV — peak detection", () => {
  it("detects positive (anodic) peak", () => {
    const d = makeGaussianData(1, 0.002);
    const { metrics } = analyzeSWV(d, "linear_edges");
    expect(metrics.peakDetected).toBe(true);
    expect(metrics.peakPolarity).toBe("anodic");
    expect(metrics.peakPotential_V ?? 0).toBeGreaterThan(0.15);
    expect(metrics.peakPotential_V ?? 0).toBeLessThan(0.30);
    expect((metrics.snr ?? 0)).toBeGreaterThan(5);
    expect(metrics.halfPeakWidth_mV ?? 0).toBeGreaterThan(20);
    expect(metrics.halfPeakWidth_mV ?? 0).toBeLessThan(300);
  });
  it("detects negative (cathodic) peak", () => {
    const d = makeGaussianData(-1, 0.002);
    const { metrics } = analyzeSWV(d, "linear_edges");
    expect(metrics.peakDetected).toBe(true);
    expect(metrics.peakPolarity).toBe("cathodic");
  });
});

describe("SWV — validation", () => {
  it("flags invalid parameters", () => {
    const v = validateSWVParameters({ ...baseParams, startE: 0.1, endE: 0.1 });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
  it("warns on high amplitude", () => {
    const v = validateSWVParameters({ ...baseParams, amplitude_mV: 80 });
    expect(v.ok).toBe(true);
    expect(v.warnings.join("|")).toMatch(/Amplitude/);
  });
});

describe("SWV — analyze pipeline empty guard", () => {
  it("handles empty input", () => {
    const { metrics } = analyzeSWV([], "auto");
    expect(metrics.peakDetected).toBe(false);
  });
});

describe("SWV — detectSWVPeak edge case", () => {
  it("returns unknown polarity when too few points", () => {
    const r = detectSWVPeak([0, 0.1], [0.1, 0.2], [0.1, 0.2], "none", "none", null, null, []);
    expect(r.peakDetected).toBe(false);
    expect(r.peakPolarity).toBe("unknown");
  });
});

describe("SWV — invariants", () => {
  it("INet equals IForward - IReverse in the generator", () => {
    const d = makeGaussianData(1, 0);
    for (const p of d) {
      expect(p.INet).toBeCloseTo(p.IForward - p.IReverse, 12);
    }
  });
  it("baseline correction does not mutate raw forward/reverse currents", () => {
    const d = makeGaussianData(1, 0.002);
    const snapshot = d.map((p) => ({ f: p.IForward, r: p.IReverse, net: p.INet }));
    const { corrected } = analyzeSWV(d, "linear_edges");
    for (let i = 0; i < d.length; i++) {
      expect(d[i].IForward).toBe(snapshot[i].f);
      expect(d[i].IReverse).toBe(snapshot[i].r);
      expect(d[i].INet).toBe(snapshot[i].net);
      // Corrected block carries baseline & ICorrected without touching the raw fields.
      expect(corrected[i].IForward).toBe(snapshot[i].f);
      expect(corrected[i].IReverse).toBe(snapshot[i].r);
    }
  });
  it("SNR remains finite for noise-free data (fallback engaged)", () => {
    const d = makeGaussianData(1, 0); // zero noise
    const { metrics } = analyzeSWV(d, "linear_edges");
    expect(metrics.snr).not.toBeNull();
    expect(Number.isFinite(metrics.snr as number)).toBe(true);
    expect(metrics.peakDetected).toBe(true);
  });
  it("peakCurrentCorrected differs from raw when baseline is non-zero", () => {
    const d = makeGaussianData(1, 0.001);
    const { metrics } = analyzeSWV(d, "linear_edges");
    expect(metrics.peakCurrentRaw_uA).not.toBeNull();
    expect(metrics.peakCurrentCorrected_uA).not.toBeNull();
    expect(
      Math.abs((metrics.peakCurrentRaw_uA as number) - (metrics.peakCurrentCorrected_uA as number)),
    ).toBeGreaterThan(1e-6);
  });
  it("tolerates an isolated NaN sample without corrupting the sweep analysis", () => {
    const clean = makeGaussianData(1, 0.002);
    const baseline = analyzeSWV(clean, "linear_edges").metrics;
    // Pick an index far from the peak (early edge) so we exercise the
    // baseline-fit exclusion path — the peak sits around E ≈ 0.22 V.
    const dirty = clean.map((p) => ({ ...p }));
    const dropIdx = 5;
    dirty[dropIdx] = { ...dirty[dropIdx], INet: NaN };
    const { corrected, metrics } = analyzeSWV(dirty, "linear_edges");
    expect(metrics.snr).not.toBeNull();
    expect(Number.isFinite(metrics.snr as number)).toBe(true);
    expect(metrics.peakDetected).toBe(true);
    expect(metrics.peakDetected).toBe(baseline.peakDetected);
    expect(metrics.warnings.some((w) => /missing sample/i.test(w))).toBe(true);
    // Displayed / exported series MUST preserve the missing point as NaN,
    // never fabricate a value.
    expect(Number.isNaN(corrected[dropIdx].ICorrected as number)).toBe(true);
    expect(Number.isNaN(corrected[dropIdx].baseline as number)).toBe(true);
  });
  it("empty data returns a full SWVMetrics shape (no missing fields)", () => {
    const { metrics } = analyzeSWV([], "auto");
    expect(metrics).toMatchObject({
      peakDetected: false,
      peakPolarity: "unknown",
      baselineMethod: "auto",
      baselineMethodUsed: "auto",
      snr: null,
      noiseRms_uA: null,
    });
  });
});

// ────────────────── physical SWV solvers ──────────────────

import {
  simulateReversibleDiffusionSWV,
  simulateQuasiReversibleSWV,
} from "@/utils/swvDiffusionSolver";

const physicalParams: SWVParameters = {
  startE: -0.1,
  endE: 0.5,
  step_mV: 4,
  amplitude_mV: 25,
  frequency_Hz: 25,
  quietTime_s: 0,
  direction: "anodic",
  cMM: 1.0,
  area_cm2: 0.0707,
  nElectrons: 1,
};

function peakOf(pts: SWVDataPoint[]) {
  let iBest = 0;
  let best = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].INet) > best) {
      best = Math.abs(pts[i].INet);
      iBest = i;
    }
  }
  return { E: pts[iBest].E, I: pts[iBest].INet };
}

describe("SWV physical solver — reversible", () => {
  it("INet exactly equals IForward - IReverse at every point", () => {
    const pts = simulateReversibleDiffusionSWV(physicalParams);
    expect(pts.length).toBeGreaterThan(10);
    for (const p of pts) expect(p.INet).toBeCloseTo(p.IForward - p.IReverse, 12);
  });
  it("blank (cMM = 0) gives INet ≈ 0 everywhere", () => {
    const pts = simulateReversibleDiffusionSWV({ ...physicalParams, cMM: 0 });
    for (const p of pts) expect(Math.abs(p.INet)).toBeLessThan(1e-9);
  });
  it("increasing amplitude_mV increases the peak current", () => {
    const low = peakOf(
      simulateReversibleDiffusionSWV({ ...physicalParams, amplitude_mV: 5 }),
    );
    const high = peakOf(
      simulateReversibleDiffusionSWV({ ...physicalParams, amplitude_mV: 20 }),
    );
    expect(Math.abs(high.I)).toBeGreaterThan(Math.abs(low.I));
  });
});

describe("SWV physical solver — quasi-reversible", () => {
  it("INet exactly equals IForward - IReverse at every point", () => {
    const pts = simulateQuasiReversibleSWV(physicalParams);
    expect(pts.length).toBeGreaterThan(10);
    for (const p of pts) expect(p.INet).toBeCloseTo(p.IForward - p.IReverse, 12);
  });
  it("blank (cMM = 0) gives INet ≈ 0 everywhere", () => {
    const pts = simulateQuasiReversibleSWV({ ...physicalParams, cMM: 0 });
    for (const p of pts) expect(Math.abs(p.INet)).toBeLessThan(1e-9);
  });
  it("amplitude_mV measurably affects the peak (kinetics-dependent)", () => {
    // Butler–Volmer at K0 < K_MAX combined with the Cottrell-kernel
    // convolution history gives an amplitude dependence that is not
    // always monotonic in |INet| — but the peak MUST differ, proving
    // this is no longer the amplitude-independent empirical Gaussian.
    const low = peakOf(
      simulateQuasiReversibleSWV({ ...physicalParams, amplitude_mV: 5 }),
    );
    const high = peakOf(
      simulateQuasiReversibleSWV({ ...physicalParams, amplitude_mV: 30 }),
    );
    const scale = Math.max(Math.abs(low.I), Math.abs(high.I));
    expect(Math.abs(high.I - low.I) / (scale || 1)).toBeGreaterThan(1e-3);
  });
});


describe("SWV physical solvers — reversible vs quasi-reversible", () => {
  it("quasi-reversible peak is not larger than reversible at the same params", () => {
    const rev = peakOf(simulateReversibleDiffusionSWV(physicalParams));
    const qr = peakOf(simulateQuasiReversibleSWV(physicalParams));
    // Butler–Volmer at K0 < K_MAX must attenuate and/or shift the peak.
    // Guard against a trivial fake by asserting a meaningful difference.
    const attenuated = Math.abs(qr.I) < Math.abs(rev.I) * 0.98;
    const shifted = Math.abs(qr.E - rev.E) > 0.005;
    expect(attenuated || shifted).toBe(true);
  });
});

describe("SWV calibration — linear fit, LOD/LOQ", () => {
  // The default/demo SWV simulator model is diffusion-controlled (same
  // physics family as CV — see the header comment in
  // useSimulatedSWVData.ts), so a linear signal-vs-concentration series is
  // the physically appropriate synthetic input here — unlike EIS/BioFET's
  // saturating Langmuir series, which is a genuinely different technique
  // (surface-binding, not bulk diffusion). Mirrors cv.test.ts's
  // calibration block: 3 baseline replicates + duplicate measurements at
  // 3 concentrations.
  const SLOPE_UA_PER_NM = 0.05;
  const concentrations = [0, 0, 0, 10, 10, 50, 50, 200, 200];
  const blankJitterUA = [-0.01, 0, 0.01];

  function makePoints(): CalibrationPoint[] {
    let blankIdx = 0;
    return concentrations.map((c, i) => {
      const signal = c === 0 ? blankJitterUA[blankIdx++] : SLOPE_UA_PER_NM * c;
      return { concentration: c, signal, raw: signal, timestamp: Date.now() + i };
    });
  }

  it("recovers the slope from a clean synthetic linear series", () => {
    const fit = fitLinearSWV(makePoints());
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(SLOPE_UA_PER_NM, 2);
    expect(fit!.r2).toBeGreaterThan(0.98);
  });

  it("computes finite LOD < LOQ from blank replicates", () => {
    const result = computeLODSWV(makePoints());
    expect(result).not.toBeNull();
    expect(result!.sigmaSource).toBe("replicates");
    expect(Number.isFinite(result!.value)).toBe(true);
    expect(Number.isFinite(result!.loq)).toBe(true);
    expect(result!.value).toBeGreaterThan(0);
    expect(result!.loq).toBeGreaterThan(result!.value); // 10σ > 3σ
  });

  it("falls back to fit residuals when fewer than 2 blank replicates are present", () => {
    const pts: CalibrationPoint[] = [
      { concentration: 0, signal: 0, raw: 0, timestamp: 1 },
      { concentration: 10, signal: SLOPE_UA_PER_NM * 10, raw: SLOPE_UA_PER_NM * 10, timestamp: 2 },
      { concentration: 50, signal: SLOPE_UA_PER_NM * 50, raw: SLOPE_UA_PER_NM * 50, timestamp: 3 },
      { concentration: 200, signal: SLOPE_UA_PER_NM * 200, raw: SLOPE_UA_PER_NM * 200, timestamp: 4 },
    ];
    const result = computeLODSWV(pts);
    expect(result).not.toBeNull();
    expect(result!.sigmaSource).toBe("residuals");
    expect(Number.isFinite(result!.value)).toBe(true);
    expect(result!.value).toBeGreaterThanOrEqual(0);
  });

  it("returns null when the fit slope is not positive", () => {
    const flat: CalibrationPoint[] = [
      { concentration: 0, signal: 0, raw: 0, timestamp: 1 },
      { concentration: 10, signal: 0, raw: 0, timestamp: 2 },
      { concentration: 50, signal: 0, raw: 0, timestamp: 3 },
    ];
    expect(computeLODSWV(flat)).toBeNull();
  });
});

