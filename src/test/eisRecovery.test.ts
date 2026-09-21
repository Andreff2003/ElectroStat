import { describe, it, expect } from "vitest";
import { fitEIS } from "@/utils/eisFit";
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
