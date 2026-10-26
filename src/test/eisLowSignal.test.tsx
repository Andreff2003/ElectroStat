import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import NyquistPlot from "@/components/NyquistPlot";
import BodePlot from "@/components/BodePlot";
import type { EISDataPoint } from "@/hooks/useSimulatedData";
import { splitForPlot, lowSignalNote, zRealExtent, isLowSignal } from "@/utils/eisLowSignal";
import { exportEISData } from "@/utils/csvExport";
import { parseImportedCsv } from "@/utils/csvImport";

// jsdom has no ResizeObserver; Recharts' ResponsiveContainer needs one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

/**
 * Points the firmware flags as low signal (a DFT of 1 or 2 counts, an impedance
 * of 80 kOhm on a 1 kOhm cell) are kept but hidden by default. They must not
 * decide the axis scale, and every export must carry them.
 */

const good = (i: number): EISDataPoint => ({
  frequency: 3000 / (i + 1), zReal: 1050 + i * 4, zImag: -(60 + i * 3), zMag: 1060 + i * 4, phase: -3,
  dftCal: 9, dftMag: 80, rtiaOhms: 200, lowSignal: false,
});
const bad = (f: number, zr: number): EISDataPoint => ({
  frequency: f, zReal: zr, zImag: -9980, zMag: Math.hypot(zr, 9980), phase: -7,
  dftCal: 8.062, dftMag: 1, rtiaOhms: 200, lowSignal: true,
});
// 6 good points between 1050 and 1070 ohm, and 2 junk ones at 80 kOhm and 4.7 MOhm
const mixed: EISDataPoint[] = [good(0), good(1), bad(5000, 80_461), good(2), good(3), bad(800, 4_700_000), good(4), good(5)];

describe("splitting the points for a plot", () => {
  it("hides the flagged points by default and counts them", () => {
    const s = splitForPlot(mixed, false);
    expect(s.shown).toHaveLength(6);
    expect(s.low).toHaveLength(0);
    expect(s.hiddenCount).toBe(2);
    expect(s.lowCount).toBe(2);
    expect(lowSignalNote(s)).toBe("2 low-signal points hidden");
  });

  it("returns them for the hollow grey markers when the toggle is on", () => {
    const s = splitForPlot(mixed, true);
    expect(s.shown).toHaveLength(6);
    expect(s.low).toHaveLength(2);
    expect(s.hiddenCount).toBe(0);
    expect(lowSignalNote(s)).toBe("2 low-signal points shown as hollow grey markers");
  });

  it("says nothing when no point is flagged, and uses the singular for one", () => {
    expect(lowSignalNote(splitForPlot(mixed.filter((p) => !isLowSignal(p)), false))).toBe("");
    expect(lowSignalNote(splitForPlot([good(0), bad(1, 80_000)], false))).toBe("1 low-signal point hidden");
  });

  it("the axis scale uses only the visible points", () => {
    const hidden = zRealExtent(splitForPlot(mixed, false))!;
    expect(hidden.min).toBe(1050);
    expect(hidden.max).toBe(1070);            // not 4.7 MOhm
    const shown = zRealExtent(splitForPlot(mixed, true))!;
    expect(shown.max).toBe(4_700_000);        // visible now, so it counts
    expect(zRealExtent(splitForPlot([bad(1, 80_000)], false))).toBeNull();
  });

  it("points without the flag (simulated, replayed, saved before it existed) are not low signal", () => {
    const old: EISDataPoint = { frequency: 10, zReal: 300, zImag: -100, zMag: 316, phase: -18 };
    expect(isLowSignal(old)).toBe(false);
    expect(splitForPlot([old], false).lowCount).toBe(0);
  });
});

