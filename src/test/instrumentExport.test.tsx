import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  buildInstrumentSettings,
  instrumentRows,
  parseInstrumentRows,
  INSTRUMENT_CSV_KEYS,
  type InstrumentSettings,
} from "@/utils/instrumentSettings";
import {
  buildCVExportText,
  buildEISExportText,
  buildFETExportText,
  buildSWVExportText,
  buildSessionExportText,
  instrumentSettingsOf,
} from "@/utils/csvExport";
import { parseImportedCsv } from "@/utils/csvImport";
import { useWebSocketData } from "@/hooks/useWebSocketData";
import type {
  StoredCVMeasurement,
  StoredEISMeasurement,
  StoredFETMeasurement,
  StoredMeasurement,
  StoredSWVMeasurement,
} from "@/utils/sessionStore";
import type { SWVMetrics, SWVParameters } from "@/types/swv";

/**
 * Exports carry the instrument settings needed to reproduce a measurement: what was requested (RTIA, EIS
 * bias, amplitude, frequency range) and what the device reported (the calibration it ran, the out-of-range
 * count, the EIS point counts). Old measurements, from before these fields, export N/A and load as before.
 */

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const CAL_RUNNING = {
  type: "cv_status", status: "running",
  calibrated: true, rtiaNominalOhms: 10000, rtiaCalibratedOhms: 10230, rtiaCalibrated: true,
  currentOffsetUa: -0.42, potentialOffsetMv: 6.5, vzeroV: 1.3, calibrationNote: "RTIA 2.3 % from nominal", rcalOhms: 9980,
};

const AMPERO: InstrumentSettings = {
  rtiaOhms: 10000, calibrated: true, rtiaCalibratedOhms: 10230, currentOffsetUa: -0.42,
  potentialOffsetMv: 6.5, vzeroV: 1.3, calibrationNote: "RTIA 2.3 % from nominal", outOfRangeCount: 3, rcalOhms: 9980,
};
const EIS: InstrumentSettings = {
  dcBias: 0.15, amplitude: 10, freqMin: 0.1, freqMax: 100000, pointsPerDecade: 10, rcalOhms: 9980,
  pointsRequested: 61, pointsSent: 58, pointsSkipped: 3, pointsLowSignal: 4,
};

describe("the rows of the settings", () => {
  it("are the same rows in the same order for a technique, N/A for what is unknown", () => {
    const full = instrumentRows("cv", AMPERO);
    const empty = instrumentRows("cv", undefined);
    expect(full.map(([k]) => k)).toEqual(empty.map(([k]) => k));
    expect(Object.fromEntries(full)).toMatchObject({
      rtia_requested_ohms: "10000", calibration_run: "Yes", rtia_calibrated_ohms: "10230",
      current_offset_uA: "-0.42", potential_offset_mV: "6.5", vzero_V: "1.3",
      calibration_note: "RTIA 2.3 % from nominal", out_of_range_points: "3", rcal_ohms: "9980",
    });
    expect(empty.every(([, v]) => v === "N/A")).toBe(true);
  });

  it("EIS has its own rows, with the sent, skipped and low-signal counts", () => {
    const rows = Object.fromEntries(instrumentRows("eis", EIS));
    expect(rows).toMatchObject({
      eis_dc_bias_V: "0.15", eis_amplitude_mV: "10", eis_freq_min_Hz: "0.1", eis_freq_max_Hz: "100000",
      eis_points_per_decade: "10", rcal_ohms: "9980", eis_points_requested: "61",
      eis_points_sent: "58", eis_points_skipped: "3", eis_points_low_signal: "4",
    });
    expect(Object.keys(rows)).not.toContain("rtia_requested_ohms");
  });

  it("parse back to the same settings, and N/A parses to nothing", () => {
    expect(parseInstrumentRows(instrumentRows("cv", AMPERO))).toEqual(AMPERO);
    expect(parseInstrumentRows(instrumentRows("eis", EIS))).toEqual(EIS);
    expect(parseInstrumentRows(instrumentRows("fet", undefined))).toEqual({});
    expect(INSTRUMENT_CSV_KEYS).toContain("rcal_ohms");
  });

  it("calibration_run No is kept as false, not lost", () => {
    const back = parseInstrumentRows(instrumentRows("swv", { calibrated: false, rtiaOhms: 1000 }));
    expect(back).toEqual({ calibrated: false, rtiaOhms: 1000 });
  });
});

