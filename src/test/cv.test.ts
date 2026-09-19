import { describe, it, expect } from "vitest";
import { computeCVMetrics } from "@/utils/computeCVMetrics";
import {
  buildCVCalibrationPoint,
  summarizeCalibration,
  randlesSevcikIpUA,
} from "@/utils/cvCalibration";
import {
  CV_RS_PREFACTOR,
  CV_DEFAULT_D_CM2_S,
  CV_E0_PRIME_DEFAULT_V,
} from "@/utils/cvConstants";
import {
  buildCVPointsForTest,
  parseCVWebSocketMessage,
  DEFAULT_CV_PARAMS,
  type CVDataPoint,
} from "@/hooks/useSimulatedCVData";
import { buildCVExportText } from "@/utils/csvExport";
import { computeCVSignalQuality } from "@/utils/cvSignalQuality";
import { simulateReversibleDiffusionCV } from "@/utils/cvDiffusionSolver";
import { CV_F, CV_R, CV_T_DEFAULT_K } from "@/utils/cvConstants";

/**
 * Synthetic Nernstian-shape voltammogram with two Gaussian peaks.
 * Default direction: cathodic-first (E goes 0.6 → -0.2 → 0.6).
 */
function makeReversibleCurve(opts: {
  cMM: number;
  ipUA?: number;
  noise?: number;
  baseline?: (E: number) => number;
  direction?: "cathodic-first" | "anodic-first";
  cycle?: number;
  noBranch?: boolean;
}): CVDataPoint[] {
  const ipUA = opts.ipUA ?? opts.cMM * 20;
  const noise = opts.noise ?? 0;
  const baseline = opts.baseline ?? (() => 0);
  const direction = opts.direction ?? "cathodic-first";
  const cycle = opts.cycle ?? 1;
  const Epc = 0.22 - 0.02958;
  const Epa = 0.22 + 0.02958;
  const sigma = 0.035;
  const data: CVDataPoint[] = [];
  const fwdIsCathodic = direction === "cathodic-first";
  const fromE = fwdIsCathodic ? 0.6 : -0.2;
  const toE = fwdIsCathodic ? -0.2 : 0.6;
  const fwdE: number[] = [];
  const step = fwdIsCathodic ? -0.005 : 0.005;
  for (
    let E = fromE;
    fwdIsCathodic ? E >= toE - 1e-9 : E <= toE + 1e-9;
    E += step
  ) {
    fwdE.push(+E.toFixed(4));
  }
  const revE = [...fwdE].reverse();
  let t = 0;
  const noiseTerm = () => (noise ? (Math.random() - 0.5) * 2 * noise : 0);
  for (const E of fwdE) {
    const peak = fwdIsCathodic
      ? -ipUA * Math.exp(-0.5 * ((E - Epc) / sigma) ** 2)
      : ipUA * Math.exp(-0.5 * ((E - Epa) / sigma) ** 2);
    const I = peak + baseline(E) + noiseTerm();
    const pt: CVDataPoint = { E, I, cycle, t };
    if (!opts.noBranch) pt.branch = "forward";
    data.push(pt);
    t += 0.05;
  }
  for (const E of revE) {
    const peak = fwdIsCathodic
      ? ipUA * Math.exp(-0.5 * ((E - Epa) / sigma) ** 2)
      : -ipUA * Math.exp(-0.5 * ((E - Epc) / sigma) ** 2);
    const I = peak + baseline(E) + noiseTerm();
    const pt: CVDataPoint = { E, I, cycle, t };
    if (!opts.noBranch) pt.branch = "reverse";
    data.push(pt);
    t += 0.05;
  }
  return data;
}

describe("CV constants", () => {
  it("Randles–Ševčík prefactor at 298.15 K ≈ 268648", () => {
    expect(CV_RS_PREFACTOR).toBeGreaterThan(268000);
    expect(CV_RS_PREFACTOR).toBeLessThan(269000);
  });
  it("CV_DEFAULT_D_CM2_S equals the Fe(CN)6 reference value", () => {
    expect(CV_DEFAULT_D_CM2_S).toBeCloseTo(7.26e-6, 9);
  });
  it("randlesSevcikIpUA uses CV_DEFAULT_D_CM2_S when D is omitted", () => {
    const a = randlesSevcikIpUA({ n: 1, areaCm2: 0.0707, cMM: 5, scanRate_mVs: 100 });
    const b = randlesSevcikIpUA({ n: 1, areaCm2: 0.0707, cMM: 5, scanRate_mVs: 100, D_cm2s: CV_DEFAULT_D_CM2_S });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.abs(a! - b!)).toBeLessThan(1e-9);
  });
});

