import { describe, it, expect } from "vitest";
import { fitEIS } from "@/utils/eisFit";
import { splitRegionsAuto } from "@/utils/randlesFit";
import { evaluateDummyCell } from "@/utils/dummyCellCheck";
import type { EISDataPoint } from "@/hooks/useSimulatedData";

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

/** Randles + CPE spectrum: Z = Rs + 1/(1/Rct + Q(jw)^n) — same model fitEIS fits. */
function cpeSpectrum(
  Rs: number, Rct: number, Q: number, n: number, seed: number,
  noiseAmp = 2, npts = 43, fmin = 0.1, fmax = 1e5,
): EISDataPoint[] {
  const rnd = rng(seed);
  const out: EISDataPoint[] = [];
  for (let i = 0; i < npts; i++) {
    const f = Math.pow(10, Math.log10(fmax) - (i / (npts - 1)) * (Math.log10(fmax) - Math.log10(fmin)));
    const w = 2 * Math.PI * f;
    const a = (n * Math.PI) / 2;
    const wn = Math.pow(w, n);
    const ycRe = Q * wn * Math.cos(a);
    const ycIm = Q * wn * Math.sin(a);
    const yRe = 1 / Rct + ycRe;
    const yIm = ycIm;
    const m2 = yRe * yRe + yIm * yIm;
    let zReal = Rs + yRe / m2 + (rnd() - 0.5) * noiseAmp;
    let zImag = -yIm / m2 + (rnd() - 0.5) * noiseAmp;
    zReal = Math.round(zReal * 10) / 10;
    zImag = Math.round(zImag * 10) / 10;
    out.push({ zReal, zImag, frequency: f, zMag: Math.hypot(zReal, zImag), phase: 0 });
  }
  return out;
}

describe("Randles + CPE recovery (the third circuit, unvalidated until now)", () => {
  const Rs = 200, Rct = 300, n = 0.9;
  const f0 = 24; // Hz, same target as the earlier Randles/Warburg default
  const Q = Math.pow(2 * Math.PI * f0, -n) / Rct;

  it("is exact on a noise-free spectrum", () => {
    const clean = cpeSpectrum(Rs, Rct, Q, n, 1, 0);
    const fit = fitEIS(clean, "randles-cpe", clean)!;
    expect(fit.converged).toBe(true);
    expect(fit.params.Rs).toBeCloseTo(Rs, 2);
    expect(fit.params.Rct).toBeCloseTo(Rct, 2);
    expect(Math.abs(fit.params.n - n)).toBeLessThan(1e-3);
    expect(Math.abs(fit.params.Q - Q) / Q).toBeLessThan(1e-3);
  });

  it("recovers Rs, Rct, Q and n within 0.1% with the simulator's own noise (8 runs)", () => {
    const rs: number[] = [], rct: number[] = [], q: number[] = [], nn: number[] = [];
    for (let s = 1; s <= 8; s++) {
      const d = cpeSpectrum(Rs, Rct, Q, n, s * 111);
      const fit = fitEIS(d, "randles-cpe", d)!;
      expect(fit.converged).toBe(true);
      rs.push(fit.params.Rs); rct.push(fit.params.Rct); q.push(fit.params.Q); nn.push(fit.params.n);
    }
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(Math.abs(mean(rs) - Rs) / Rs).toBeLessThan(0.001);
    expect(Math.abs(mean(rct) - Rct) / Rct).toBeLessThan(0.001);
    expect(Math.abs(mean(q) - Q) / Q).toBeLessThan(0.001);
    expect(Math.abs(mean(nn) - n) / n).toBeLessThan(0.001);
  });
});

describe("Dummy-cell check (the pre-session instrument sanity test)", () => {
  const Rs = 200, Rct = 500, Cdl = 15e-6; // an RC test circuit — no diffusion element
  const expected = { rsOhm: Rs, rctOhm: Rct, cdlF: Cdl };

  function dummySpectrum(seed: number, gainErr = 1, noiseAmp = 2): EISDataPoint[] {
    const rnd = rng(seed);
    const npts = 43, fmin = 0.1, fmax = 1e5;
    const out: EISDataPoint[] = [];
    for (let i = 0; i < npts; i++) {
      const f = Math.pow(10, Math.log10(fmax) - (i / (npts - 1)) * (Math.log10(fmax) - Math.log10(fmin)));
      const w = 2 * Math.PI * f;
      const dRe = 1, dIm = w * Rct * Cdl;
      const m2 = dRe * dRe + dIm * dIm;
      let zReal = (Rs + (Rct * dRe) / m2) * gainErr + (rnd() - 0.5) * noiseAmp;
      let zImag = (-(Rct * dIm) / m2) * gainErr + (rnd() - 0.5) * noiseAmp;
      zReal = Math.round(zReal * 10) / 10;
      zImag = Math.round(zImag * 10) / 10;
      out.push({ zReal, zImag, frequency: f, zMag: Math.hypot(zReal, zImag), phase: 0 });
    }
    return out;
  }

  function fitDummy(data: EISDataPoint[]) {
    const split = splitRegionsAuto(data);
    const semi = split.semicircle.length >= 5 ? split.semicircle : data;
    const fit = fitEIS(semi, "randles", data)!;
    return { Rs: fit.params.Rs, Rct: fit.params.Rct, Cdl: fit.params.Cdl };
  }

  it("passes green on a working pipeline (5 runs)", () => {
    for (let s = 1; s <= 5; s++) {
      const measured = fitDummy(dummySpectrum(s * 77));
      const result = evaluateDummyCell(measured, expected);
      expect(result.overall).toBe("green");
    }
  });

  it("catches a 40% gain fault (e.g. a wrong RTIA-gain setting) as red on every parameter", () => {
    for (let s = 1; s <= 3; s++) {
      const measured = fitDummy(dummySpectrum(s * 77, 1.4));
      const result = evaluateDummyCell(measured, expected);
      expect(result.rs.verdict).toBe("red");
      expect(result.rct.verdict).toBe("red");
      expect(result.cdl.verdict).toBe("red");
      expect(result.overall).toBe("red");
      // The scaling is roughly what a 40% gain error should produce.
      expect(Math.abs(result.rs.errorPct - 40)).toBeLessThan(2);
      expect(Math.abs(result.rct.errorPct - 40)).toBeLessThan(2);
    }
  });
});
