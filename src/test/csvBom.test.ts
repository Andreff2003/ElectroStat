import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  exportCVCalibrationCSV,
  exportCVData,
  exportCalibrationCSV,
  exportEISData,
  exportFETData,
  exportFETTimeData,
  exportFETTransferData,
  exportSWVData,
  exportSessionCSV,
} from "@/utils/csvExport";
import { parseImportedCsv } from "@/utils/csvImport";
import type { SWVParameters } from "@/types/swv";

/**
 * Every CSV the app writes starts with a UTF-8 byte order mark and then the content itself, so that Excel reads the
 * file as UTF-8 (Ω, °, µ and — instead of Î©, Â°, â€”). There is no "sep=;" line: with it first, Excel ignores the
 * BOM and reads the file as Windows-1252 (checked in Excel 365, pt-PT). The import still accepts files that have one.
 */

let blobs: { parts: BlobPart[]; type: string }[] = [];
let names: string[] = [];
const origBlob = globalThis.Blob;
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;
const origClick = HTMLAnchorElement.prototype.click;

beforeEach(() => {
  blobs = [];
  names = [];
  globalThis.Blob = class {
    constructor(public parts: BlobPart[], opts?: { type?: string }) {
      blobs.push({ parts, type: opts?.type ?? "" });
    }
  } as unknown as typeof Blob;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { names.push(this.download); };
});
afterEach(() => {
  globalThis.Blob = origBlob;
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
  HTMLAnchorElement.prototype.click = origClick;
  vi.restoreAllMocks();
});

const text = () => blobs.map((b) => b.parts.join(""));

const swvParams: SWVParameters = {
  startE: -0.2, endE: 0.6, step_mV: 4, amplitude_mV: 25, frequency_Hz: 10, quietTime_s: 2, direction: "anodic", baselineMethod: "auto",
};
const cvParams = { scanRate: 100, eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6, nCycles: 1, n: 1, cMM: 5, areaCm2: 0.0707, cvModel: "reversible" };
const eis = [{ zReal: 100, zImag: -50, frequency: 1000, zMag: 111.8, phase: -26.6 }];

describe("every CSV export starts with a BOM and no sep= line", () => {
  const paths: [string, () => void][] = [
    ["EIS", () => exportEISData(eis, "live", {})],
    ["BioFET transfer", () => exportFETTransferData([{ vg: 0, id: 1 }], [{ vg: 0, id: 2 }], "live", {})],
    ["BioFET time", () => exportFETTimeData([{ time: 0, id: 1 }], "live", {})],
    ["BioFET combined", () => exportFETData({ baseline: [{ vg: 0, id: 1 }], analyte: [{ vg: 0, id: 2 }], timeData: [{ time: 0, id: 1 }], source: "live" })],
    ["CV", () => exportCVData([{ E: 0, I: 1, cycle: 1, t: 0 }], null, cvParams, "live")],
    ["CV calibration", () => exportCVCalibrationCSV([], { responseMode: "anodic" as never, n: 1, areaCm2: 0.07, scanRate_mVs: 100 })],
    ["SWV", () => exportSWVData({ data: [{ E: 0, IForward: 2, IReverse: 1, INet: 1, time: 0, index: 0, direction: "anodic" }], metrics: null, params: swvParams, source: "live" })],
    ["calibration", () => exportCalibrationCSV("eis", [], "live")],
    ["session", () => exportSessionCSV([], { source: "live" })],
  ];

  for (const [name, run] of paths) {
    it(name, () => {
      run();
      expect(blobs).toHaveLength(1);
      const t = text()[0];
      expect(t.startsWith("﻿")).toBe(true);                    // the BOM first
      expect(t).not.toMatch(/^﻿?sep=/i);                       // and no sep= line, which makes Excel ignore it
      expect(blobs[0].type).toContain("charset=utf-8");
      expect(names[0]).toMatch(/\.csv$/);
      // one BOM only, and the file itself follows it
      expect(t.indexOf("﻿", 1)).toBe(-1);
      expect(t.split("\n")[0].slice(1)).toMatch(/^ElectroStat Export;|^=== /);
    });
  }

  it("the characters Excel got wrong survive, and the file still imports", () => {
    exportEISData(eis, "live", { measurementId: "eis_u" });
    const t = text()[0];
    expect(t).toContain("Z Real (Ω)");
    expect(t).toContain("Phase (°)");
    expect(t).toContain("—");                                       // the channel of a single-device export
    const bytes = new TextEncoder().encode(t);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);   // a UTF-8 BOM on the wire
    const back = parseImportedCsv(t, "eis");
    if ("error" in back || back.mode !== "eis") throw new Error("not EIS");
    expect(back.measurements[0].points).toHaveLength(1);
  });
});
