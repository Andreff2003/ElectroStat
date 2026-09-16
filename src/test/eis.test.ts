import { describe, it, expect } from "vitest";
import {
  fitRandles,
  extractWarburgSlope,
  kramersKronigTest,
} from "@/utils/randlesFit";
import { fitEIS } from "@/utils/eisFit";
import { linKKTest } from "@/utils/linKK";
import type { EISDataPoint } from "@/hooks/useSimulatedData";
import {
  fitLangmuirNLLS,
  computeLOD,
  type CalibrationPoint,
} from "@/components/CalibrationPanel";

const TWO_PI = 2 * Math.PI;

/** Generate synthetic Randles (Rs + Rct||Cdl) EIS data. */
function synthRandles(
  Rs: number, Rct: number, Cdl: number,
  fMin = 0.1, fMax = 1e5, n = 40,
): EISDataPoint[] {
  const out: EISDataPoint[] = [];
  const logMin = Math.log10(fMin), logMax = Math.log10(fMax);
  for (let i = 0; i < n; i++) {
    const f = Math.pow(10, logMax - (i * (logMax - logMin)) / (n - 1));
    const w = TWO_PI * f;
    // Rct / (1 + jωRctCdl)
    const dRe = 1, dIm = w * Rct * Cdl;
    const m2 = dRe * dRe + dIm * dIm;
    const zReal = Rs + (Rct * dRe) / m2;
    const zImag = -(Rct * dIm) / m2;          // capacitive → negative Im(Z)
    out.push({
      zReal, zImag, frequency: f,
      zMag: Math.sqrt(zReal * zReal + zImag * zImag),
      phase: Math.atan2(zImag, zReal) * 180 / Math.PI,
    });
  }
  return out;
}

/** Pure Warburg tail: Z = Rs + Aw/√ω (1 − j). */
function synthWarburg(Rs: number, Aw: number, fMin = 0.01, fMax = 1, n = 25): EISDataPoint[] {
  const out: EISDataPoint[] = [];
  const logMin = Math.log10(fMin), logMax = Math.log10(fMax);
  for (let i = 0; i < n; i++) {
    const f = Math.pow(10, logMax - (i * (logMax - logMin)) / (n - 1));
    const w = TWO_PI * f;
    const t = Aw / Math.sqrt(w);
    const zReal = Rs + t;
    const zImag = -t; // -j component
    out.push({
      zReal, zImag, frequency: f,
      zMag: Math.sqrt(zReal * zReal + zImag * zImag),
      phase: Math.atan2(zImag, zReal) * 180 / Math.PI,
    });
  }
  return out;
}

describe("EIS — randles manual fit recovers parameters", () => {
  it("fitRandles xs/ys alignment: recovers Rs/Rct/Cdl within tolerance", () => {
    const Rs = 100, Rct = 800, Cdl = 5e-6;
    const data = synthRandles(Rs, Rct, Cdl, 1, 1e5, 35);
    const fit = fitRandles(data, data);
    expect(fit).toBeTruthy();
    // Tight on Rs/Rct (semicircle is fully observed); Cdl looser.
    expect(Math.abs(fit!.Rs - Rs) / Rs).toBeLessThan(0.2);
    expect(Math.abs(fit!.Rct - Rct) / Rct).toBeLessThan(0.2);
    expect(fit!.Cdl).toBeGreaterThan(1e-7);
    expect(fit!.Cdl).toBeLessThan(1e-4);
  });
});

describe("EIS — CNLS Randles", () => {
  it("fitEIS recovers Rs/Rct/Cdl", () => {
    const Rs = 50, Rct = 1200, Cdl = 2e-6;
    const data = synthRandles(Rs, Rct, Cdl, 1, 1e5, 40);
    const r = fitEIS(data, "randles");
    expect(r).toBeTruthy();
    expect(Math.abs(r!.params.Rs - Rs) / Rs).toBeLessThan(0.1);
    expect(Math.abs(r!.params.Rct - Rct) / Rct).toBeLessThan(0.1);
    expect(r!.fitFreqRange?.min).toBeGreaterThan(0);
    expect(r!.weightedSsrPerDof).toBe(r!.chiSquared);
  });

  it("CPE model returns plausible n in bounds", () => {
    const Rs = 100, Rct = 500, Cdl = 1e-5;
    const data = synthRandles(Rs, Rct, Cdl);
    const r = fitEIS(data, "randles-cpe");
    expect(r).toBeTruthy();
    expect(r!.params.n).toBeGreaterThanOrEqual(0.3);
    expect(r!.params.n).toBeLessThanOrEqual(1.0);
  });
});