describe("computeCVMetrics — reversible defaults", () => {
  it("strict default: 2 peaks, ΔEp≈59 mV, ratio≈1, D_status=valid, SNR>10", () => {
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80 });
    const m = computeCVMetrics(data, { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 });
    expect(m).not.toBeNull();
    expect(m!.hasAnodic).toBe(true);
    expect(m!.hasCathodic).toBe(true);
    expect((m!.hasAnodic ? 1 : 0) + (m!.hasCathodic ? 1 : 0)).toBe(2);
    expect(m!.deltaEp).toBeGreaterThanOrEqual(55);
    expect(m!.deltaEp).toBeLessThanOrEqual(63);
    expect(m!.IpaIpcRatio).toBeGreaterThanOrEqual(0.95);
    expect(m!.IpaIpcRatio).toBeLessThanOrEqual(1.05);
    expect(Math.abs(m!.E0prime - CV_E0_PRIME_DEFAULT_V)).toBeLessThanOrEqual(0.005);
    expect(m!.D_status).toBe("valid");
    expect(m!.D_apparent).toBeGreaterThan(CV_DEFAULT_D_CM2_S * 0.8);
    expect(m!.D_apparent).toBeLessThan(CV_DEFAULT_D_CM2_S * 1.2);
    expect(m!.n_est_valid).toBe(true);
    expect(m!.n_electrons).toBeGreaterThan(0.9);
    expect(m!.n_electrons).toBeLessThan(1.1);
    expect(m!.SNR_anodic).toBeGreaterThan(10);
    expect(m!.SNR_cathodic).toBeGreaterThan(10);
    expect(m!.correctedData).toBeDefined();
    expect(m!.correctedData!.length).toBe(data.length);
  });
});

describe("computeCVMetrics — quasi-reversible D_status", () => {
  it("simulator quasi-reversible: D_status is never 'valid'", () => {
    const points = buildCVPointsForTest({
      ...DEFAULT_CV_PARAMS,
      cvModel: "quasi-reversible",
    });
    expect(points.length).toBeGreaterThan(50);
    const m = computeCVMetrics(points, {
      scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707,
    });
    expect(m).not.toBeNull();
    expect(m!.D_status).not.toBe("valid");
    expect(["apparent", "invalid"]).toContain(m!.D_status);
    if (m!.D_status === "apparent") {
      expect(
        m!.warnings.some((w) => /apparent|informational|reversible/i.test(w)),
      ).toBe(true);
    }
  });

  it("synthetic stretched ΔEp ≫ 59 mV → not validated", () => {
    const Epc = 0.22 - 0.10;
    const Epa = 0.22 + 0.10;
    const sigma = 0.05;
    const ipUA = 80;
    const data: CVDataPoint[] = [];
    let t = 0;
    for (let E = 0.6; E >= -0.2 - 1e-9; E -= 0.005) {
      data.push({ E: +E.toFixed(4), I: -ipUA * Math.exp(-0.5 * ((E - Epc) / sigma) ** 2), cycle: 1, t, branch: "forward" });
      t += 0.05;
    }
    for (let E = -0.2; E <= 0.6 + 1e-9; E += 0.005) {
      data.push({ E: +E.toFixed(4), I: ipUA * Math.exp(-0.5 * ((E - Epa) / sigma) ** 2), cycle: 1, t, branch: "reverse" });
      t += 0.05;
    }
    const m = computeCVMetrics(data, { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 });
    expect(m).not.toBeNull();
    expect(m!.D_status).not.toBe("valid");
  });
});