describe("the note and the toggle under the Nyquist and Bode plots", () => {
  it("Nyquist: shows the hidden count and a toggle that shows the points", () => {
    render(<NyquistPlot data={mixed} />);
    expect(screen.getByTestId("low-signal-note")).toHaveTextContent("2 low-signal points hidden");
    const toggle = screen.getByRole("checkbox", { name: "Show low-signal points" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(screen.getByTestId("low-signal-note")).toHaveTextContent("2 low-signal points shown as hollow grey markers");
    fireEvent.click(toggle);
    expect(screen.getByTestId("low-signal-note")).toHaveTextContent("2 low-signal points hidden");
  });

  it("Bode: the same note and toggle", () => {
    render(<BodePlot data={mixed} />);
    expect(screen.getByTestId("low-signal-note")).toHaveTextContent("2 low-signal points hidden");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show low-signal points" }));
    expect(screen.getByTestId("low-signal-note")).toHaveTextContent("shown as hollow grey markers");
  });

  it("one parent toggle drives both plots", () => {
    const calls: boolean[] = [];
    render(<NyquistPlot data={mixed} showLowSignal onShowLowSignalChange={(v) => calls.push(v)} />);
    expect(screen.getByTestId("low-signal-note")).toHaveTextContent("shown as hollow grey markers");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show low-signal points" }));
    expect(calls).toEqual([false]);
  });

  it("no footer when nothing is flagged, and none in the compact dashboard cell", () => {
    const { rerender } = render(<NyquistPlot data={mixed.filter((p) => !isLowSignal(p))} />);
    expect(screen.queryByTestId("low-signal-footer")).toBeNull();
    rerender(<NyquistPlot data={mixed} compact />);
    expect(screen.queryByTestId("low-signal-footer")).toBeNull();
  });
});

describe("export and import keep every point and its diagnostics", () => {
  const csv = (): string[] => {
    let text = "";
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const origBlob = globalThis.Blob;
    // Capture what exportEISData would download instead of saving a file.
    globalThis.Blob = class { constructor(parts: BlobPart[]) { text = parts.join(""); } } as unknown as typeof Blob;
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
    try {
      exportEISData(mixed, "live", {});
    } finally {
      globalThis.Blob = origBlob;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
    return text.split("\n");
  };

  it("writes all 8 points, with dftCal, dftMag, rtiaOhms and the flag as columns", () => {
    const lines = csv();
    const h = lines.findIndex((l) => l.includes("Frequency (Hz)"));
    expect(h).toBeGreaterThan(-1);
    const header = lines[h].split(";").map((c) => c.replace(/^"|"$/g, ""));
    for (const col of ["DFT Cal (counts)", "DFT Mag (counts)", "RTIA (Ω)", "Low signal"]) expect(header).toContain(col);
    const rows = lines.slice(h + 1, h + 1 + mixed.length).map((l) => l.split(";"));
    expect(rows).toHaveLength(8);
    const iLow = header.indexOf("Low signal");
    expect(rows.map((r) => r[iLow].replace(/"/g, ""))).toEqual(mixed.map((p) => (p.lowSignal ? "Yes" : "No")));
    expect(rows[2][header.indexOf("DFT Mag (counts)")].replace(/"/g, "")).toBe("1.000");
  });

  it("an exported file loads back with the flags, and a file from before them loads as not low signal", () => {
    const lines = csv();
    const back = parseImportedCsv(lines.join("\n"), "eis");
    const pts = (back as any).measurements?.[0]?.points as EISDataPoint[] | undefined;
    expect(pts).toBeDefined();
    expect(pts!.filter(isLowSignal)).toHaveLength(2);
    expect(pts![2].dftMag).toBe(1);
    // an old file: no diagnostic columns
    const old = [
      "sep=;",
      "=== RAW EIS DATA ===;;;;;;;;",
      "Measurement ID;Timestamp;Mode;Concentration (nM);Frequency (Hz);Z Real (Ω);Z Imag (Ω);|Z| (Ω);Phase (°)",
      "eis_1;2026-01-01 10:00:00;eis;N/A;100000.000;150.000;-20.000;151.327;-7.595",
      "eis_1;2026-01-01 10:00:00;eis;N/A;10000.000;180.000;-90.000;201.246;-26.565",
    ].join("\n");
    const oldPts = ((parseImportedCsv(old, "eis") as any).measurements[0].points) as EISDataPoint[];
    expect(oldPts).toHaveLength(2);
    expect(oldPts.every((p) => !isLowSignal(p) && p.dftMag === undefined)).toBe(true);
  });
});
