import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSweepCompletion,
  SIM_INACTIVITY_MS,
  LIVE_FALLBACK_MS,
  type SweepCompletionReason,
} from "@/hooks/useSweepCompletion";
import { useWebSocketData } from "@/hooks/useWebSocketData";

/**
 * Real hardware takes several seconds per low-frequency EIS point (a 1 Hz to
 * 100 kHz sweep takes about 270 s), so the app must not treat a 2 s pause as
 * the end of a live sweep. The simulator has no "done" message and keeps the
 * 2 s rule.
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Props {
  running?: boolean;
  live?: boolean;
  ready?: boolean;
  activity?: number;
  deviceDone?: boolean;
}

function setup(initial: Props) {
  const onComplete = vi.fn<(r: SweepCompletionReason) => void>();
  const hook = renderHook(
    (p: Props) =>
      useSweepCompletion({
        running: true,
        live: false,
        ready: true,
        activity: 0,
        deviceDone: false,
        ...p,
        onComplete,
      }),
    { initialProps: initial },
  );
  return { onComplete, ...hook };
}

describe("sweep completion policy", () => {
  it("simulated: completes after 2 s of inactivity", () => {
    const { onComplete } = setup({ live: false, activity: 12 });
    act(() => { vi.advanceTimersByTime(SIM_INACTIVITY_MS - 1); });
    expect(onComplete).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("inactivity");
  });

  it("simulated: a new point restarts the 2 s window", () => {
    const { onComplete, rerender } = setup({ live: false, activity: 12 });
    act(() => { vi.advanceTimersByTime(1500); });
    rerender({ live: false, activity: 13 });
    act(() => { vi.advanceTimersByTime(1500); });
    expect(onComplete).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(500); });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("simulated: ignores a device-done flag", () => {
    const { onComplete } = setup({ live: false, ready: false, deviceDone: true });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("live: does not complete after 2 s, nor after a long pause between points", () => {
    const { onComplete } = setup({ live: true, activity: 12 });
    act(() => { vi.advanceTimersByTime(SIM_INACTIVITY_MS); });
    expect(onComplete).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(LIVE_FALLBACK_MS - SIM_INACTIVITY_MS - 1); });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("live: a point every 10 s never trips the fallback", () => {
    const { onComplete, rerender } = setup({ live: true, activity: 1 });
    for (let n = 2; n <= 40; n++) {
      act(() => { vi.advanceTimersByTime(10_000); });
      rerender({ live: true, activity: n });
    }
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("live: completes when the device reports done", () => {
    const { onComplete, rerender } = setup({ live: true, activity: 35 });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onComplete).not.toHaveBeenCalled();
    rerender({ live: true, activity: 35, deviceDone: true });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("done");
  });

  it("live: falls back after 180 s without a new point and without done", () => {
    const { onComplete } = setup({ live: true, activity: 20 });
    act(() => { vi.advanceTimersByTime(LIVE_FALLBACK_MS - 1); });
    expect(onComplete).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("fallback");
  });

  it("does nothing while the sweep is not running", () => {
    const { onComplete } = setup({ running: false, live: false, activity: 12, deviceDone: true });
    act(() => { vi.advanceTimersByTime(LIVE_FALLBACK_MS * 2); });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("is not armed until enough data has arrived", () => {
    const { onComplete } = setup({ live: false, ready: false });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

/** Minimal WebSocket stand-in so the real hook can be driven with frames. */
class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
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

const eisFrame = (i: number) => ({
  type: "eis", zReal: 100 + i, zImag: -50 - i, frequency: 100000 / (i + 1), zMag: 120, phase: -20,
});

describe("live EIS: device status from the WebSocket hook drives completion", () => {
  it("tracks eis_status and eis_done, and clearEIS resets it", () => {
    const { result, socket } = connectedHook();
    expect(result.current.eisStatus).toBe("idle");
    act(() => { socket.emit({ type: "eis_status", status: "running" }); });
    expect(result.current.eisStatus).toBe("running");
    act(() => { socket.emit({ type: "eis_done", points: 35 }); });
    expect(result.current.eisStatus).toBe("done");
    // The firmware also sends eis_status "done" right after eis_done
    act(() => { socket.emit({ type: "eis_status", status: "done" }); });
    expect(result.current.eisStatus).toBe("done");
    act(() => { result.current.clearEIS(); });
    expect(result.current.eisStatus).toBe("idle");
  });

  it("completes a slow live sweep on eis_done, with no stop sent and no early completion", () => {
    const { result, socket } = connectedHook();
    const onComplete = vi.fn<(r: SweepCompletionReason) => void>();
    const { rerender } = renderHook(
      ({ ws }: { ws: ReturnType<typeof useWebSocketData> }) =>
        useSweepCompletion({
          running: true,
          live: true,
          ready: ws.eisData.length >= 1,
          activity: ws.eisData.length,
          deviceDone: ws.eisStatus === "done",
          onComplete,
        }),
      { initialProps: { ws: result.current } },
    );

    act(() => { socket.emit({ type: "eis_status", status: "running" }); });
    // 35 points, one every 8 s, as on the board at low frequency
    for (let i = 0; i < 35; i++) {
      act(() => { socket.emit(eisFrame(i)); });
      rerender({ ws: result.current });
      act(() => { vi.advanceTimersByTime(8000); });
    }
    expect(result.current.eisData).toHaveLength(35);
    expect(onComplete).not.toHaveBeenCalled();

    act(() => { socket.emit({ type: "eis_done", points: 35 }); });
    rerender({ ws: result.current });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("done");
    expect(result.current.eisData).toHaveLength(35);
    expect(socket.sent).toHaveLength(0);
  });

  it("keeps appending points that arrive while the device is still running", () => {
    const { result, socket } = connectedHook();
    act(() => { socket.emit({ type: "eis_status", status: "running" }); });
    for (let i = 0; i < 40; i++) act(() => { socket.emit(eisFrame(i)); });
    expect(result.current.eisData).toHaveLength(40);
    expect(result.current.eisStatus).toBe("running");
  });

  it("tracks fet_status and fet_done the same way", () => {
    const { result, socket } = connectedHook();
    act(() => { socket.emit({ type: "fet_status", status: "running" }); });
    expect(result.current.fetStatus).toBe("running");
    act(() => { socket.emit({ type: "fet_done", transferPoints: 51, timePoints: 120 }); });
    expect(result.current.fetStatus).toBe("done");
    act(() => { result.current.clearFET(); });
    expect(result.current.fetStatus).toBe("idle");
  });
});