describe("computeCVMetrics — anodic-first sweep direction", () => {
  it("eStart = -0.2 → 0.6 → -0.2 still recovers both peaks", () => {
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80, direction: "anodic-first" });
    const m = computeCVMetrics(data, { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 });
    expect(m).not.toBeNull();
    expect(m!.hasAnodic).toBe(true);
    expect(m!.hasCathodic).toBe(true);
    expect(Number.isFinite(m!.Epa)).toBe(true);
    expect(Number.isFinite(m!.Epc)).toBe(true);
    expect(m!.Epa).toBeGreaterThan(m!.Epc);
    expect(m!.deltaEp).toBeGreaterThan(0);
  });
});

describe("computeCVMetrics — branch fallback (no branch field)", () => {
  it("uses switching-point detection and still finds 2 peaks", () => {
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80, noBranch: true });
    expect(data.every((p) => p.branch === undefined)).toBe(true);
    const m = computeCVMetrics(data, { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 });
    expect(m).not.toBeNull();
    expect(m!.hasAnodic).toBe(true);
    expect(m!.hasCathodic).toBe(true);
    expect(m!.deltaEp).toBeGreaterThan(0);
    expect(m!.correctedData!.length).toBe(data.length);
  });
});

describe("computeCVMetrics — multi-cycle correctedData covers all points", () => {
  it("preserves every point across cycles and reports cycle 1", () => {
    const c1 = makeReversibleCurve({ cMM: 5, ipUA: 80, cycle: 1 });
    const c2 = makeReversibleCurve({ cMM: 5, ipUA: 80, cycle: 2 });
    const data = [...c1, ...c2];
    const m = computeCVMetrics(data, { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 });
    expect(m).not.toBeNull();
    expect(m!.correctedData!.length).toBe(data.length);
    expect(m!.correctedDataCoversAllCycles).toBe(true);
    expect(m!.metricsCycle).toBe(1);
    for (let i = 0; i < data.length; i++) {
      expect(m!.correctedData![i].E).toBe(data[i].E);
      expect(m!.correctedData![i].cycle).toBe(data[i].cycle);
      expect(m!.correctedData![i].t).toBe(data[i].t);
    }
    const cyclesSeen = new Set(m!.correctedData!.map((p) => p.cycle));
    expect(cyclesSeen.has(1)).toBe(true);
    expect(cyclesSeen.has(2)).toBe(true);
    const incomplete = m!.warnings.some((w) =>
      /unavailable for one or more cycles/i.test(w),
    );
    expect(incomplete).toBe(false);
  });
});

describe("computeCVMetrics — baseline modes", () => {
  it("'none' leaves raw currents untouched", () => {
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80 });
    const m = computeCVMetrics(data, {
      scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707,
      baselineMethodInput: "none",
    });
    expect(m).not.toBeNull();
    expect(m!.baselineMethod).toBe("none");
    expect(m!.correctedData).toBeUndefined();
  });

  it("'linear-first-15' recovers a known linear baseline at the start", () => {
    const baseline = (E: number) => 2 * E + 5;
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80, baseline });
    const m = computeCVMetrics(data, {
      scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707,
      baselineMethodInput: "linear-first-15",
    });
    expect(m).not.toBeNull();
    expect(m!.baselineResolvedMethod).toBe("linear-first-15");
    const cd = m!.correctedData!;
    expect(cd.length).toBe(data.length);
    for (const p of cd.slice(0, 5)) {
      if (p.baseline != null) {
        expect(Math.abs(p.baseline - baseline(p.E))).toBeLessThan(1);
      }
    }
  });

  it("'linear-edges' captures a sloped baseline at the edges", () => {
    const baseline = (E: number) => 3 * E + 4;
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80, baseline });
    const m = computeCVMetrics(data, {
      scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707,
      baselineMethodInput: "linear-edges",
    });
    expect(m).not.toBeNull();
    expect(m!.baselineResolvedMethod).toBe("linear-edges");
    const cd = m!.correctedData!;
    const edge = cd[2];
    if (edge.baseline != null) {
      expect(Math.abs(edge.baseline - baseline(edge.E))).toBeLessThan(2);
    }
  });

  it("'auto' resolves to a concrete method (not hardcoded first-15)", () => {
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80 });
    const m = computeCVMetrics(data, {
      scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707,
      baselineMethodInput: "auto",
    });
    expect(m).not.toBeNull();
    expect(m!.baselineMethodInput).toBe("auto");
    expect(["linear-first-15", "linear-edges", "mixed"]).toContain(
      m!.baselineResolvedMethod,
    );
  });

  it("'auto' prefers linear-edges when the first-15 region is noisy", () => {
    const baseline = (E: number) => 5 * E + 2;
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80, baseline });
    const nFwd = data.findIndex((p) => p.branch === "reverse");
    const n15 = Math.max(3, Math.floor(nFwd * 0.15));
    // Inject high random scatter on the first 15% of the forward branch so
    // the linear-first-15 residual sigma is much worse than edges.
    let seed = 42;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280 - 0.5;
    };
    for (let i = 0; i < n15; i++) data[i] = { ...data[i], I: data[i].I + rand() * 60 };
    const m = computeCVMetrics(data, {
      scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707,
      baselineMethodInput: "auto",
    });
    expect(m).not.toBeNull();
    expect(["linear-edges", "mixed"]).toContain(m!.baselineResolvedMethod);
  });
});

