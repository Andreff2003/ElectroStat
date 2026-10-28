import { describe, it, expect } from "vitest";
import { computeCVMetrics } from "@/utils/computeCVMetrics";
import { analyzeSWV } from "@/utils/swvMetrics";
import {
  buildCVExportText,
  buildFETExportText,
  buildSWVExportText,
  buildSessionExportText,
} from "@/utils/csvExport";
import { parseImportedCsv } from "@/utils/csvImport";
import { buildCVPointsForTest, DEFAULT_CV_PARAMS, type CVDataPoint } from "@/hooks/useSimulatedCVData";
import type { SWVDataPoint, SWVParameters } from "@/types/swv";
import type { StoredCVMeasurement } from "@/utils/sessionStore";

/**
 * The AD5941 flags a point whose HSTIA output left its ADC window: the current there is clipped. The exports say
 * which points, and a peak at or next to such points is marked as not reliable (a CV at 100 mV/s clipped at
 * 300 uA gave Ipa = 343 uA and Epa = 0.304 V, with no warning).
 */

const CLIP = 300;
const INPUT = { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 };

/** The simulated ferri/ferrocyanide CV, scaled by `gain` and clipped at +-300 uA, the clipped points flagged. */
function clippedCv(gain: number): CVDataPoint[] {
  return buildCVPointsForTest({ ...DEFAULT_CV_PARAMS, cvModel: "reversible" as const }).map((p) => {
    const I = p.I * gain;
    const clipped = Math.abs(I) >= CLIP;
    return { ...p, I: clipped ? Math.sign(I) * CLIP : I, ...(clipped ? { outOfRange: true } : {}) };
  });
}

describe("a CV clipped at 300 uA", () => {
  it("a peak at the clip is marked not reliable, with a warning that says what to do", () => {
    const data = clippedCv(6);                                   // peaks of about 480 uA
    expect(data.filter((p) => p.outOfRange).length).toBeGreaterThan(5);
    const m = computeCVMetrics(data, INPUT)!;
    expect(m.hasAnodic).toBe(true);
    expect(m.IpaValid).toBe(false);
    expect(m.IpcValid).toBe(false);
    expect(m.warnings).toContain("peak current outside the ADC window: Ipa/Ipc not reliable, use a lower RTIA");
  });

  it("only the anodic peak flagged: only it is not reliable", () => {
    const data = clippedCv(1).map((p) => (p.I > 0 && p.E > 0.2 && p.E < 0.3 ? { ...p, outOfRange: true } : p));
    const m = computeCVMetrics(data, INPUT)!;
    expect(m.IpaValid).toBe(false);
    expect(m.IpcValid).toBe(true);
    expect(m.warnings).toContain("peak current outside the ADC window: Ipa not reliable, use a lower RTIA");
  });

  it("a flagged point more than 20 mV from the peak does not matter", () => {
    const clean = computeCVMetrics(clippedCv(1), INPUT)!;
    const far = clippedCv(1).map((p, i) => (i === 5 ? { ...p, outOfRange: true } : p));   // the start of the scan, far from both peaks
    const m = computeCVMetrics(far, INPUT)!;
    expect(far[5].outOfRange).toBe(true);
    expect(Math.abs(far[5].E - clean.Epa) * 1000).toBeGreaterThan(20);
    expect(m.IpaValid).toBe(true);
    expect(m.IpcValid).toBe(true);
    expect(m.warnings.some((w) => /outside the ADC window/.test(w))).toBe(false);
  });

  it("an unflagged CV has no warning and valid peaks", () => {
    const m = computeCVMetrics(clippedCv(1), INPUT)!;
    expect(m.IpaValid).toBe(true);
    expect(m.warnings.some((w) => /outside the ADC window/.test(w))).toBe(false);
  });

  it("the export has a per-point out_of_range column and the processed results mark the peaks", () => {
    const data = clippedCv(6);
    const m = computeCVMetrics(data, INPUT)!;
    const text = buildCVExportText(data, m, { scanRate: 100, eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6, nCycles: 1, n: 1, cMM: 5, areaCm2: 0.0707, cvModel: "reversible", measurementId: "cv_clip" }, "live");
    const lines = text.split("\n");
    const head = lines.findIndex((l) => l.startsWith("measurement_id;channel;timestamp;time_s"));
    expect(lines[head].split(";").slice(-1)[0]).toBe("out_of_range");
    const rest = lines.slice(head + 1);
    const rows = rest.slice(0, rest.findIndex((l) => l.trim() === ""));   // the raw block only
    expect(rows).toHaveLength(data.length);
    expect(rows.filter((l) => l.endsWith(";Yes"))).toHaveLength(data.filter((p) => p.outOfRange).length);
    expect(rows.filter((l) => l.endsWith(";No"))).toHaveLength(data.filter((p) => !p.outOfRange).length);
    expect(text).toMatch(/Ipa_valid;Ipc_valid/);
    expect(text).toContain("No (outside the ADC window)");
    expect(text).toContain("peak current outside the ADC window");
    // and the flags come back on import
    const back = parseImportedCsv(text, "cv");
    if ("error" in back || back.mode !== "cv") throw new Error("not CV");
    expect(back.measurements[0].points.filter((p) => p.outOfRange === true)).toHaveLength(data.filter((p) => p.outOfRange).length);
  });

  it("the session export has the column and the validity too", () => {
    const data = clippedCv(6);
    const m = computeCVMetrics(data, INPUT)!;
    const stored: StoredCVMeasurement = {
      id: "m1", mode: "cv", timestamp: 1, concentration: 5, measurementId: "cv_s", measurementTimestamp: 1,
      params: { scanRate: 100, eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6, nCycles: 1, n: 1, cMM: 5, areaCm2: 0.0707, cvModel: "reversible" },
      data, metrics: m,
    };
    const text = buildSessionExportText([stored], { source: "live" });
    expect(text).toMatch(/E_V;I_raw_uA;baseline_uA;I_corrected_uA;out_of_range/);
    expect(text).toMatch(/Ipa_valid;Ipc_valid/);
    expect(text).toContain("No (outside the ADC window)");
    const back = parseImportedCsv(text, "cv");
    if ("error" in back || back.mode !== "cv") throw new Error("not CV");
    expect(back.measurements[0].points.some((p) => p.outOfRange === true)).toBe(true);
  });
});

