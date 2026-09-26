import { describe, it, expect } from "vitest";
import {
  computeFETTransferMetrics,
  inferFETResponseSign,
  applyFETResponseMode,
} from "@/utils/fetMetrics";
import { fetDrainCurrent } from "@/utils/fetModel";
import { computeFETVtDetailed } from "@/utils/fetVt";
import type { FETTransferPoint } from "@/hooks/useSimulatedData";

function syntheticTransfer(vt: number, npts = 51): FETTransferPoint[] {
  const out: FETTransferPoint[] = [];
  for (let i = 0; i < npts; i++) {
    const vg = -0.5 + (2.0 * i) / (npts - 1);
    out.push({ vg, id: fetDrainCurrent(vg, vt, { K: 50, n: 2 }) });
  }
  return out;
}

describe("computeFETTransferMetrics", () => {
  it("computes ΔVt from baseline/analyte of the same measurement", () => {
    const baseline = syntheticTransfer(0.30);
    const analyte = syntheticTransfer(0.35);
    const m = computeFETTransferMetrics(baseline, analyte, { responseMode: "signed" });
    expect(m.vtBaseline).not.toBeNull();
    expect(m.vtAnalyte).not.toBeNull();
    expect(m.deltaVt_mV).not.toBeNull();
    expect(m.deltaVt_mV!).toBeGreaterThan(30);
    expect(m.deltaVt_mV!).toBeLessThan(70);
    expect(m.deltaVt_mV_signed).toBe(m.deltaVt_mV);
    expect(m.calibrationSignal_mV_used).toBe(m.deltaVt_mV);
  });

  it("auto mode infers negative sign and aligns Langmuir signal positive", () => {
    const baseline = syntheticTransfer(0.30);
    const analyte = syntheticTransfer(0.25); // negative ΔVt
    const sign = inferFETResponseSign([-12, -10, -15]);
    expect(sign).toBe(-1);
    const m = computeFETTransferMetrics(baseline, analyte, { responseMode: "auto", responseSign: sign });
    expect(m.deltaVt_mV!).toBeLessThan(0);
    expect(m.calibrationSignal_mV_used!).toBeGreaterThan(0);
  });

  it("absolute mode returns |ΔVt|", () => {
    const r = applyFETResponseMode(-25, "absolute");
    expect(r.calibrationSignal_mV_used).toBe(25);
  });
});

describe("computeFETTransferMetrics: both curves are read by the same Vt method", () => {
  it("when only one curve needs the constant-current fallback, the other is re-read with it and a warning is added", () => {
    const good = syntheticTransfer(0.30);
    // an 11-point analyte curve leaves only 2 points in the 20-80 % window, so the square-root fit is refused
    const poor = syntheticTransfer(0.30, 11);
    expect(computeFETVtDetailed(good).method).toBe("sqrt_extrapolation");
    expect(computeFETVtDetailed(poor).method).toBe("constant_current_fallback");
    const m = computeFETTransferMetrics(good, poor);
    expect(m.vtAnalyteMethod).toBe("constant_current_fallback");
    expect(m.vtBaselineMethod).toBe("constant_current_fallback"); // was "sqrt_extrapolation" before the fix
    expect(m.warnings?.some((w) => /both curves/.test(w))).toBe(true);
    // and the shift is now that of two like-for-like readings, not hundreds of mV off
    expect(Math.abs(m.deltaVt_mV!)).toBeLessThan(60);
  });
});
