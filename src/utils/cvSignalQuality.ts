import type { CVMetrics } from "@/utils/computeCVMetrics";

export type CVQualityLevel = "green" | "yellow" | "red" | "idle";

export interface CVQualityLevels {
  level: CVQualityLevel;
  ready: boolean;
  reversibilityLevel: CVQualityLevel;
  deltaEpLevel: CVQualityLevel;
  ratioLevel: CVQualityLevel;
  peakLevel: CVQualityLevel;
  dLevel: CVQualityLevel;
  snrLevel: CVQualityLevel;
}

/**
 * Pure derivation of the CV signal-quality traffic-light levels.
 * Extracted from SignalQuality.tsx so the rules are unit-testable.
 *
 * The overall light answers "is this a trustworthy measurement?", so it is
 * driven only by data-quality criteria: both peaks found, SNR, and the
 * baseline-corrected |Ipa/Ipc| (a chemical-stability / baseline check that
 * stays near 1 for a stable couple at any kinetics).
 * ΔEp, the reversibility class and D apparent are properties of the redox
 * system (rate constant k0), not of the measurement: a perfectly clean
 * quasi-reversible scan has ΔEp > 59/n mV by physics and re-measuring cannot
 * change that. They keep their own per-row colours but never set the overall
 * light, otherwise a good quasi-reversible measurement could never be green.
 */
export function computeCVSignalQuality(
  metrics: CVMetrics | null | undefined,
  nElectrons = 1,
  deltaEpToleranceMv = 20,
): CVQualityLevels {
  if (!metrics) {
    return {
      level: "idle",
      ready: false,
      reversibilityLevel: "idle",
      deltaEpLevel: "idle",
      ratioLevel: "idle",
      peakLevel: "idle",
      dLevel: "idle",
      snrLevel: "idle",
    };
  }
  const {
    reversibility,
    deltaEp,
    IpaIpcRatio,
    hasAnodic,
    hasCathodic,
    D_status,
    SNR_anodic,
    SNR_cathodic,
  } = metrics;

  const reversibilityLevel: CVQualityLevel =
    reversibility === "reversible"
      ? "green"
      : reversibility === "quasi-reversible"
        ? "yellow"
        : "red";

  const expected = 59.16 / Math.max(1, nElectrons);
  const tol = Math.max(5, deltaEpToleranceMv);
  let deltaEpLevel: CVQualityLevel = "red";
  if (Number.isFinite(deltaEp)) {
    const dev = Math.abs(deltaEp - expected);
    if (dev <= tol) deltaEpLevel = "green";
    else if (dev <= 3 * tol) deltaEpLevel = "yellow";
  }

  const ratioLevel: CVQualityLevel =
    Number.isFinite(IpaIpcRatio) && IpaIpcRatio >= 0.9 && IpaIpcRatio <= 1.1
      ? "green"
      : Number.isFinite(IpaIpcRatio) && IpaIpcRatio >= 0.7 && IpaIpcRatio <= 1.3
        ? "yellow"
        : "red";
  const peaksFound = (hasAnodic ? 1 : 0) + (hasCathodic ? 1 : 0);
  const peakLevel: CVQualityLevel =
    peaksFound === 2 ? "green" : peaksFound === 1 ? "yellow" : "red";
  const snr = Math.min(SNR_anodic, SNR_cathodic);
  const snrLevel: CVQualityLevel =
    snr >= 10 ? "green" : snr >= 3 ? "yellow" : "red";
  const dLevel: CVQualityLevel =
    D_status === "valid"
      ? "green"
      : D_status === "apparent"
        ? "yellow"
        : "idle";

  let overall: CVQualityLevel = "red";
  if (
    peakLevel === "green" &&
    ratioLevel === "green" &&
    snrLevel === "green"
  ) {
    overall = "green";
  } else if (peakLevel !== "red" && snrLevel !== "red") {
    overall = "yellow";
  }
  return {
    level: overall,
    ready: true,
    reversibilityLevel,
    deltaEpLevel,
    ratioLevel,
    peakLevel,
    dLevel,
    snrLevel,
  };
}