describe("computeCVMetrics — SNR fallback for clean curves", () => {
  it("noise≈0 but SNR remains large via fallback noise floor", () => {
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80, noise: 0 });
    const m = computeCVMetrics(data, { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 });
    expect(m).not.toBeNull();
    expect(m!.SNR_anodic).toBeGreaterThan(10);
    expect(m!.SNR_cathodic).toBeGreaterThan(10);
    const q = computeCVSignalQuality(m!, 1, 20);
    expect(q.snrLevel).toBe("green");
    expect(q.level).not.toBe("red");
  });
});

describe("computeCVMetrics — blank (C = 0 mM)", () => {
  it("flat curve has no faradaic peaks and no NaN leaks", () => {
    const data = makeReversibleCurve({ cMM: 0, ipUA: 0, noise: 0 });
    const m = computeCVMetrics(data, { scanRate_mVs: 100, n: 1, cMM: 0, areaCm2: 0.0707 });
    expect(m).not.toBeNull();
    expect(m!.hasAnodic).toBe(false);
    expect(m!.hasCathodic).toBe(false);
    expect(m!.D_status).toBe("invalid");
    expect(m!.n_est_valid).toBe(false);
    expect(m!.correctedData!.length).toBe(data.length);
    for (const p of data) expect(Number.isFinite(p.I)).toBe(true);
  });

  it("3 blank replicates are kept in calibration", () => {
    const pts = [0, 0, 0].map(() => {
      const data = makeReversibleCurve({ cMM: 0, ipUA: 0 });
      const m = computeCVMetrics(data, { scanRate_mVs: 100, n: 1, cMM: 0, areaCm2: 0.0707 });
      return buildCVCalibrationPoint(0, m, "reversible");
    });
    expect(pts.length).toBe(3);
    const summary = summarizeCalibration(pts, "mean");
    expect(summary.nBlankReplicates).toBe(3);
    expect(summary.lod_mM).toBeNull();
    expect(summary.loq_mM).toBeNull();
  });
});

describe("CV calibration — replicates, LOD/LOQ, non-positive slope", () => {
  const concentrations = [0, 0, 0, 1, 1, 2, 2, 5, 5];
  it("keeps every measurement and computes finite LOD/LOQ with sane slope", () => {
    const pts = concentrations.map((c) => {
      const data = makeReversibleCurve({ cMM: c, ipUA: c * 16 });
      const m = computeCVMetrics(data, { scanRate_mVs: 100, n: 1, cMM: c, areaCm2: 0.0707 });
      return buildCVCalibrationPoint(c, m, "reversible");
    });
    const summary = summarizeCalibration(pts, "mean");
    expect(summary.nBlankReplicates).toBe(3);
    expect(summary.fit).not.toBeNull();
    expect(summary.fit!.nPoints).toBeGreaterThanOrEqual(6);
    expect(summary.fit!.slope).toBeGreaterThan(0);
    expect(summary.fit!.r2).toBeGreaterThan(0.98);
    expect(summary.sigmaSource).toBe("blank-replicates");
    expect(summary.lod_mM).not.toBeNull();
    expect(summary.loq_mM).not.toBeNull();
    expect(Number.isFinite(summary.lod_mM!)).toBe(true);
    expect(Number.isFinite(summary.loq_mM!)).toBe(true);
  });

  it("returns null LOD/LOQ when slope ≤ 0", () => {
    const pts = [
      buildCVCalibrationPoint(0, null, "reversible"),
      buildCVCalibrationPoint(1, null, "reversible"),
    ];
    const summary = summarizeCalibration(pts, "mean");
    expect(summary.lod_mM).toBeNull();
    expect(summary.loq_mM).toBeNull();
  });
});

