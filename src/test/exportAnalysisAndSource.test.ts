import { describe, it, expect } from "vitest";
import {
  buildEISExportText,
  buildSessionExportText,
  measurementSourceOf,
  sessionSourceLabel,
} from "@/utils/csvExport";
import { linKKTest } from "@/utils/linKK";
import { fitRandlesAuto } from "@/utils/randlesFit";
import type { EISDataPoint } from "@/hooks/useSimulatedData";
import type { StoredEISMeasurement, StoredMeasurement } from "@/utils/sessionStore";

/**
 * a) The EIS export of a 36-point live sweep said "Lin-KK: Not enough points (need >= 6)" with every fit
 *    field N/A, because the page had closed the sweep on a few points (the late "stopped" of the sweep before
 *    ended it). The export now runs Lin-KK and the Randles fit on the exported sweep, without its low-signal
 *    points, or says why it could not.
 * b) A session export of live measurements said "Source: simulated" in its header, the source the app was set
 *    to when the file was saved. Each measurement now carries its own, and the header follows them.
 */

const RS = 100;
const RCT = 500;
const CDL = 1e-6;

/** A clean Randles semicircle (Rs + Rct || Cdl), high to low frequency, with a little noise. */
function randles(n: number, seed = 1): EISDataPoint[] {
  let a = seed;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 - 0.5; };
  const out: EISDataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const f = Math.pow(10, 5 - (i / (n - 1)) * 4);            // 100 kHz -> 10 Hz
    const w = 2 * Math.PI * f;
    const den = 1 + (w * RCT * CDL) ** 2;
    const zr = RS + RCT / den + rnd() * 0.5;
    const zi = -(w * RCT * RCT * CDL) / den + rnd() * 0.5;
    out.push({ zReal: zr, zImag: zi, frequency: f, zMag: Math.hypot(zr, zi), phase: (Math.atan2(zi, zr) * 180) / Math.PI });
  }
  return out;
}

/** Junk from a bad contact: flagged by the firmware as too small a signal. */
function junk(n: number): EISDataPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    zReal: 5e4 + i * 1e3, zImag: 3e4, frequency: 3 + i * 0.1, zMag: 6e4, phase: 30, dftCal: 2, dftMag: 0.1, rtiaOhms: 200, lowSignal: true,
  }));
}

const row = (text: string, key: string) => {
  const m = new RegExp(`^${key};(.*)$`, "m").exec(text);
  return m ? m[1] : undefined;
};

