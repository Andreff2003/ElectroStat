import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useWebSocketData,
  techniqueOfStartCommand,
  START_ACK_TIMEOUT_MS,
} from "@/hooks/useWebSocketData";
import { useSimulatedEIS } from "@/hooks/useSimulatedData";
import { useSimulatedCVData, DEFAULT_CV_PARAMS } from "@/hooks/useSimulatedCVData";
import { useSimulatedSWVData } from "@/hooks/useSimulatedSWVData";
import type { SWVParameters } from "@/types/swv";

/**
 * Stop, then Start again right away. The device does not number its sweeps, so the app does:
 * every start opens a new sweep (new id, the live data of that technique cleared) and what
 * the device still says about the sweep before (its last points, "stopped", "idle", the "idle"
 * that bridge.py sends on a stop) is ignored until the device reports the new sweep as running.
 * Before this, a late "stopped" ended the new sweep in the app ("Idle") while the device kept
 * sending points, and the points of both sweeps were drawn together.
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.onclose?.(); }
  emit(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  commands() { return this.sent.map((s) => JSON.parse(s).command as string); }
}

function connectedHook() {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  const { result } = renderHook(() => useWebSocketData());
  act(() => { result.current.connect("ws://127.0.0.1:81"); });
  const socket = MockWebSocket.instances[0];
  act(() => { socket.onopen?.(); });
  return { result, socket };
}

const eisFrame = (i: number) => ({ type: "eis", zReal: 100 + i, zImag: -50 - i, frequency: 100000 / (i + 1), zMag: 120, phase: -20 });
const cvFrame = (i: number) => ({ type: "cv_data", E: -0.2 + i * 0.002, I: i * 0.1, cycle: 1, t: i * 0.02, branch: "forward" });
const swvFrame = (i: number) => ({ type: "swv_data", E: -0.2 + i * 0.004, IForward: 1 + i, IReverse: 0.5, INet: 0.5 + i, index: i, time: i * 0.04 });
const fetFrame = (i: number) => ({ type: "fet_transfer", vg: -0.5 + i * 0.04, id: 5 + i, curve: "baseline" });

describe("techniqueOfStartCommand", () => {
  it("knows the four start commands and nothing else", () => {
    expect(techniqueOfStartCommand("start_eis")).toBe("eis");
    expect(techniqueOfStartCommand("start_cv")).toBe("cv");
    expect(techniqueOfStartCommand("start_swv")).toBe("swv");
    expect(techniqueOfStartCommand("start_fet")).toBe("fet");
    expect(techniqueOfStartCommand("stop")).toBeNull();
    expect(techniqueOfStartCommand("start_eis_extra")).toBeNull();
  });
});

describe("live EIS: Stop then immediate Start", () => {
  it("every start gets a new sweep id and clears the live data of the technique", () => {
    const { result, socket } = connectedHook();
    expect(result.current.eisSweepId).toBe(0);
    act(() => { result.current.sendCommand("start_eis", { freqMin: 1 }); });
    expect(result.current.eisSweepId).toBe(1);
    act(() => { socket.emit({ type: "eis_status", status: "running" }); });
    for (let i = 0; i < 5; i++) act(() => { socket.emit(eisFrame(i)); });
    expect(result.current.eisData).toHaveLength(5);

    act(() => { result.current.sendCommand("stop"); });
    expect(result.current.eisSweepId).toBe(1);          // a stop does not open a sweep
    expect(result.current.eisData).toHaveLength(5);     // and does not clear anything

    act(() => { result.current.sendCommand("start_eis", { freqMin: 1 }); });
    expect(result.current.eisSweepId).toBe(2);
    expect(result.current.eisData).toHaveLength(0);
    expect(result.current.eisStatus).toBe("idle");
    expect(socket.commands()).toEqual(["start_eis", "stop", "start_eis"]);
  });

  it("late points, 'stopped' and 'idle' of the old sweep neither mix in nor end the new sweep", () => {
    const { result, socket } = connectedHook();
    act(() => { result.current.sendCommand("start_eis"); });
    act(() => { socket.emit({ type: "eis_status", status: "running" }); });
    for (let i = 0; i < 4; i++) act(() => { socket.emit(eisFrame(i)); });
    act(() => { result.current.sendCommand("stop"); });
    act(() => { socket.emit({ type: "eis_status", status: "idle" }); });        // bridge.py, right after the stop
    act(() => { result.current.sendCommand("start_eis"); });                  // the user presses Start at once

    // what the device still had to say about the old sweep
    act(() => { socket.emit(eisFrame(4)); });
    act(() => { socket.emit({ type: "eis_status", status: "stopped", points: 5 }); });
    act(() => { socket.emit({ type: "eis_status", status: "idle" }); });
    act(() => { socket.emit({ type: "eis_done", points: 5 }); });
    expect(result.current.eisData).toHaveLength(0);
    expect(result.current.eisStatus).toBe("idle");     // not "stopped" or "done": the page would close the new sweep

    // the new sweep
    act(() => { socket.emit({ type: "eis_status", status: "running" }); });
    expect(result.current.eisStatus).toBe("running");
    for (let i = 0; i < 3; i++) act(() => { socket.emit(eisFrame(10 + i)); });
    expect(result.current.eisData.map((p) => p.zReal)).toEqual([110, 111, 112]);
    expect(result.current.eisStatus).toBe("running");

    act(() => { socket.emit({ type: "eis_done", points: 3 }); });
    expect(result.current.eisStatus).toBe("done");
    expect(result.current.eisSweepId).toBe(2);
  });

  it("points that arrive after the new start, before it is running, are the old sweep's", () => {
    const { result, socket } = connectedHook();
    act(() => { result.current.sendCommand("start_eis"); });
    act(() => { socket.emit({ type: "eis_status", status: "running" }); });
    act(() => { socket.emit(eisFrame(0)); });
    act(() => { result.current.sendCommand("start_eis"); });
    for (let i = 1; i < 4; i++) act(() => { socket.emit(eisFrame(i)); });
    expect(result.current.eisData).toHaveLength(0);
    act(() => { socket.emit({ type: "eis_status", status: "running" }); });
    act(() => { socket.emit(eisFrame(20)); });
    expect(result.current.eisData).toHaveLength(1);
    expect(result.current.eisData[0].zReal).toBe(120);
  });

  it("an error is never ignored: a start that fails is reported", () => {
    const { result, socket } = connectedHook();
    act(() => { result.current.sendCommand("start_eis"); });
    act(() => { socket.emit({ type: "eis_status", status: "error" }); });
    expect(result.current.eisStatus).toBe("error");
    // and the gate is open: the next messages count
    act(() => { socket.emit(eisFrame(0)); });
    expect(result.current.eisData).toHaveLength(1);
  });

  it("stops waiting for 'running' after the timeout (a device that never confirms)", () => {
    const { result, socket } = connectedHook();
    act(() => { result.current.sendCommand("start_eis"); });
    act(() => { socket.emit(eisFrame(0)); });
    expect(result.current.eisData).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(START_ACK_TIMEOUT_MS + 1); });
    act(() => { socket.emit(eisFrame(1)); });
    expect(result.current.eisData).toHaveLength(1);
  });

  it("without a start from this app (a reconnect during a sweep) the messages are taken as they come", () => {
    const { result, socket } = connectedHook();
    act(() => { socket.emit(eisFrame(0)); });
    act(() => { socket.emit({ type: "eis_status", status: "stopped" }); });
    expect(result.current.eisData).toHaveLength(1);
    expect(result.current.eisStatus).toBe("stopped");
  });

  it("nothing changes when the socket is not open (the start was not sent)", () => {
    const { result, socket } = connectedHook();
    socket.readyState = 3;
    act(() => { result.current.sendCommand("start_eis"); });
    expect(result.current.eisSweepId).toBe(0);
    expect(socket.sent).toHaveLength(0);
  });
});

describe("live CV, SWV and BioFET: the same", () => {
  it("CV: late 'done' and 'idle' of the old sweep do not end the new one", () => {
    const { result, socket } = connectedHook();
    act(() => { result.current.sendCommand("start_cv"); });
    act(() => { socket.emit({ type: "cv_status", status: "running" }); });
    for (let i = 0; i < 6; i++) act(() => { socket.emit(cvFrame(i)); });
    act(() => { result.current.sendCommand("stop"); });
    act(() => { result.current.sendCommand("start_cv"); });
    expect(result.current.cvSweepId).toBe(2);
    expect(result.current.cvData).toHaveLength(0);

    act(() => { socket.emit(cvFrame(6)); });
    act(() => { socket.emit({ type: "cv_status", status: "idle" }); });
    act(() => { socket.emit({ type: "cv_done", points: 7 }); });
    act(() => { socket.emit({ type: "cv_status", status: "done" }); });
    expect(result.current.cvData).toHaveLength(0);
    expect(result.current.cvStatus).toBe("idle");

    act(() => { socket.emit({ type: "cv_status", status: "running" }); });
    for (let i = 0; i < 3; i++) act(() => { socket.emit(cvFrame(i)); });
    expect(result.current.cvStatus).toBe("running");
    expect(result.current.cvData).toHaveLength(3);
  });

  it("CV: an error of the start (a command cut on the way) reaches the app", () => {
    const { result, socket } = connectedHook();
    act(() => { result.current.sendCommand("start_cv"); });
    act(() => { socket.emit({ type: "cv_error", message: "the start command arrived cut short" }); });
    expect(result.current.cvStatus).toBe("error");
    expect(result.current.cvError).toContain("cut short");
  });

  it("SWV: points and 'done' of the old sweep are ignored, the new sweep is clean", () => {
    const { result, socket } = connectedHook();
    act(() => { result.current.sendCommand("start_swv"); });
    act(() => { socket.emit({ type: "swv_status", status: "running" }); });
    for (let i = 0; i < 5; i++) act(() => { socket.emit(swvFrame(i)); });
    act(() => { result.current.sendCommand("stop"); });
    act(() => { result.current.sendCommand("start_swv"); });
    expect(result.current.swvSweepId).toBe(2);

    act(() => { socket.emit(swvFrame(5)); });
    act(() => { socket.emit({ type: "swv_status", status: "idle" }); });
    act(() => { socket.emit({ type: "swv_done", points: 6 }); });
    expect(result.current.swvData).toHaveLength(0);
    expect(result.current.swvStatus).toBe("idle");

    act(() => { socket.emit({ type: "swv_status", status: "running" }); });
    for (let i = 0; i < 2; i++) act(() => { socket.emit(swvFrame(i)); });
    expect(result.current.swvData.map((p) => p.index)).toEqual([0, 1]);     // the index starts again at 0
    expect(result.current.swvStatus).toBe("running");
  });

  it("BioFET: the same", () => {
    const { result, socket } = connectedHook();
    act(() => { result.current.sendCommand("start_fet"); });
    act(() => { socket.emit({ type: "fet_status", status: "running" }); });
    for (let i = 0; i < 3; i++) act(() => { socket.emit(fetFrame(i)); });
    act(() => { result.current.sendCommand("stop"); });
    act(() => { result.current.sendCommand("start_fet"); });
    act(() => { socket.emit(fetFrame(3)); });
    act(() => { socket.emit({ type: "fet_status", status: "idle" }); });
    act(() => { socket.emit({ type: "fet_done" }); });
    expect(result.current.fetBaseline).toHaveLength(0);
    expect(result.current.fetStatus).toBe("idle");
    act(() => { socket.emit({ type: "fet_status", status: "running" }); });
    act(() => { socket.emit(fetFrame(0)); });
    expect(result.current.fetBaseline).toHaveLength(1);
    expect(result.current.fetStatus).toBe("running");
  });

  it("a start of one technique leaves the others alone", () => {
    const { result, socket } = connectedHook();
    act(() => { socket.emit({ type: "eis_status", status: "running" }); });
    act(() => { socket.emit(eisFrame(0)); });
    act(() => { result.current.sendCommand("start_cv"); });
    act(() => { socket.emit(eisFrame(1)); });
    expect(result.current.eisData).toHaveLength(2);
    expect(result.current.eisSweepId).toBe(0);
    expect(result.current.cvSweepId).toBe(1);
  });
});

describe("in-browser simulated source: Stop then immediate Start", () => {
  it("EIS: a new sweep id, the data cleared, and no point of the old run afterwards", () => {
    const { result } = renderHook(() => useSimulatedEIS(10));
    act(() => { result.current.start(0, 20, 1, 1e5); });
    expect(result.current.sweepId).toBe(1);
    act(() => { vi.advanceTimersByTime(55); });
    expect(result.current.data.length).toBeGreaterThan(2);
    const before = result.current.data.length;

    act(() => { result.current.stop(); });
    act(() => { result.current.start(0, 20, 1, 1e5); });
    expect(result.current.sweepId).toBe(2);
    expect(result.current.data).toHaveLength(0);
    expect(result.current.isRunning).toBe(true);

    act(() => { vi.advanceTimersByTime(25); });
    const d = result.current.data;
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThan(before);
    expect(d[0].frequency).toBe(1e5);                       // the new sweep starts again at the top
    expect(d.map((p) => p.frequency)).toEqual([...d.map((p) => p.frequency)].sort((a, b) => b - a));   // one sweep, descending
  });

  it("CV: a new sweep id and a clean trace that starts again at the first potential", () => {
    const { result } = renderHook(() => useSimulatedCVData(5));
    const params = { ...DEFAULT_CV_PARAMS, cvModel: "reversible" as const };
    act(() => { result.current.start(params); });
    act(() => { vi.advanceTimersByTime(30); });
    expect(result.current.data.length).toBeGreaterThan(0);
    act(() => { result.current.stop(); });
    act(() => { result.current.start(params); });
    expect(result.current.sweepId).toBe(2);
    expect(result.current.data).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(12); });
    expect(result.current.data[0].E).toBeCloseTo(params.eStart, 6);
    expect(result.current.isRunning).toBe(true);
    act(() => { vi.advanceTimersByTime(5000); });
    const times = result.current.data.map((p) => p.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));   // one run, in order, no points of the old one
    expect(result.current.isRunning).toBe(false);
  });

  it("SWV: a new sweep id, one timer, and the data of the new run only", () => {
    const params: SWVParameters = {
      startE: -0.2, endE: 0.6, step_mV: 4, amplitude_mV: 25, frequency_Hz: 25,
      quietTime_s: 1, direction: "anodic", baselineMethod: "auto",
    };
    const { result } = renderHook(() => useSimulatedSWVData());
    act(() => { result.current.start(params); });
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.data.length).toBeGreaterThan(5);
    act(() => { result.current.stop(); });
    act(() => { result.current.start(params); });
    expect(result.current.sweepId).toBe(2);
    expect(result.current.data).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(200); });
    const n = result.current.data.length;
    expect(n).toBeGreaterThan(0);
    expect(result.current.data[0].index).toBe(0);
    // a single timer: 200 ms at 25 Hz is about 5 points, not 10 from two timers
    expect(n).toBeLessThanOrEqual(6);
    expect(result.current.isRunning).toBe(true);
  });
});