describe("buildCVExportText — headers, baseline columns and processed metrics", () => {
  it("contains all required headers and non-N/A baseline rows when corrected exists", () => {
    const data = makeReversibleCurve({ cMM: 5, ipUA: 80 });
    const m = computeCVMetrics(data, {
      scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707,
      baselineMethodInput: "auto",
    });
    const text = buildCVExportText(
      data, m,
      { scanRate: 100, eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6,
        nCycles: 1, n: 1, cMM: 5, areaCm2: 0.0707, cvModel: "reversible" },
      "simulated", "raw",
    );
    const required = [
      "technique", "scan_rate_mVs", "concentration_mM",
      "baseline_method_input", "baseline_resolved_method",
      "metrics_cycle", "corrected_data_available",
      "E_V", "I_uA", "baseline_uA", "I_corrected_uA",
      "Epa_V", "Epc_V", "deltaEp_mV", "D_status",
      "SNR_anodic", "SNR_cathodic", "warnings",
    ];
    for (const h of required) expect(text).toContain(h);
    const lines = text.split("\n");
    const rawIdx = lines.findIndex((l) => l.startsWith("measurement_id;channel;timestamp;time_s"));
    expect(rawIdx).toBeGreaterThan(0);
    const sampleRow = lines[rawIdx + 5] ?? "";
    const cols = sampleRow.split(";");
    expect(cols.length).toBe(10);
    expect(cols[1]).toBe("—"); // channel (single-device session)
    expect(cols[8]).not.toBe("N/A"); // baseline_uA
    expect(cols[9]).not.toBe("N/A"); // I_corrected_uA
  });
});

describe("parseCVWebSocketMessage", () => {
  it("parses a valid cv_data frame", () => {
    const p = parseCVWebSocketMessage({
      type: "cv_data", E: 0.245, I: 81.2, cycle: 1, t: 4.5, branch: "reverse",
    });
    expect(p).not.toBeNull();
    expect(p!.E).toBe(0.245);
    expect(p!.I).toBe(81.2);
    expect(p!.cycle).toBe(1);
    expect(p!.branch).toBe("reverse");
  });

  it("rejects malformed frames", () => {
    expect(parseCVWebSocketMessage(null)).toBeNull();
    expect(parseCVWebSocketMessage({ type: "cv_data", E: null, I: 81.2 })).toBeNull();
    expect(parseCVWebSocketMessage({ type: "cv_data", E: 0.2, I: "abc" })).toBeNull();
    expect(parseCVWebSocketMessage({ type: "cv_data", E: NaN, I: 1 })).toBeNull();
    expect(parseCVWebSocketMessage({ type: "cv_data", E: 0.2 })).toBeNull();
    expect(parseCVWebSocketMessage({ type: "other", E: 1, I: 1 })).toBeNull();
  });

  it("coerces invalid branch and cycle to safe defaults", () => {
    const p1 = parseCVWebSocketMessage({ type: "cv_data", E: 0.2, I: 1, branch: "weird" });
    expect(p1).not.toBeNull();
    expect(p1!.branch).toBeUndefined();
    const p2 = parseCVWebSocketMessage({ type: "cv_data", E: 0.2, I: 1, cycle: -1 });
    expect(p2!.cycle).toBe(1);
    const p3 = parseCVWebSocketMessage({ type: "cv_data", E: 0.2, I: 1, cycle: "x" });
    expect(p3!.cycle).toBe(1);
  });
});

