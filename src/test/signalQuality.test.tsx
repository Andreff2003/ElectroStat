import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import SignalQuality, { worstOf } from "@/components/SignalQuality";
import { fetDrainCurrent } from "@/utils/fetModel";
import type { FETTransferPoint } from "@/hooks/useSimulatedData";
import { simulateReversibleDiffusionSWV } from "@/utils/swvDiffusionSolver";
import { analyzeSWV } from "@/utils/swvMetrics";

describe("worstOf", () => {
  it("is green only when every level is green", () => {
    expect(worstOf(["green", "green", "green"])).toBe("green");
  });

  it("is red if any level is red, even surrounded by greens", () => {
    expect(worstOf(["green", "red", "green"])).toBe("red");
  });

  it("is yellow when mixed without any red", () => {
    expect(worstOf(["green", "yellow", "green"])).toBe("yellow");
  });

  it("ignores idle entries instead of treating them as failures", () => {
    expect(worstOf(["idle", "green", "idle"])).toBe("green");
    expect(worstOf(["idle", "red"])).toBe("red");
  });

  it("is idle when every entry is idle, or the list is empty", () => {
    expect(worstOf(["idle", "idle"])).toBe("idle");
    expect(worstOf([])).toBe("idle");
  });
});

/** Clean sigmoidal transfer curve from the same model the app's simulator uses. */
function transferCurve(vt: number, npts = 51): FETTransferPoint[] {
  const out: FETTransferPoint[] = [];
  for (let i = 0; i < npts; i++) {
    const vg = -0.5 + (2.0 * i) / (npts - 1);
    out.push({ vg, id: fetDrainCurrent(vg, vt, { K: 50, n: 2 }) });
  }
  return out;
}

describe("SignalQuality — BioFET lists only electrode-quality criteria", () => {
  it("has no ΔVt row: ΔVt is the analytical result (legitimately ~0 on a blank) and lives in the calibration panel", () => {
    const curve = transferCurve(0.5);
    render(
      <SignalQuality
        mode="fet"
        eisData={[]}
        fetBaseline={curve}
        fetAnalyte={curve}
      />,
    );

    expect(screen.getByText("Good Signal")).toBeInTheDocument();
    expect(screen.queryByText("ΔVt")).toBeNull();
  });

  it("turns the overall semaphore red when an actual electrode-quality metric is bad", () => {
    // Off-region current far above the clean-electrode threshold (Ioff < 1 µA
    // for green, red at >= 5 µA) — a genuinely leaky baseline, not biology.
    const noisyBaseline: FETTransferPoint[] = transferCurve(0.5).map((p) => ({
      ...p,
      id: p.id + 10,
    }));

    render(
      <SignalQuality
        mode="fet"
        eisData={[]}
        fetBaseline={noisyBaseline}
        fetAnalyte={noisyBaseline}
      />,
    );

    expect(screen.getByText("Poor Signal")).toBeInTheDocument();
  });
});

describe("SignalQuality — SWV lists only the criteria that drive the light", () => {
  const params = {
    startE: -0.2, endE: 0.6, step_mV: 4, amplitude_mV: 25, frequency_Hz: 25,
    quietTime_s: 1, direction: "anodic" as const, baselineMethod: "auto" as const,
    cMM: 5, nElectrons: 1, area_cm2: 0.0707,
  };
  const raw = simulateReversibleDiffusionSWV(params);
  const { metrics } = analyzeSWV(raw, "auto");

  it("shows peak, SNR and scan resolution, and not the system descriptors", () => {
    render(
      <SignalQuality
        mode="swv"
        eisData={[]}
        fetBaseline={[]}
        fetAnalyte={[]}
        swvData={raw}
        swvMetrics={metrics}
      />,
    );
    expect(screen.getByText("Good Signal")).toBeInTheDocument();
    expect(screen.getByText("Peak detected")).toBeInTheDocument();
    expect(screen.getByText("SNR")).toBeInTheDocument();
    expect(screen.getByText("Scan Resolution")).toBeInTheDocument();
    expect(screen.queryByText("Points")).toBeNull();
    expect(screen.queryByText("Half-peak width")).toBeNull();
    expect(screen.queryByText("Baseline stability")).toBeNull();
  });
});

describe("SignalQuality — SWV scan resolution follows the staircase step", () => {
  const mk = (step_mV: number) => {
    const raw = simulateReversibleDiffusionSWV({
      startE: -0.2, endE: 0.6, step_mV, amplitude_mV: 25, frequency_Hz: 25,
      quietTime_s: 1, direction: "anodic", baselineMethod: "auto",
      cMM: 5, nElectrons: 1, area_cm2: 0.0707,
    });
    return { raw, metrics: analyzeSWV(raw, "auto").metrics };
  };
  const overall = (step: number) => {
    const { raw, metrics } = mk(step);
    const { container, unmount } = render(
      <SignalQuality mode="swv" eisData={[]} fetBaseline={[]} fetAnalyte={[]} swvData={raw} swvMetrics={metrics} />,
    );
    const label = container.querySelector('[role="img"]')?.getAttribute("aria-label");
    unmount();
    return label;
  };

  it("fine step is good, ~20 mV step is acceptable, 50 mV step is poor", () => {
    expect(overall(4)).toContain("good");
    expect(overall(20)).toContain("acceptable");
    expect(overall(50)).toContain("poor");
  });
});
