import type { CVMetrics } from "@/utils/computeCVMetrics";
import { CV_DELTA_EP_REVERSIBLE_MV } from "@/utils/cvConstants";

export type CVQualityLevel = "green" | "yellow" | "red" | "idle";

export interface CVQualityLevels {
  level: CVQualityLevel;
  ready: boolean;
  /** Always "idle": how many peaks were found does not colour the light, it is reported on its own line. */
  peakLevel: CVQualityLevel;
  snrLevel: CVQualityLevel;
  resolutionLevel: CVQualityLevel;
  /** Peaks found, 0 to 2, for the neutral "Peaks: 1 of 2 found" line. */
  peaksFound: number;
  /** The current stays at about zero over the whole scan: nothing is connected, or the electrode is not in the solution. */
  currentFlat: boolean;
  /** The signal-to-noise ratio the light is based on. NaN when it cannot be told. */
  snr: number;
}

export interface CVQualityOptions {
  /** Potential step between consecutive points, in mV (see estimateCVStepMv). */
  stepMv?: number | null;
  /** Electrons transferred; sets the width of the feature being resolved. */
  n?: number;
  /** Largest minus smallest raw current of the scan, in µA. Lets the light tell a flat trace from a quiet one. */
  currentSpan_uA?: number | null;
}

/** The noise below which the estimate is a floor and not a measurement (see computeCVMetrics). */
const NOISE_FLOOR_UA = 0.05 / 3;

/**
 * Median potential increment along a scan, ignoring the jumps at vertices.
 * Works for any point list with an `E` (V) and an optional `cycle` (SWV has none).
 */
export function estimateCVStepMv(
  data: { E: number; cycle?: number }[] | undefined | null,
): number | null {
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
 * yellow) over the criteria that describe the measurement itself: the
 * signal-to-noise ratio and the scan resolution (the app adds the count of
 * points outside the ADC window). How many peaks were found does not colour the
 * light: a dummy cell has none, a real CV of a probe that is not reversible may
 * show one, and neither is a bad signal. The SNR is that of the best peak found;
 * with no peak it is the swing of the current over the noise. Only a current
 * that stays at about zero over the whole scan is reported as a connection
 * problem. A reversible peak pair is ~57/n mV wide, so
 * the potential step must put enough points across that width to locate Ep
 * (the ΔEp resolution is one step); ≥10 points per 57/n mV is green, ≥5 yellow.
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
      peaksFound: 0,
      currentFlat: false,
      snr: NaN,
    };
  }
  const { hasAnodic, hasCathodic, SNR_anodic, SNR_cathodic } = metrics;

  const peaksFound = (hasAnodic ? 1 : 0) + (hasCathodic ? 1 : 0);
  const peakLevel: CVQualityLevel = "idle";
  const noise = Math.max(Number.isFinite(metrics.noise_uA) ? metrics.noise_uA : 0, NOISE_FLOOR_UA);
  const span = opts.currentSpan_uA;
  const currentFlat = span != null && Number.isFinite(span) && span < Math.max(0.2, 5 * noise);
  const snr =
    peaksFound > 0
      ? Math.max(hasAnodic ? SNR_anodic : -Infinity, hasCathodic ? SNR_cathodic : -Infinity)
      : span != null && Number.isFinite(span)
        ? span / (2 * noise)
        : Math.max(SNR_anodic, SNR_cathodic);
  const snrLevel: CVQualityLevel = currentFlat
    ? "red"
    : snr >= 10 ? "green" : snr >= 3 ? "yellow" : "red";

  let resolutionLevel: CVQualityLevel = "idle";
  if (opts.stepMv != null && opts.stepMv > 0) {
    const pointsPerFeature = CV_DELTA_EP_REVERSIBLE_MV / Math.max(1, opts.n ?? 1) / opts.stepMv;
    resolutionLevel =
      pointsPerFeature >= 10 ? "green" : pointsPerFeature >= 5 ? "yellow" : "red";
  }

  const levels = [snrLevel, ...(resolutionLevel === "idle" ? [] : [resolutionLevel])];
  const level: CVQualityLevel = levels.every((l) => l === "green")
    ? "green"
    : levels.some((l) => l === "red")
      ? "red"
      : "yellow";

  return { level, ready: true, peakLevel, snrLevel, resolutionLevel, peaksFound, currentFlat, snr };
}
