import { describe, it, expect } from "vitest";
import { computeFETTransferMetrics } from "@/utils/fetMetrics";
import { fitLangmuirNLLS, computeLOD } from "@/components/CalibrationPanel";
import { fetPair, mean } from "./fetSimHelper";

/**
 * BioFET calibration through the whole pipeline (simulated transfer curves ->
 * Vt extraction -> shift -> the calibration panel's Langmuir fit and LOD), with
 * the same series layout as EIS: three blanks and six concentrations from 6.25
 * to 200 nM around the simulated Kd of 25 nM. True Smax = 400 mV.
 * Thesis Figure 17 and Table 16.
 */
const CONCS = [0, 0, 0, 6.25, 12.5, 25, 50, 100, 200];

function series(noise: boolean, seed0: number) {
  const pts = CONCS.map((c, i) => {
    const p = fetPair(c, seed0 + i, { noise });
    const m = computeFETTransferMetrics(p.baseline, p.analyte, { responseMode: "signed" });
    return { concentration: c, signal: m.calibrationSignal_mV_used!, raw: m.vtAnalyte!, timestamp: i };
  });
  const fit = fitLangmuirNLLS(pts)!;
  const lod = computeLOD(pts, "fet", fit.sMax / fit.kd);
  return { pts, fit, lod };
}

describe("BioFET calibration recovers the simulated Langmuir isotherm", () => {
  it("noise-free: exact-looking fit (R2 > 0.99999) with Kd and Smax within 3 % of 25 nM and 400 mV", () => {
    const { fit, lod } = series(false, 1);
    expect(fit.converged).toBe(true);
    expect(fit.r2).toBeGreaterThan(0.99999);
    expect(Math.abs(fit.kd / 25 - 1)).toBeLessThan(0.03);
    expect(Math.abs(fit.sMax / 400 - 1)).toBeLessThan(0.03);
    // the extraction bias makes Smax come out low, not high
    expect(fit.sMax).toBeLessThan(400);
    expect(lod?.sigmaSource).toBe("replicates");
  });

  it("with the simulator's noise, 8 series: Kd 20-26 nM, Smax 375-400 mV, R2 above 0.98, sub- to low-nM LOD", () => {
    const runs = Array.from({ length: 8 }, (_, k) => series(true, 1000 + 100 * k));
    expect(runs.every((r) => r.fit.converged)).toBe(true);
    const kd = mean(runs.map((r) => r.fit.kd));
    const smax = mean(runs.map((r) => r.fit.sMax));
    expect(kd).toBeGreaterThan(20);
    expect(kd).toBeLessThan(26);
    expect(smax).toBeGreaterThan(375);
    expect(smax).toBeLessThan(400);
    expect(mean(runs.map((r) => r.fit.r2))).toBeGreaterThan(0.98);
    const lod = mean(runs.map((r) => r.lod!.value));
    expect(lod).toBeGreaterThan(0.5);
    expect(lod).toBeLessThan(2);
    expect(runs.every((r) => r.lod!.loq > r.lod!.value)).toBe(true);
  });
});
