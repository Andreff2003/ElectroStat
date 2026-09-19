import type { CVMetrics } from "@/utils/computeCVMetrics";

export type CVQualityLevel = "green" | "yellow" | "red" | "idle";

export interface CVQualityLevels {
  level: CVQualityLevel;
  ready: boolean;
  peakLevel: CVQualityLevel;
  snrLevel: CVQualityLevel;
}

/**
 * Pure derivation of the CV signal-quality traffic-light levels.
 *
 * The light answers "is this a trustworthy measurement?", so it uses the same
 * rule as the other techniques (all green -> green, any red -> red, otherwise
 * yellow) over the two criteria that describe the measurement itself: both
 * peaks found, and SNR.
 *
 * ΔEp, |Ipa/Ipc|, the reversibility class and D apparent describe the redox
 * system (rate constant, follow-up chemistry), not the measurement, so they
 * are not part of this light; they are reported in the CV metrics grid.
 */
export function computeCVSignalQuality(
  metrics: CVMetrics | null | undefined,
): CVQualityLevels {
  if (!metrics) {
    return { level: "idle", ready: false, peakLevel: "idle", snrLevel: "idle" };
  }
  const { hasAnodic, hasCathodic, SNR_anodic, SNR_cathodic } = metrics;

  const peaksFound = (hasAnodic ? 1 : 0) + (hasCathodic ? 1 : 0);
  const peakLevel: CVQualityLevel =
    peaksFound === 2 ? "green" : peaksFound === 1 ? "yellow" : "red";
  const snr = Math.min(SNR_anodic, SNR_cathodic);
  const snrLevel: CVQualityLevel =
    snr >= 10 ? "green" : snr >= 3 ? "yellow" : "red";

  const levels = [peakLevel, snrLevel];
  const level: CVQualityLevel = levels.every((l) => l === "green")
    ? "green"
    : levels.some((l) => l === "red")
      ? "red"
      : "yellow";

  return { level, ready: true, peakLevel, snrLevel };
}