describe("EIS export: Lin-KK and the Randles fit on the exported sweep", () => {
  const sweep = randles(36);

  it("the page had nothing (or the placeholder of a sweep closed on a few points): they are computed at export", () => {
    const placeholder = linKKTest(sweep.slice(0, 3));            // "Not enough points for Lin-KK inspired check (need >= 6)"
    expect(placeholder.warnings.join(" ")).toMatch(/need ≥ 6/);
    const text = buildEISExportText(sweep, "live", { measurementId: "eis_a", linKK: placeholder, randlesFit: null });
    expect(text).not.toMatch(/Not enough points/);
    expect(row(text, "lin_kk_source")).toBe("computed_at_export");
    expect(row(text, "randles_fit_source")).toBe("computed_at_export");
    expect(row(text, "analysis_points_total")).toBe("36");
    expect(row(text, "analysis_points_used")).toBe("36");
    expect(row(text, "analysis_points_excluded_low_signal")).toBe("0");
    expect(row(text, "lin_kk_passed")).not.toBe("N/A");
    expect(row(text, "lin_kk_tau_count")).not.toBe("N/A");
    const rct = Number(row(text, "Rct_ohm"));
    const rs = Number(row(text, "Rs_ohm"));
    expect(rct).toBeGreaterThan(RCT * 0.9);
    expect(rct).toBeLessThan(RCT * 1.1);
    expect(rs).toBeGreaterThan(RS * 0.9);
    expect(rs).toBeLessThan(RS * 1.1);
    expect(row(text, "fit_model")).not.toBe("N/A");
  });

  it("without any result at all (a stopped sweep) the same", () => {
    const text = buildEISExportText(sweep, "live", { measurementId: "eis_b" });
    expect(row(text, "lin_kk_source")).toBe("computed_at_export");
    expect(row(text, "randles_fit_source")).toBe("computed_at_export");
    expect(Number(row(text, "Rct_ohm"))).toBeGreaterThan(RCT * 0.9);
  });

  it("low-signal points stay in the file but are left out of the analysis", () => {
    const withJunk = [...sweep, ...junk(6)];
    const text = buildEISExportText(withJunk, "live", { measurementId: "eis_c" });
    expect(row(text, "analysis_points_total")).toBe("42");
    expect(row(text, "analysis_points_used")).toBe("36");
    expect(row(text, "analysis_points_excluded_low_signal")).toBe("6");
    // every point is still exported
    const rawRows = text.split("\n").filter((l) => l.startsWith("eis_c;"));
    expect(rawRows).toHaveLength(42);
    expect(rawRows.filter((l) => l.split(";")[13] === "Yes")).toHaveLength(6);   // the "Low signal" column
    // and the fit does not see them
    const rct = Number(row(text, "Rct_ohm"));
    expect(rct).toBeGreaterThan(RCT * 0.9);
    expect(rct).toBeLessThan(RCT * 1.1);
  });

  it("too few usable points: it says why, and does not invent numbers", () => {
    const few = [...sweep.slice(0, 4), ...junk(6)];
    const text = buildEISExportText(few, "live", { measurementId: "eis_d" });
    expect(row(text, "lin_kk_source")).toBe("not_computed");
    expect(row(text, "randles_fit_source")).toBe("not_computed");
    const notes = row(text, "analysis_notes") ?? "";
    expect(notes).toMatch(/Lin-KK not computed: 4 usable point\(s\), it needs at least 6 \(6 low-signal point\(s\) left out\)/);
    expect(notes).toMatch(/Randles fit not computed: 4 usable point\(s\), it needs at least 5/);
    expect(row(text, "Rct_ohm")).toBe("N/A");
    expect(row(text, "lin_kk_passed")).toBe("N/A");
  });

  it("what the page had on screen is kept as it is", () => {
    const real = linKKTest(sweep);
    const onScreen = fitRandlesAuto(sweep)!;
    const text = buildEISExportText(sweep, "live", { measurementId: "eis_e", linKK: real, randlesFit: { ...onScreen, Rct: 1234 } });
    expect(row(text, "lin_kk_source")).toBe("on_screen");
    expect(row(text, "randles_fit_source")).toBe("on_screen");
    expect(Number(row(text, "Rct_ohm"))).toBe(1234);
    expect(row(text, "analysis_notes")).toBe("N/A");
  });
});

// ─── b) the source of a measurement ────────────────────────────────────────

function eis(id: string, source?: "simulated" | "live" | "imported" | "unknown"): StoredEISMeasurement {
  return {
    id, mode: "eis", timestamp: 1_700_000_000_000, concentration: 100,
    params: { freqMin: 0.1, freqMax: 100000, points: 36, amplitude: 10 },
    data: randles(8), extracted: {}, ...(source ? { source } : {}),
  };
}

describe("session export: the real source of each measurement", () => {
  const header = (text: string) => text.split("\n")[0];

  it("live measurements are live, whatever the app is set to when the file is saved", () => {
    const text = buildSessionExportText([eis("m1", "live"), eis("m2", "live")], { source: "simulated" });
    expect(header(text)).toContain("Source: live");
    expect(header(text)).not.toContain("simulated");
    expect(text).toMatch(/=== INSTRUMENT SETTINGS — m1 ===[^]*?\nsource;live/);
  });

  it("a mixed session says so, with the counts, and each block has its own", () => {
    const text = buildSessionExportText([eis("m1", "live"), eis("m2", "simulated"), eis("m3", "live")], { source: "live" });
    expect(header(text)).toContain("Source: mixed (live 2, simulated 1)");
    expect(text).toMatch(/=== INSTRUMENT SETTINGS — m2 ===[^]*?\nsource;simulated/);
  });

  it("a measurement stored before the source was kept is unknown, not simulated", () => {
    expect(measurementSourceOf(eis("old"))).toBe("unknown");
    const text = buildSessionExportText([eis("old")], { source: "simulated" });
    expect(header(text)).toContain("Source: unknown");
    expect(text).toMatch(/=== INSTRUMENT SETTINGS — old ===[^]*?\nsource;unknown/);
  });

  it("a session with no measurements follows what the caller says", () => {
    expect(sessionSourceLabel([], "live")).toBe("live");
    expect(sessionSourceLabel([])).toBe("unknown");
  });

  it("SWV measurements already carried their source and keep it", () => {
    const swv = { id: "s", mode: "swv", timestamp: 1, source: "live", params: {}, data: [], extracted: {} } as unknown as StoredMeasurement;
    expect(measurementSourceOf(swv)).toBe("live");
  });
});