describe("computeCVSignalQuality — pure helper", () => {
  const baseMetrics = {
    IpaRaw: 80, IpcRaw: -80, IpaCorrected: 80, IpcCorrected: -80,
    Ipa: 80, Ipc: -80, Epa: 0.25, Epc: 0.19, E0prime: 0.22,
    deltaEp: 59, IpaIpcRatio: 1.0,
    n_electrons: 1, n_est_valid: true,
    D_apparent: 7.26e-6, D_valid: true, D_status: "valid" as const,
    reversibility: "reversible" as const,
    baselineMethod: "per-branch-linear" as const,
    baselineMethodInput: "auto" as const,
    baselineResolvedMethod: "linear-first-15" as const,
    metricsCycle: 1,
    correctedDataAvailable: true,
    correctedDataCoversAllCycles: true,
    noise_uA: 0.1, SNR_anodic: 800, SNR_cathodic: 800,
    hasAnodic: true, hasCathodic: true, warnings: [],
  };

  it("green when peaks, ratio and SNR are in spec", () => {
    expect(computeCVSignalQuality(baseMetrics, 1, 20).level).toBe("green");
  });
  it("low SNR → never green", () => {
    const q = computeCVSignalQuality({ ...baseMetrics, SNR_anodic: 1, SNR_cathodic: 1 }, 1, 20);
    expect(q.snrLevel).toBe("red");
    expect(q.level).toBe("red");
  });
  it("large ΔEp is red on its own row but informational: overall stays green", () => {
    const q = computeCVSignalQuality({ ...baseMetrics, deltaEp: 300 }, 1, 20);
    expect(q.deltaEpLevel).toBe("red");
    expect(q.level).toBe("green");
  });
  it("ratio outside 0.9–1.1 (baseline problem) → not green overall", () => {
    const q = computeCVSignalQuality({ ...baseMetrics, IpaIpcRatio: 0.75 }, 1, 20);
    expect(q.ratioLevel).toBe("yellow");
    expect(q.level).toBe("yellow");
  });
  it("a clean quasi-reversible simulated scan is green overall while reversibility stays yellow", () => {
    const pts = buildCVPointsForTest({ ...DEFAULT_CV_PARAMS, cvModel: "quasi-reversible" });
    const m = computeCVMetrics(pts, { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 })!;
    const q = computeCVSignalQuality(m, 1, 20);
    expect(m.reversibility).toBe("quasi-reversible");
    expect(q.reversibilityLevel).toBe("yellow");
    expect(q.deltaEpLevel).toBe("yellow");
    expect(q.level).toBe("green");
  });
  it("ratio outside 0.7–1.3 → red on ratio", () => {
    const q = computeCVSignalQuality({ ...baseMetrics, IpaIpcRatio: 0.5 }, 1, 20);
    expect(q.ratioLevel).toBe("red");
  });
  it("D_status='apparent' is informational — overall may still be green", () => {
    const q = computeCVSignalQuality(
      { ...baseMetrics, D_status: "apparent", D_valid: false },
      1, 20,
    );
    expect(q.dLevel).toBe("yellow");
    expect(q.level).toBe("green");
  });
  it("ΔEp tolerance is configurable", () => {
    const tight = computeCVSignalQuality({ ...baseMetrics, deltaEp: 80 }, 1, 5);
    const loose = computeCVSignalQuality({ ...baseMetrics, deltaEp: 80 }, 1, 30);
    expect(tight.deltaEpLevel).toBe("red");
    expect(loose.deltaEpLevel).toBe("green");
  });
});

// ───────────────────── reversible diffusion solver ─────────────────────

function peakStats(points: CVDataPoint[]) {
  let iMaxAn = -Infinity, iMaxCa = +Infinity;
  let eAn = 0, eCa = 0;
  for (const p of points) {
    if (p.I > iMaxAn) { iMaxAn = p.I; eAn = p.E; }
    if (p.I < iMaxCa) { iMaxCa = p.I; eCa = p.E; }
  }
  return { Ipa: iMaxAn, Ipc: iMaxCa, Epa: eAn, Epc: eCa };
}

const SOLVER_DEFAULTS = {
  eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6,
  scanRate_mVs: 100, nCycles: 1, n: 1, areaCm2: 0.0707, cMM: 5,
};