describe("buildInstrumentSettings", () => {
  it("joins the request with the 'running' status and the done message of the device", () => {
    const s = buildInstrumentSettings("cv", { rtiaOhms: 10000 }, { running: CAL_RUNNING, done: { type: "cv_done", outOfRangeCount: 3, lateCount: 0 } });
    expect(s).toEqual(AMPERO);
  });

  it("EIS: the point counts come from eis_done, RCAL from the running status", () => {
    const s = buildInstrumentSettings(
      "eis",
      { dcBias: 0.15, amplitude: 10, freqMin: 0.1, freqMax: 100000, pointsPerDecade: 10 },
      { running: { amplitude: 10, rcalOhms: 9980, dcBias: 0.15 }, done: { points: 58, requested: 61, skipped: 3, lowSignal: 4 } },
    );
    expect(s).toEqual(EIS);
  });

  it("what the device did not say is not there", () => {
    expect(buildInstrumentSettings("cv", { rtiaOhms: 10000 }, null)).toEqual({ rtiaOhms: 10000 });
    expect(buildInstrumentSettings("fet", {}, { running: {}, done: {} })).toEqual({});
  });
});

describe("the hook keeps what the device says about a sweep", () => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    send(d: string) { this.sent.push(d); }
    close() { this.onclose?.(); }
    emit(f: object) { this.onmessage?.({ data: JSON.stringify(f) }); }
  }
  let socket: MockWebSocket;
  function connected() {
    vi.stubGlobal("WebSocket", class extends MockWebSocket { constructor() { super(); socket = this; } });
    const { result } = renderHook(() => useWebSocketData());
    act(() => { result.current.connect("ws://127.0.0.1:81"); });
    act(() => { socket.onopen?.(); });
    return result;
  }

  it("CV: the calibration of the running status and the out-of-range count of cv_done, cleared by the next start", () => {
    const result = connected();
    act(() => { result.current.sendCommand("start_cv", {}); });
    act(() => { socket.emit(CAL_RUNNING); });
    expect(result.current.cvDeviceInfo.running).toMatchObject({ calibrated: true, rtiaCalibratedOhms: 10230, vzeroV: 1.3, rcalOhms: 9980 });
    expect(result.current.cvDeviceInfo.running).not.toHaveProperty("type");
    act(() => { socket.emit({ type: "cv_done", outOfRangeCount: 3, lateCount: 0 }); });
    const info = result.current.cvDeviceInfo;
    expect(buildInstrumentSettings("cv", { rtiaOhms: 10000 }, info)).toEqual(AMPERO);
    act(() => { result.current.sendCommand("start_cv", {}); });
    expect(result.current.cvDeviceInfo).toEqual({});
  });

  it("EIS: the counts of eis_done, SWV and BioFET likewise", () => {
    const result = connected();
    act(() => { result.current.sendCommand("start_eis", {}); });
    act(() => { socket.emit({ type: "eis_status", status: "running", amplitude: 10, dcBias: 0.15, rcalOhms: 9980 }); });
    act(() => { socket.emit({ type: "eis_done", points: 58, requested: 61, skipped: 3, lowSignal: 4 }); });
    expect(buildInstrumentSettings("eis", {}, result.current.eisDeviceInfo)).toEqual({
      amplitude: 10, dcBias: 0.15, rcalOhms: 9980, pointsRequested: 61, pointsSent: 58, pointsSkipped: 3, pointsLowSignal: 4,
    });
    act(() => { socket.emit({ type: "swv_status", status: "running", calibrated: false, rtiaCalibratedOhms: 10000 }); });
    act(() => { socket.emit({ type: "swv_done", points: 401, outOfRangeCount: 0 }); });
    expect(buildInstrumentSettings("swv", {}, result.current.swvDeviceInfo)).toMatchObject({ calibrated: false, outOfRangeCount: 0 });
    act(() => { socket.emit({ type: "fet_status", status: "running", calibrated: true, potentialOffsetMv: -2 }); });
    act(() => { socket.emit({ type: "fet_done", outOfRangeCount: 1 }); });
    expect(buildInstrumentSettings("fet", {}, result.current.fetDeviceInfo)).toMatchObject({ potentialOffsetMv: -2, outOfRangeCount: 1 });
  });

  it("the messages of the sweep before do not touch it", () => {
    const result = connected();
    act(() => { result.current.sendCommand("start_cv", {}); });
    act(() => { socket.emit({ type: "cv_done", outOfRangeCount: 99 }); });       // the old sweep's
    expect(result.current.cvDeviceInfo).toEqual({});
  });
});

