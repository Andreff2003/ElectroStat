import { describe, it, expect } from "vitest";
import { fitEIS } from "@/utils/eisFit";
import { splitRegionsAuto } from "@/utils/randlesFit";
import { fitLangmuirNLLS } from "@/components/CalibrationPanel";
import type { EISDataPoint } from "@/hooks/useSimulatedData";

/**
 * End-to-end validation of the EIS calibration pipeline against the
 * simulator's own Langmuir binding law (RCT_MIN=300, RCT_MAX=800, KD=25 nM
 * in useSimulatedData.ts, same noise as the app: +-1 Ohm uniform on Re/Im).
 * Complements eisRecovery.test.ts, which only checks a single (blank)
 * spectrum: this checks that Rct actually rises with concentration and that
 * the Kd/Smax the calibration panel reports (fitLangmuirNLLS) match the
 * values the simulator was built from.
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
function spectrum(concentration: number, seed: number, n = 43, fmin = 0.1, fmax = 1e5): EISDataPoint[] {
  const rnd = rng(seed);
  const rct = 300 + (800 - 300) * concentration / (concentration + 25);
  const aw = 80;
  const out: EISDataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const f = Math.pow(10, Math.log10(fmax) - (i / (n - 1)) * (Math.log10(fmax) - Math.log10(fmin)));
    const w = 2 * Math.PI * f;
    const wm = aw / Math.sqrt(w);
    const zfRe = rct + wm, zfIm = -wm;
    const m2 = zfRe * zfRe + zfIm * zfIm;
    const yRe = zfRe / m2, yIm = -zfIm / m2 + w * 20e-6;
    const y2 = yRe * yRe + yIm * yIm;
    let zReal = 200 + yRe / y2 + (rnd() - 0.5) * 2;
    let zImag = -yIm / y2 + (rnd() - 0.5) * 2;
    zReal = Math.round(zReal * 10) / 10;
    zImag = Math.round(zImag * 10) / 10;
    out.push({ zReal, zImag, frequency: f, zMag: Math.hypot(zReal, zImag), phase: 0 });
  }
  return out;
}

function fitRct(data: EISDataPoint[], model: "randles" | "randles-warburg"): number {
  if (model === "randles-warburg") return fitEIS(data, "randles-warburg", data)!.params.Rct;
  const split = splitRegionsAuto(data);
  const semi = split.semicircle.length >= 5 ? split.semicircle : data;
  return fitEIS(semi, "randles", data)!.params.Rct;
}

const CONCS = [0, 0, 0, 6.25, 12.5, 25, 50, 100, 200]; // nM, 3 blanks + 6 spanning Kd=25

function runOnce(model: "randles" | "randles-warburg", seedBase: number) {
  const rows = CONCS.map((c, i) => ({ c, rct: fitRct(spectrum(c, seedBase + i), model) }));
  const blanks = rows.filter((r) => r.c === 0).map((r) => r.rct);
  const blankMean = blanks.reduce((a, b) => a + b, 0) / blanks.length;
  const points = rows
    .filter((r) => r.c > 0)
    .map((r) => ({ concentration: r.c, signal: r.rct - blankMean }));
  return { rows, langmuir: fitLangmuirNLLS(points) };
}

describe("EIS calibration pipeline recovers the simulator's binding law", () => {
  it("Rct rises monotonically with concentration (Randles + Warburg fit)", () => {
    const { rows } = runOnce("randles-warburg", 1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].rct).toBeGreaterThanOrEqual(rows[i - 1].rct - 3); // 3 Ohm ~ noise floor
    }
    expect(rows[rows.length - 1].rct).toBeGreaterThan(rows[0].rct + 300); // clearly saturating
  });

  it("Randles + Warburg calibration recovers Kd and Smax essentially exactly", () => {
    const kd: number[] = [];
    const sMax: number[] = [];
    for (let run = 1; run <= 8; run++) {
      const { langmuir } = runOnce("randles-warburg", run * 100);
      expect(langmuir?.converged).toBe(true);
      kd.push(langmuir!.kd);
      sMax.push(langmuir!.sMax);
    }
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(Math.abs(mean(kd) - 25) / 25).toBeLessThan(0.02); // true Kd = 25 nM
    expect(Math.abs(mean(sMax) - 500) / 500).toBeLessThan(0.02); // true Smax = 800-300 Ohm
  });

  it("the plain Randles (semicircle-only) fit still recovers a usable calibration, despite its Rct bias", () => {
    // The Warburg-in-Rct offset is roughly constant across concentration, so it
    // largely cancels in the DIFFERENCE (signal - blank) the calibration uses,
    // even though the absolute Rct values are individually biased (+5% at the
    // blank — see eisRecovery.test.ts).
    const kd: number[] = [];
    const sMax: number[] = [];
    for (let run = 1; run <= 8; run++) {
      const { langmuir } = runOnce("randles", run * 100);
      expect(langmuir?.converged).toBe(true);
      kd.push(langmuir!.kd);
      sMax.push(langmuir!.sMax);
    }
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(Math.abs(mean(kd) - 25) / 25).toBeLessThan(0.1);
    expect(Math.abs(mean(sMax) - 500) / 500).toBeLessThan(0.1);
  });
});