describe("EIS — Warburg regression", () => {
  it("extractWarburgSlope recovers Aw by 1/√ω regression with intercept", () => {
    const Rs = 50, Aw = 25;
    const data = synthWarburg(Rs, Aw, 0.01, 1, 25);
    const wb = extractWarburgSlope(data);
    expect(wb.ok).toBe(true);
    expect(wb.method).toBe("regression_1_sqrt_omega_with_intercept");
    expect(Math.abs(wb.Aw! - Aw) / Aw).toBeLessThan(0.05);
    expect(wb.slope!).toBeGreaterThan(0.8);
    expect(wb.slope!).toBeLessThan(1.2);
    expect(wb.r2Imag!).toBeGreaterThan(0.99);
    expect(typeof wb.interceptImag).toBe("number");
    // Pure Warburg → intercept should be small relative to Aw
    expect(Math.abs(wb.interceptImag!)).toBeLessThan(Aw);
  });

  it("returns warnings array when tail is too short", () => {
    const wb = extractWarburgSlope([]);
    expect(wb.ok).toBe(false);
    expect(wb.warnings && wb.warnings.length).toBeGreaterThan(0);
  });
});

describe("EIS — KK approximate residual labelling", () => {
  it("returns method=approximate_residual on success and failure", () => {
    const data = synthRandles(100, 800, 5e-6);
    const k = kramersKronigTest(data);
    expect(k.method).toBe("approximate_residual");
    const empty = kramersKronigTest([]);
    expect(empty.method).toBe("approximate_residual");
  });
});

describe("EIS — Lin-KK validation", () => {
  it("Lin-KK passes on clean synthetic Randles spectrum", () => {
    const data = synthRandles(100, 800, 5e-6, 0.1, 1e5, 40);
    const lk = linKKTest(data);
    expect(lk.method).toBe("lin-kk-inspired");
    expect(lk.passed).toBe(true);
    expect(lk.residualRmsPct).toBeLessThan(5);
    expect(lk.tauCount).toBeGreaterThanOrEqual(8);
  });

  it("Lin-KK flags strongly perturbed spectra", () => {
    const clean = synthRandles(100, 800, 5e-6, 0.1, 1e5, 40);
    // Inject large multiplicative drift to violate KK consistency
    const dirty = clean.map((d, i) => ({
      ...d,
      zReal: d.zReal * (1 + 0.5 * Math.sin(i)),
      zImag: d.zImag * (1 + 0.5 * Math.cos(i * 1.3)) + 200 * Math.sin(i * 0.7),
    }));
    const lk = linKKTest(dirty);
    expect(lk.residualRmsPct).toBeGreaterThan(5);
  });

  it("Lin-KK returns informational result for too-few points", () => {
    const lk = linKKTest([]);
    expect(lk.passed).toBe(false);
    expect(lk.warnings.length).toBeGreaterThan(0);
  });
});

describe("EIS — covariance in log-space (no false ill-conditioning)", () => {
  it("Randles fit with disparate parameter scales reports finite SE%", () => {
    // Rs ~100 Ω, Rct ~800 Ω, Cdl ~5e-6 F — the previous natural-space
    // covariance triggered an ill-conditioned matrix on this case.
    const data = synthRandles(100, 800, 5e-6, 1, 1e5, 40);
    const r = fitEIS(data, "randles");
    expect(r).toBeTruthy();
    expect(r!.covarianceWarning).toBe(false);
    expect(Number.isFinite(r!.errors.Rs)).toBe(true);
    expect(Number.isFinite(r!.errors.Rct)).toBe(true);
    expect(Number.isFinite(r!.errors.Cdl)).toBe(true);
    expect(r!.covarianceMethod).toBe("log_space");
  });
});