describe("SWV and BioFET", () => {
  const swvParams: SWVParameters = {
    startE: -0.2, endE: 0.6, step_mV: 4, amplitude_mV: 25, frequency_Hz: 25, quietTime_s: 2, direction: "anodic", baselineMethod: "auto",
  };
  const swvData = (clipPeak: boolean): SWVDataPoint[] =>
    Array.from({ length: 201 }, (_, i) => {
      const E = -0.2 + i * 0.004;
      const peak = 5 * Math.exp(-0.5 * ((E - 0.25) / 0.04) ** 2);
      return {
        E, IForward: 1 + peak, IReverse: 1, INet: peak, time: i * 0.04, index: i, direction: "anodic" as const,
        ...(clipPeak && Math.abs(E - 0.25) < 0.01 ? { outOfRange: true } : {}),
      };
    });

  it("SWV: a peak on clipped points is marked not reliable; an unflagged one is fine", () => {
    const bad = analyzeSWV(swvData(true), "auto").metrics;
    expect(bad.peakDetected).toBe(true);
    expect(bad.peakCurrentValid).toBe(false);
    expect(bad.warnings.some((w) => /peak current outside the ADC window/.test(w))).toBe(true);
    const ok = analyzeSWV(swvData(false), "auto").metrics;
    expect(ok.peakCurrentValid).toBeUndefined();
    expect(ok.warnings.some((w) => /outside the ADC window/.test(w))).toBe(false);
  });

  it("SWV: the export has the per-point column and the validity, and it loads back", () => {
    const data = swvData(true);
    const { metrics, corrected } = analyzeSWV(data, "auto");
    const text = buildSWVExportText({ data, corrected, metrics, params: swvParams, source: "live", measurementId: "swv_c" });
    expect(text).toMatch(/I_net_raw_uA;direction;out_of_range/);
    expect(text).toContain("No (outside the ADC window)");
    const back = parseImportedCsv(text, "swv");
    if ("error" in back || back.mode !== "swv") throw new Error("not SWV");
    expect(back.measurements[0].points.filter((p) => p.outOfRange === true)).toHaveLength(data.filter((p) => p.outOfRange).length);
  });

  it("BioFET: the transfer and time exports have the column, and it loads back", () => {
    const baseline = Array.from({ length: 10 }, (_, i) => ({ vg: i * 0.1, id: i, ...(i === 4 ? { outOfRange: true } : {}) }));
    const analyte = Array.from({ length: 10 }, (_, i) => ({ vg: i * 0.1, id: i + 1 }));
    const timeData = Array.from({ length: 5 }, (_, i) => ({ time: i, id: 3 + i, ...(i === 2 ? { outOfRange: true } : {}) }));
    const text = buildFETExportText({ baseline, analyte, timeData, source: "live", meta: { measurementId: "fet_c" } });
    expect(text).toMatch(/Curve;Vg \(V\);Id \(µA\);Out of range/);
    expect(text).toMatch(/Time \(s\);Id \(µA\);Marker;Out of range/);
    const t = parseImportedCsv(text, "fet_transfer");
    if ("error" in t || t.mode !== "fet_transfer") throw new Error("not FET");
    expect(t.measurements[0].baseline.filter((p) => p.outOfRange === true)).toHaveLength(1);
    expect(t.measurements[0].analyte.filter((p) => p.outOfRange === true)).toHaveLength(0);
    const tm = parseImportedCsv(text, "fet_time");
    if ("error" in tm || tm.mode !== "fet_time") throw new Error("not FET time");
    expect(tm.measurements[0].points.filter((p) => p.outOfRange === true)).toHaveLength(1);
  });
});
