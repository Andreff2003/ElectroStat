import type { CVMetrics } from "@/utils/computeCVMetrics";
import type { CVDataPoint } from "@/hooks/useSimulatedCVData";

export type CVQualityLevel = "green" | "yellow" | "red" | "idle";

export interface CVQualityLevels {
  level: CVQualityLevel;
  ready: boolean;
  peakLevel: CVQualityLevel;
  snrLevel: CVQualityLevel;
  resolutionLevel: CVQualityLevel;
}

export interface CVQualityOptions {
  /** Potential step between consecutive points, in mV (see estimateCVStepMv). */
  stepMv?: number | null;
  /** Electrons transferred; sets the width of the feature being resolved. */
  n?: number;
}

/** Median potential increment along a scan, ignoring the jumps at vertices. */
export function estimateCVStepMv(data: CVDataPoint[] | undefined | null): number | null {
  if (!data || data.length < 3) return null;
  const steps: number[] = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i].cycle !== data[i - 1].cycle) continue;
    const d = Math.abs(data[i].E - data[i - 1].E) * 1000;
    if (d > 1e-6) steps.push(d);
  }
  if (steps.length === 0) return null;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

/**
 * Pure derivation of the CV signal-quality traffic-light levels.
 *
 * The light answers "is this a trustworthy measurement?", so it uses the same
 * rule as the other techniques (all green -> green, any red -> red, otherwise
 * yellow) over the criteria that describe the measurement itself: both peaks
 * found, SNR, and scan resolution. A reversible peak pair is ~59/n mV wide, so
 * the potential step must put enough points across that width to locate Ep
 * (the ΔEp resolution is one step); ≥10 points per 59/n mV is green, ≥5 yellow.
 *
 * ΔEp, |Ipa/Ipc|, the reversibility class and D apparent describe the redox
 * system (rate constant, follow-up chemistry), not the measurement, so they
 * are not part of this light; they are reported in the CV metrics grid.
 */
export function computeCVSignalQuality(
  metrics: CVMetrics | null | undefined,
  opts: CVQualityOptions = {},
): CVQualityLevels {
  if (!metrics) {
    return {
      level: "idle",
      ready: false,
      peakLevel: "idle",
      snrLevel: "idle",
      resolutionLevel: "idle",
    };
  }
  const { hasAnodic, hasCathodic, SNR_anodic, SNR_cathodic } = metrics;

  const peaksFound = (hasAnodic ? 1 : 0) + (hasCathodic ? 1 : 0);
  const peakLevel: CVQualityLevel =
    peaksFound === 2 ? "green" : peaksFound === 1 ? "yellow" : "red";
  const snr = Math.min(SNR_anodic, SNR_cathodic);
  const snrLevel: CVQualityLevel =
    snr >= 10 ? "green" : snr >= 3 ? "yellow" : "red";

  let resolutionLevel: CVQualityLevel = "idle";
  if (opts.stepMv != null && opts.stepMv > 0) {
    const pointsPerFeature = 59.16 / Math.max(1, opts.n ?? 1) / opts.stepMv;
    resolutionLevel =
      pointsPerFeature >= 10 ? "green" : pointsPerFeature >= 5 ? "yellow" : "red";
  }

  const levels = [peakLevel, snrLevel, ...(resolutionLevel === "idle" ? [] : [resolutionLevel])];
  const level: CVQualityLevel = levels.every((l) => l === "green")
    ? "green"
    : levels.some((l) => l === "red")
      ? "red"
      : "yellow";

  return { level, ready: true, peakLevel, snrLevel, resolutionLevel };
}
