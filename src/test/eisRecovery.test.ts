import { describe, it, expect } from "vitest";
import { fitEIS, fitRegionFor } from "@/utils/eisFit";
import { splitRegionsAuto } from "@/utils/randlesFit";
import type { EISDataPoint } from "@/hooks/useSimulatedData";

/**
 * Noise-free Randles spectrum with a Warburg element, same equations as the
 * simulator (Rs = 200 Ω, Cdl = 20 µF, Zw = Aw/√ω·(1 − j) in series with Rct).
 * The default sweep is 43 points, 0.1 Hz – 100 kHz (7 points per decade).
 */
function spectrum(aw: number, rct = 300, n = 43, fmin = 0.1, fmax = 1e5): EISDataPoint[] {
  const out: EISDataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const f = Math.pow(10, Math.log10(fmax) - (i / (n - 1)) * (Math.log10(fmax) - Math.log10(fmin)));
    const w = 2 * Math.PI * f;
    const wm = aw / Math.sqrt(w);
    const zfRe = rct + wm;
    const zfIm = -wm;
    const m2 = zfRe * zfRe + zfIm * zfIm;
    const yRe = zfRe / m2;
    const yIm = -zfIm / m2 + w * 20e-6;
    const y2 = yRe * yRe + yIm * yIm;
    const zReal = 200 + yRe / y2;
    const zImag = -yIm / y2;
    out.push({ zReal, zImag, frequency: f, zMag: Math.hypot(zReal, zImag), phase: 0 });
  }
  return out;
}

function fitAuto(data: EISDataPoint[]) {
  const split = splitRegionsAuto(data);
  const semi = split.semicircle.length >= 5 ? split.semicircle : data;
  const fit = fitEIS(semi, "randles", data);
  if (!fit) throw new Error("fit failed");
  return { fit, nSemi: semi.length };
}

describe("EIS CNLS recovery on the default 43-point blank sweep", () => {
  it("is exact when the spectrum has no Warburg element (implementation check)", () => {
    const { fit } = fitAuto(spectrum(0));
    expect(fit.params.Rs).toBeCloseTo(200, 3);
    expect(fit.params.Rct).toBeCloseTo(300, 3);
    expect(fit.params.Cdl * 1e6).toBeCloseTo(20, 3);
  });

  it("with the simulator's Warburg (80 Ω/√s) Rs is exact and Rct/Cdl carry a deterministic offset", () => {
    // The Randles model has no Warburg term, so Re(Zw) leaks into Rct: this is
    // a model mismatch, not noise (it is reproducible to the last digit).
    const { fit, nSemi } = fitAuto(spectrum(80));
    expect(nSemi).toBe(36);
    expect(Math.abs(fit.params.Rs - 200)).toBeLessThan(0.5);
    expect(fit.params.Rct).toBeGreaterThan(316);
    expect(fit.params.Rct).toBeLessThan(318);
    expect(fit.params.Cdl * 1e6).toBeGreaterThan(20.5);
    expect(fit.params.Cdl * 1e6).toBeLessThan(20.9);
  });
});

/** Same noise as the simulator: ±1 Ω uniform on Z' and Z'', values rounded to 0.1 Ω. */
function noisySpectrum(aw: number, rct: number, seed: number): EISDataPoint[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return spectrum(aw, rct).map((p) => {
    const zReal = Math.round((p.zReal + (rnd() - 0.5) * 2) * 10) / 10;
    const zImag = Math.round((p.zImag + (rnd() - 0.5) * 2) * 10) / 10;
    return { ...p, zReal, zImag, zMag: Math.hypot(zReal, zImag) };
  });
}

describe("Randles + Warburg model", () => {
  it("fits the whole spectrum, the Randles models only the semicircle", () => {
    const full = spectrum(80);
    const semi = full.slice(0, 36);
    expect(fitRegionFor("randles-warburg", semi, full)).toBe(full);
    expect(fitRegionFor("randles", semi, full)).toBe(semi);
    expect(fitRegionFor("randles-cpe", semi, full)).toBe(semi);
  });

  it("recovers Rs, Rct, Cdl and Aw exactly on a noise-free spectrum", () => {
    for (const rct of [300, 800]) {
      const fit = fitEIS(spectrum(80, rct), "randles-warburg", spectrum(80, rct))!;
      expect(fit.params.Rs).toBeCloseTo(200, 1);
      expect(Math.abs(fit.params.Rct - rct) / rct).toBeLessThan(5e-4);
      expect(Math.abs(fit.params.Cdl * 1e6 - 20)).toBeLessThan(0.01);
      expect(Math.abs(fit.params.Aw - 80)).toBeLessThan(0.2);
    }
  });

  it("removes the Warburg offset that the plain Randles fit leaves in Rct (simulator noise)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const data = noisySpectrum(80, 300, seed);
      const fit = fitEIS(data, "randles-warburg", data)!;
      expect(fit.converged).toBe(true);
      expect(Math.abs(fit.params.Rct - 300) / 300).toBeLessThan(0.01); // was +5.4 % without the Warburg term
      expect(Math.abs(fit.params.Rs - 200) / 200).toBeLessThan(0.005);
      expect(Math.abs(fit.params.Cdl * 1e6 - 20) / 20).toBeLessThan(0.02);
      expect(Math.abs(fit.params.Aw - 80) / 80).toBeLessThan(0.05);
    }
  });
});