describe("EIS calibration — Langmuir fit, LOD/LOQ", () => {
  // Same Langmuir shape and constants the app's own EIS simulator uses
  // (KD=25 nM, ΔRct saturating around 500 Ω over a 300 Ω baseline Rct —
  // see useSimulatedData.ts). Mirrors cv.test.ts's calibration block: 3
  // baseline replicates (with small jitter, so sigma comes from
  // "replicates" not the 2%-baseline fallback) plus duplicate
  // measurements at 3 concentrations spanning into saturation.
  const KD_NM = 25;
  const SMAX_OHM = 500;
  const RCT_BASELINE = 300;
  const concentrations = [0, 0, 0, 10, 10, 50, 50, 200, 200];
  const baselineJitterOhm = [-1, 0, 1];

  function makePoints(): CalibrationPoint[] {
    let blankIdx = 0;
    return concentrations.map((c, i) => {
      const deltaRct = c === 0 ? 0 : (SMAX_OHM * c) / (c + KD_NM);
      const jitter = c === 0 ? baselineJitterOhm[blankIdx++] : 0;
      return {
        concentration: c,
        signal: deltaRct,
        raw: RCT_BASELINE + deltaRct + jitter,
        timestamp: Date.now() + i,
      };
    });
  }

  it("recovers Kd/Smax from a clean synthetic Langmuir series", () => {
    const pts = makePoints();
    const fit = fitLangmuirNLLS(
      pts.map((p) => ({ concentration: p.concentration, signal: p.signal })),
    );
    expect(fit).not.toBeNull();
    expect(fit!.kd).toBeCloseTo(KD_NM, 0);
    expect(fit!.sMax).toBeCloseTo(SMAX_OHM, -1);
    expect(fit!.r2).toBeGreaterThan(0.98);
  });

  it("computes finite LOD < LOQ from the Langmuir low-concentration slope", () => {
    const pts = makePoints();
    const fit = fitLangmuirNLLS(
      pts.map((p) => ({ concentration: p.concentration, signal: p.signal })),
    );
    expect(fit).not.toBeNull();
    const slope = fit!.sMax / fit!.kd;
    const result = computeLOD(pts, "eis", slope);
    expect(result).not.toBeNull();
    expect(result!.sigmaSource).toBe("replicates");
    expect(Number.isFinite(result!.value)).toBe(true);
    expect(Number.isFinite(result!.loq)).toBe(true);
    expect(result!.value).toBeGreaterThan(0);
    expect(result!.loq).toBeGreaterThan(result!.value); // 10σ > 3σ
  });

  it("returns null when no slope is available (too few points for a Langmuir fit)", () => {
    const pts = makePoints().slice(0, 2);
    expect(computeLOD(pts, "eis", null)).toBeNull();
  });

  // Regression guard for the bug fixed in CalibrationPanel.tsx: LOD/LOQ
  // must come from the Langmuir curve's initial slope (Smax/Kd), not from
  // a straight line fit across the whole range. A plain regression line
  // through points that span into saturation is much shallower than the
  // true low-concentration sensitivity, which understates it and inflates
  // LOD. Compare against the secant from the origin to the most-saturated
  // point, which approximates what that old straight-line fit produced.
  it("the Langmuir low-concentration slope is markedly steeper than the whole-range secant", () => {
    const pts = makePoints();
    const fit = fitLangmuirNLLS(
      pts.map((p) => ({ concentration: p.concentration, signal: p.signal })),
    );
    expect(fit).not.toBeNull();
    const langmuirSlope = fit!.sMax / fit!.kd;
    const maxC = Math.max(...concentrations);
    const secantSlope = fit!.sMax / (maxC + fit!.kd);
    expect(langmuirSlope).toBeGreaterThan(secantSlope * 2);
  });
});