// ─── exports and imports ───────────────────────────────────────────────────

const CV_PARAMS = {
  scanRate: 50, eStart: -0.3, eVertex1: 0.6, eVertex2: -0.3, nCycles: 1, n: 1, cMM: 2.5, areaCm2: 0.0707,
  cvModel: "reversible", stepPotential: 2, quietTime: 2, rtiaOhms: 10000,
};
const cvPoints = Array.from({ length: 12 }, (_, i) => ({
  E: -0.3 + i * 0.05, I: i * 3 - 10, cycle: 1, t: i * 0.1, branch: i < 6 ? ("forward" as const) : ("reverse" as const),
}));
const swvParams: SWVParameters = {
  startE: -0.2, endE: 0.6, step_mV: 4, amplitude_mV: 25, frequency_Hz: 25, quietTime_s: 2, direction: "anodic",
  baselineMethod: "auto", rtiaOhms: 10000,
};
const swvPoints = Array.from({ length: 8 }, (_, i) => ({
  E: -0.2 + i * 0.1, IForward: 1 + i, IReverse: 0.5, INet: 0.5 + i, time: 2 + i * 0.04, index: i, direction: "anodic" as const,
}));
const eisPoints = Array.from({ length: 6 }, (_, i) => ({
  zReal: 100 + i, zImag: -50 - i, frequency: 1000 / (i + 1), zMag: 120, phase: -20,
}));

function storedCv(instrument?: InstrumentSettings): StoredCVMeasurement {
  return {
    id: "m_cv", mode: "cv", timestamp: 1_700_000_000_000, concentration: 2.5,
    measurementId: "cv_20261027_121444_ab12", measurementTimestamp: 1_700_000_000_000,
    params: CV_PARAMS, data: cvPoints, metrics: null, ...(instrument ? { instrument } : {}),
  };
}
function storedSwv(instrument?: InstrumentSettings): StoredSWVMeasurement {
  return {
    id: "m_swv", mode: "swv", timestamp: 1_700_000_000_000, source: "live", concentration: 100,
    measurementId: "swv_1", measurementTimestamp: 1_700_000_000_000,
    params: swvParams, data: swvPoints, extracted: {} as SWVMetrics, ...(instrument ? { instrument } : {}),
  };
}
function storedEis(instrument?: InstrumentSettings): StoredEISMeasurement {
  return {
    id: "m_eis", mode: "eis", timestamp: 1_700_000_000_000, concentration: 100,
    params: { freqMin: 0.1, freqMax: 100000, points: 61, amplitude: 10, pointDensityMode: "perDecade", pointsPerDecade: 10, dcBias: 0.15 },
    data: eisPoints, extracted: {}, ...(instrument ? { instrument } : {}),
  };
}
function storedFet(instrument?: InstrumentSettings): StoredFETMeasurement {
  return {
    id: "m_fet", mode: "fet", timestamp: 1_700_000_000_000, concentration: 100,
    params: { vgMin: -0.5, vgMax: 1.5, vgStep: 40, intervalMs: 200 },
    baseline: [{ vg: 0, id: 1 }, { vg: 0.5, id: 2 }], analyte: [{ vg: 0, id: 1.5 }, { vg: 0.5, id: 2.5 }],
    timeData: [{ time: 0, id: 2 }], markers: [], extracted: {}, ...(instrument ? { instrument } : {}),
  };
}