describe("simulateReversibleDiffusionCV — physical solver", () => {
  it("produces clean points with the right sign convention", () => {
    const pts = simulateReversibleDiffusionCV(SOLVER_DEFAULTS);
    expect(pts.length).toBeGreaterThan(200);
    for (const p of pts) {
      expect(Number.isFinite(p.E)).toBe(true);
      expect(Number.isFinite(p.I)).toBe(true);
    }
    const { Ipa, Ipc } = peakStats(pts);
    expect(Ipa).toBeGreaterThan(0);
    expect(Ipc).toBeLessThan(0);
  });

  it("ΔEp is close to 59 mV for n=1 (50–75 mV window)", () => {
    const pts = simulateReversibleDiffusionCV(SOLVER_DEFAULTS);
    const { Epa, Epc } = peakStats(pts);
    const dEp = Math.abs(Epa - Epc) * 1000;
    expect(dEp).toBeGreaterThanOrEqual(50);
    expect(dEp).toBeLessThanOrEqual(75);
  });

  it("cathodic peak is within ±15% of Randles–Ševčík", () => {
    const pts = simulateReversibleDiffusionCV(SOLVER_DEFAULTS);
    const { Ipc } = peakStats(pts);
    const cBulk = SOLVER_DEFAULTS.cMM * 1e-6;
    const vVs = SOLVER_DEFAULTS.scanRate_mVs / 1000;
    const ipA =
      0.4463 * SOLVER_DEFAULTS.n * CV_F * SOLVER_DEFAULTS.areaCm2 * cBulk *
      Math.sqrt((SOLVER_DEFAULTS.n * CV_F * CV_DEFAULT_D_CM2_S * vVs) /
        (CV_R * CV_T_DEFAULT_K));
    const ipUA = ipA * 1e6;
    expect(Math.abs(Ipc) / ipUA).toBeGreaterThan(0.85);
    expect(Math.abs(Ipc) / ipUA).toBeLessThan(1.15);
  });

  it("raw |Ipa/Ipc| sits in textbook reversible range [0.6, 0.95]", () => {
    // Without Nicholson baseline subtraction, the raw peak-max |Ipa/Ipc|
    // of a reversible CV is ~0.7–0.8 because the cathodic decay tail
    // depresses the anodic peak. ≈1.0 only emerges after baseline
    // correction at the switching potential.
    const pts = simulateReversibleDiffusionCV(SOLVER_DEFAULTS);
    const { Ipa, Ipc } = peakStats(pts);
    const ratio = Math.abs(Ipa / Ipc);
    expect(ratio).toBeGreaterThanOrEqual(0.6);
    expect(ratio).toBeLessThanOrEqual(0.95);
  });

  it("Ipeak scales linearly with concentration", () => {
    const p1 = peakStats(simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, cMM: 1 }));
    const p2 = peakStats(simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, cMM: 2 }));
    const r = Math.abs(p2.Ipc / p1.Ipc);
    expect(r).toBeGreaterThan(1.7);
    expect(r).toBeLessThan(2.3);
  });

  it("Ipeak scales with √(scan rate)", () => {
    const slow = peakStats(simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, scanRate_mVs: 50 }));
    const fast = peakStats(simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, scanRate_mVs: 200 }));
    const r = Math.abs(fast.Ipa / slow.Ipa);
    expect(r).toBeGreaterThan(1.6);
    expect(r).toBeLessThan(2.4);
  });

  it("C = 0 mM produces zero faradaic current with no NaN", () => {
    const pts = simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, cMM: 0 });
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) {
      expect(Number.isFinite(p.I)).toBe(true);
      expect(p.I).toBe(0);
    }
  });

  it("invalid params return [] instead of crashing", () => {
    expect(simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, scanRate_mVs: 0 })).toEqual([]);
    expect(simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, n: 0 })).toEqual([]);
    expect(simulateReversibleDiffusionCV({ ...SOLVER_DEFAULTS, areaCm2: -1 })).toEqual([]);
  });

  it("quasi-reversible simulator still works (not broken by reversible refactor)", () => {
    const pts = buildCVPointsForTest({ ...DEFAULT_CV_PARAMS, cvModel: "quasi-reversible" });
    expect(pts.length).toBeGreaterThan(50);
    for (const p of pts) expect(Number.isFinite(p.I)).toBe(true);
  });
});