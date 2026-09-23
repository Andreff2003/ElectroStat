import { describe, it, expect } from "vitest";
import { fitEIS } from "@/utils/eisFit";
import type { EISDataPoint } from "@/hooks/useSimulatedData";

/**
 * How far the Table-4 "Residual Noise" thresholds (green <=3%, yellow <=8%)
 * sit from where the CNLS fit itself actually starts to drift, on the
 * default blank spectrum with Randles + Warburg. See
 * scratchpad noise_robustness.png in the thesis for the full sweep and
 * Figure 12 in the thesis for the version used there.
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
function spectrum(noiseAmp: number, seed: number, n = 43, fmin = 0.1, fmax = 1e5): EISDataPoint[] {
  const rnd = rng(seed);
  const aw = 80, rct = 300;
  const out: EISDataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const f = Math.pow(10, Math.log10(fmax) - (i / (n - 1)) * (Math.log10(fmax) - Math.log10(fmin)));
    const w = 2 * Math.PI * f;
    const wm = aw / Math.sqrt(w);
    const zfRe = rct + wm, zfIm = -wm;
    const m2 = zfRe * zfRe + zfIm * zfIm;
    const yRe = zfRe / m2, yIm = -zfIm / m2 + w * 20e-6;
    const y2 = yRe * yRe + yIm * yIm;
    let zReal = 200 + yRe / y2 + (rnd() - 0.5) * noiseAmp;
    let zImag = -yIm / y2 + (rnd() - 0.5) * noiseAmp;
    zReal = Math.round(zReal * 10) / 10;
    zImag = Math.round(zImag * 10) / 10;
    out.push({ zReal, zImag, frequency: f, zMag: Math.hypot(zReal, zImag), phase: 0 });
  }
  return out;
}

function residualAndRctErr(noiseAmp: number, runs: number, seedBase: number) {
  const resid: number[] = [];
  const rctErr: number[] = [];
  for (let s = 1; s <= runs; s++) {
    const d = spectrum(noiseAmp, seedBase + s);
    const fit = fitEIS(d, "randles-warburg", d)!;
    resid.push(Math.sqrt(Math.max(fit.chiSquared, 0)) * 100);
    rctErr.push(Math.abs(100 * (fit.params.Rct - 300) / 300));
  }
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  return { resid: mean(resid), rctErr: mean(rctErr) };
}

describe("EIS noise robustness vs the Table 4 Residual Noise thresholds", () => {
  it("the default simulated noise (+-1 Ohm) sits deep in the green band", () => {
    const { resid } = residualAndRctErr(2, 10, 1000);
    expect(resid).toBeLessThan(1); // green threshold is 3%
  });

  it("Rct stays reasonably accurate through the whole green and yellow bands", () => {
    for (const amp of [8, 16, 32, 48]) {
      const { resid, rctErr } = residualAndRctErr(amp, 10, 2000 + amp);
      expect(resid).toBeLessThan(8); // still green or yellow
      expect(rctErr).toBeLessThan(3); // a few % at worst, run-to-run noise included
    }
  });

  it("crosses into the red band only well past the default noise, where Rct error becomes appreciable", () => {
    const { resid, rctErr } = residualAndRctErr(96, 10, 5000);
    expect(resid).toBeGreaterThan(8); // red threshold
    expect(rctErr).toBeGreaterThan(0.5);
  });
});