function importAs(text: string, mode: "eis" | "cv" | "swv" | "fet_transfer") {
  const r = parseImportedCsv(text, mode);
  if ("error" in r) throw new Error(r.error);
  return r.measurements as { id: string; instrument?: InstrumentSettings }[];
}

describe("single-measurement exports", () => {
  it("CV: the metadata has the settings, and the file loads back with them", () => {
    const text = buildCVExportText(cvPoints, null, { ...CV_PARAMS, measurementId: "cv_a", instrument: AMPERO }, "live");
    expect(text).toContain("rtia_requested_ohms;10000");
    expect(text).toContain("rtia_calibrated_ohms;10230");
    expect(text).toContain("current_offset_uA;-0.42");
    expect(text).toContain("potential_offset_mV;6.5");
    expect(text).toContain("vzero_V;1.3");
    expect(text).toContain("out_of_range_points;3");
    expect(text).toContain("calibration_note;RTIA 2.3 % from nominal");
    const [m] = importAs(text, "cv");
    expect(m.id).toBe("cv_a");
    expect(m.instrument).toEqual(AMPERO);
  });

  it("CV without a device report still says the RTIA that was requested, and N/A for the rest", () => {
    const text = buildCVExportText(cvPoints, null, { ...CV_PARAMS, measurementId: "cv_b" }, "simulated");
    expect(text).toContain("rtia_requested_ohms;10000");
    expect(text).toContain("rtia_calibrated_ohms;N/A");
    expect(text).toContain("out_of_range_points;N/A");
    const [m] = importAs(text, "cv");
    expect(m.instrument).toEqual({ rtiaOhms: 10000 });
  });

  it("SWV: the same", () => {
    const text = buildSWVExportText({ data: swvPoints, metrics: null, params: swvParams, source: "live", measurementId: "swv_a", instrument: AMPERO });
    expect(text).toContain("rtia_calibrated_ohms;10230");
    expect(text).toContain("out_of_range_points;3");
    const [m] = importAs(text, "swv");
    expect(m.instrument).toEqual(AMPERO);
    // the SWV amplitude parameter is not mistaken for an EIS setting
    expect(text).toContain("amplitude_mV;25");
    expect(m.instrument).not.toHaveProperty("amplitude");
  });

  it("BioFET: the same", () => {
    const text = buildFETExportText({
      baseline: [{ vg: 0, id: 1 }], analyte: [{ vg: 0, id: 2 }], timeData: [{ time: 0, id: 2 }], source: "live",
      meta: { measurementId: "fet_a", instrument: { ...AMPERO } },
    });
    expect(text).toContain("rtia_calibrated_ohms;10230");
    const [m] = importAs(text, "fet_transfer");
    expect(m.instrument).toEqual(AMPERO);
  });

  it("EIS: bias, amplitude, range, points per decade, RCAL and the sent, skipped and low-signal counts", () => {
    const text = buildEISExportText(eisPoints, "live", { measurementId: "eis_a", instrument: EIS });
    expect(text).toContain("eis_dc_bias_V;0.15");
    expect(text).toContain("eis_amplitude_mV;10");
    expect(text).toContain("eis_freq_min_Hz;0.1");
    expect(text).toContain("eis_freq_max_Hz;100000");
    expect(text).toContain("eis_points_per_decade;10");
    expect(text).toContain("rcal_ohms;9980");
    expect(text).toContain("eis_points_sent;58");
    expect(text).toContain("eis_points_skipped;3");
    expect(text).toContain("eis_points_low_signal;4");
    const [m] = importAs(text, "eis");
    expect(m.instrument).toEqual(EIS);
  });

  it("a file from before the settings existed loads with none", () => {
    const text = buildEISExportText(eisPoints, "live", { measurementId: "eis_old" })
      .split("\n").filter((l) => !/^(eis_(dc_bias|amplitude|freq|points)[A-Za-z_]*|rcal_ohms);/.test(l)).join("\n");
    const [m] = importAs(text, "eis");
    expect(m.instrument).toBeUndefined();
  });
});

