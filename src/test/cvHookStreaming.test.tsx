import { StrictMode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSimulatedCVData, DEFAULT_CV_PARAMS, buildCVPointsForTest } from "@/hooks/useSimulatedCVData";

afterEach(() => {
  vi.useRealTimers();
});

describe("useSimulatedCVData streaming", () => {
  it("delivers every simulated point, in order, even when React double-invokes state updaters", () => {
    vi.useFakeTimers();
    const params = { ...DEFAULT_CV_PARAMS, cvModel: "reversible" as const };
    const expected = buildCVPointsForTest(params);
    const { result } = renderHook(() => useSimulatedCVData(1), { wrapper: StrictMode });
    act(() => {
      result.current.start(params);
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.data.length).toBe(expected.length);
    expect(result.current.data.map((p) => p.E)).toEqual(expected.map((p) => p.E));
    expect(result.current.isRunning).toBe(false);
  });
});
