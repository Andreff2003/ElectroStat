import { describe, it, expect } from "vitest";
import {
  LIVE_SWV_MAX_FREQUENCY_HZ,
  analyzeSWV,
  liveSWVWarnings,
  validateSWVParameters,
  validateSWVParametersFor,
} from "@/utils/swvMetrics";
import { buildSWVExportText } from "@/utils/csvExport";
import type { SWVDataPoint, SWVParameters } from "@/types/swv";

/**
 * On the assembled board the applied potential settles with a time constant of about 23 ms, so above 10 Hz a live
 * square-wave pulse does not reach its amplitude and the peak currents are underestimated. Live mode warns (it
 * never blocks the start); simulated mode has no such limit.
 */

const params = (frequency_Hz: number): SWVParameters => ({
  startE: -0.2, endE: 0.6, step_mV: 4, amplitude_mV: 25, frequency_Hz, quietTime_s: 2, direction: "anodic", baselineMethod: "auto",
});

describe("live SWV frequency warning", () => {
  it("the limit is 10 Hz", () => {
    expect(LIVE_SWV_MAX_FREQUENCY_HZ).toBe(10);
  });

  it("no warning at 5 Hz and at 10 Hz", () => {
    expect(liveSWVWarnings(params(5))).toEqual([]);
    expect(liveSWVWarnings(params(10))).toEqual([]);
  });

  it("one warning at 10.1 Hz and at 25 Hz, with the numbers", () => {
    for (const f of [10.1, 25]) {
      const w = liveSWVWarnings(params(f));
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("Live mode: above 10 Hz");
      expect(w[0]).toContain("about 23 ms");
      expect(w[0]).toContain("about 80 % of its amplitude at 10 Hz and 42 % at 25 Hz");
      expect(w[0]).toContain("Use 10 Hz or below.");
    }
  });

  it("live mode adds it to the validation warnings, without making the parameters invalid; simulated mode does not", () => {
    const live = validateSWVParametersFor(params(25), "live");
    const sim = validateSWVParametersFor(params(25), "simulated");
    expect(live.ok).toBe(true);
    expect(live.warnings).toEqual([...validateSWVParameters(params(25)).warnings, ...liveSWVWarnings(params(25))]);
    expect(sim).toEqual(validateSWVParameters(params(25)));
    expect(sim.warnings.some((w) => /Live mode/.test(w))).toBe(false);
    expect(validateSWVParametersFor(params(10), "live")).toEqual(validateSWVParameters(params(10)));
  });

  it("the warning goes to the warnings of the export", () => {
    const data: SWVDataPoint[] = Array.from({ length: 100 }, (_, i) => ({
      E: -0.2 + i * 0.008, IForward: 2, IReverse: 1, INet: 1 + Math.exp(-(((i - 50) / 8) ** 2)), time: i * 0.04, index: i, direction: "anodic" as const,
    }));
    const { metrics, corrected } = analyzeSWV(data, "auto");
    const extra = liveSWVWarnings(params(25));
    const text = buildSWVExportText({
      data, corrected, metrics: { ...metrics, warnings: [...metrics.warnings, ...extra] }, params: params(25), source: "live", measurementId: "swv_f",
    });
    expect(text).toContain("Live mode: above 10 Hz the board’s potential does not settle within a pulse");
  });
});