describe("session export", () => {
  const session: StoredMeasurement[] = [
    storedCv(AMPERO), storedSwv({ ...AMPERO, rtiaCalibratedOhms: 9900 }), storedEis(EIS), storedFet({ ...AMPERO, outOfRangeCount: 0 }),
  ];

  it("has an INSTRUMENT SETTINGS block for every measurement", () => {
    const text = buildSessionExportText(session, { source: "live" });
    expect(text.match(/=== INSTRUMENT SETTINGS — /g)).toHaveLength(4);
    expect(text).toContain("=== INSTRUMENT SETTINGS — cv_20261027_121444_ab12 ===");
    expect(text).toContain("=== INSTRUMENT SETTINGS — m_eis ===");
  });

  it("every technique loads back with its settings", () => {
    const text = buildSessionExportText(session, { source: "live" });
    expect(importAs(text, "cv")[0].instrument).toEqual(AMPERO);
    expect(importAs(text, "swv")[0].instrument).toEqual({ ...AMPERO, rtiaCalibratedOhms: 9900 });
    expect(importAs(text, "eis")[0].instrument).toEqual(EIS);
    expect(importAs(text, "fet_transfer")[0].instrument).toEqual({ ...AMPERO, outOfRangeCount: 0 });
  });

  it("a measurement stored before the settings: its requested parameters, and N/A for what only the device reports", () => {
    const old: StoredMeasurement[] = [storedCv(), storedSwv(), storedEis(), storedFet()];
    expect(instrumentSettingsOf(old[0])).toEqual({ rtiaOhms: 10000 });
    expect(instrumentSettingsOf(old[2])).toMatchObject({ dcBias: 0.15, amplitude: 10, freqMin: 0.1, freqMax: 100000, pointsPerDecade: 10 });
    expect(instrumentSettingsOf(old[3])).toEqual({});
    const text = buildSessionExportText(old, { source: "live" });
    expect(text).toContain("rtia_calibrated_ohms;N/A");
    expect(text).toContain("eis_points_sent;N/A");
    expect(text).toContain("eis_dc_bias_V;0.15");
    const [cv] = importAs(text, "cv");
    expect(cv.instrument).toEqual({ rtiaOhms: 10000 });
    expect(importAs(text, "fet_transfer")[0].instrument).toBeUndefined();
  });

  it("two CV measurements of a session keep their own settings", () => {
    const a = { ...storedCv({ ...AMPERO, rtiaCalibratedOhms: 10100 }), measurementId: "cv_one", id: "m1" };
    const b = { ...storedCv({ ...AMPERO, rtiaCalibratedOhms: 10300 }), measurementId: "cv_two", id: "m2" };
    const text = buildSessionExportText([a, b], { source: "live" });
    const got = importAs(text, "cv");
    expect(got.map((m) => [m.id, m.instrument?.rtiaCalibratedOhms])).toEqual([["cv_one", 10100], ["cv_two", 10300]]);
  });
});
