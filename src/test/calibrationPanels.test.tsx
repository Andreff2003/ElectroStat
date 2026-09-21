import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import CalibrationPanel, { type CalibrationPoint } from "@/components/CalibrationPanel";
import { summarizeCalibration } from "@/utils/cvCalibration";

// jsdom has no ResizeObserver; Recharts' ResponsiveContainer needs one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const noop = () => {};
const pt = (c: number, signal: number): CalibrationPoint => ({
  concentration: c,
  signal,
  raw: signal,
  timestamp: 0,
});

function renderPanel(mode: "swv" | "eis", points: CalibrationPoint[]) {
  return render(
    <CalibrationPanel
      mode={mode}
      concentration={0}
      onChangeConcentration={noop}
      points={points}
      onClear={noop}
      onExport={noop}
    />,
  );
}

describe("calibration panels — empty state and intercept", () => {
  it("CV: no measurements gives an idle verdict, not a red one", () => {
    const s = summarizeCalibration([], "mean");
    expect(s.quality).toBe("idle");
    expect(s.qualityReasons).toEqual(["add calibration measurements"]);
  });

  it("SWV/EIS panel: no measurements shows a neutral quality, not RED", () => {
    renderPanel("swv", []);
    expect(screen.queryByText("red")).toBeNull();
    expect(screen.getByText("add calibration measurements", { exact: false })).toBeInTheDocument();
  });

  it("SWV panel shows the fitted intercept; a Langmuir mode (EIS) does not", () => {
    // signal = 2·C + 5 exactly
    const pts = [pt(0, 0), pt(10, 25), pt(20, 45), pt(40, 85), pt(80, 165)];
    const { unmount } = renderPanel("swv", pts);
    expect(screen.getByText(/Intercept/)).toBeInTheDocument();
    expect(screen.getByText(/5\.000/)).toBeInTheDocument();
    unmount();
    renderPanel("eis", pts);
    expect(screen.queryByText(/Intercept/)).toBeNull();
  });
});
