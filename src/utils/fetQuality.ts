import type { FETTransferPoint } from "@/hooks/useSimulatedData";
import { fetOnStateNoisePct } from "@/utils/fetNoise";
import { computeFETVtDetailed } from "@/utils/fetVt";

/**
 * BioFET signal-quality estimators (pure). Shared by the Signal Quality panel and by
 * computeFETTransferMetrics, so the Ion/Ioff, subthreshold slope, off-current and baseline
 * noise shown in the panel are the very numbers exported with each measurement.
 */
export type FETLevel = "green" | "yellow" | "red" | "idle";

/** Same "worst wins" rollup as the panel: green only if all are green, red if any is red. */
function worstOfLevels(levels: FETLevel[]): FETLevel {
  const relevant = levels.filter((l) => l !== "idle");
  if (relevant.length === 0) return "idle";
  if (relevant.every((l) => l === "green")) return "green";
  if (relevant.some((l) => l === "red")) return "red";
  return "yellow";
}

/** Median helper. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

/** Points of the 20-80 % window the Vt line is fitted to: >= 8 green, >= 4 yellow, fewer red. */
export const FET_WINDOW_GREEN_MIN = 8;
export const FET_WINDOW_YELLOW_MIN = 4;

/** Compute BioFET quality metrics from analyte + baseline curves. */
export function computeFETQuality(analyte: FETTransferPoint[], baseline: FETTransferPoint[]) {
  if (analyte.length < 10) {
    return {
      level: "idle" as FETLevel,
      ready: false,
      ionIoff: 0,
      subthresholdSlope: 0,
      ioff: 0,
      baselineStability: 0,
      ionLevel: "idle" as FETLevel,
      ssLevel: "idle" as FETLevel,
      ioffLevel: "idle" as FETLevel,
      stabilityLevel: "idle" as FETLevel,
      windowPoints: 0,
      windowLevel: "idle" as FETLevel,
      ion: 0,
      negativeCurrentWarning: false,
    };
  }

  const sortedByVg = [...analyte].sort((a, b) => a.vg - b.vg);
  const hasNegative = sortedByVg.some((p) => p.id < 0);
  const EPS = 1e-3;

  // 1. Robust Ion / Ioff — medians of the first/last 10% of Vg windows.
  //    Avoids the historic min/max collapse on a single noisy point.
  const winSize = Math.max(3, Math.floor(sortedByVg.length * 0.1));
  const offRegion = sortedByVg.slice(0, winSize).map((p) => Math.max(Math.abs(p.id), EPS));
  const onRegion = sortedByVg.slice(-winSize).map((p) => Math.max(Math.abs(p.id), EPS));
  const ioff = median(offRegion);
  const ion = median(onRegion);
  const ionIoff = ion / Math.max(ioff, EPS);

  // 2. Subthreshold Slope (mV/dec) — moving-window log10 fit in transition.
  const transRegion = sortedByVg.filter((p) => {
    const v = Math.abs(p.id);
    return v > 1e-6 && v < 0.2 * ion;
  });
  let ss = 0;
  let bestSlope = 0;
  for (let windowSize = 4; windowSize <= 6; windowSize++) {
    for (let start = 0; start + windowSize <= transRegion.length; start++) {
      const window = transRegion.slice(start, start + windowSize);
      const xs = window.map((p) => p.vg);
      const ys = window.map((p) => Math.log10(Math.max(Math.abs(p.id), 1e-12)));
      const n = xs.length;
      const sumX = xs.reduce((a, b) => a + b, 0);
      const sumY = ys.reduce((a, b) => a + b, 0);
      const sumXY = xs.reduce((a, _, i) => a + xs[i] * ys[i], 0);
      const sumX2 = xs.reduce((a, b) => a + b * b, 0);
      const denom = n * sumX2 - sumX * sumX;
      if (Math.abs(denom) <= 1e-12) continue;
      const slope = (n * sumXY - sumX * sumY) / denom;
      if (slope <= 0.1) continue;
      const intercept = (sumY - slope * sumX) / n;
      const meanY = sumY / n;
      const total = ys.reduce((a, y) => a + (y - meanY) ** 2, 0);
      const residual = ys.reduce((a, y, i) => a + (y - (slope * xs[i] + intercept)) ** 2, 0);
      const rSquared = total > 1e-12 ? 1 - residual / total : 0;
      if (rSquared > 0.8 && slope > bestSlope) bestSlope = slope;
    }
  }
  if (bestSlope > 0) ss = 1000 / bestSlope;

  // 4. Baseline noise — scatter of the baseline curve around its own smooth
  //    on-state trend (see fetOnStateNoisePct). Both the old deep-off std/mean
  //    (dominated by the exponential slope and by a fixed 0.05 µA floor) and
  //    this one grade <5 % green, <15 % yellow.
  let stabilityNoisePct = 0;
  let stabilityLevel: FETLevel = "idle";
  const noisePct = baseline.length >= 5 ? fetOnStateNoisePct(baseline) : null;
  if (noisePct != null) {
    stabilityNoisePct = noisePct;
    stabilityLevel = noisePct < 5 ? "green" : noisePct < 15 ? "yellow" : "red";
  }

  const ionLevel: FETLevel = ionIoff > 100 ? "green" : ionIoff > 20 ? "yellow" : "red";
  const ssLevel: FETLevel = ss > 0 && ss < 200 ? "green" : ss > 0 && ss < 400 ? "yellow" : "red";
  const ioffLevel: FETLevel = ioff < 1 ? "green" : ioff < 5 ? "yellow" : "red";

  // 5. Points in the strong-inversion window the threshold voltage is fitted to. With fewer than four
  //    the square-root fit is refused and the constant-current fallback is used (about a third low).
  const winA = computeFETVtDetailed(analyte).regionPoints;
  const winB = baseline.length >= 5 ? computeFETVtDetailed(baseline).regionPoints : winA;
  const windowPoints = Math.min(winA, winB);
  const windowLevel: FETLevel =
    windowPoints >= FET_WINDOW_GREEN_MIN ? "green" : windowPoints >= FET_WINDOW_YELLOW_MIN ? "yellow" : "red";

  // Overall via the shared worst-of rollup (includes SS). Note: ΔVt is the
  // biological result, not an electrode-quality metric — it deliberately
  // stays out of this rollup and is only shown on its own MetricRow.
  const level = worstOfLevels([ionLevel, ssLevel, ioffLevel, stabilityLevel, windowLevel]);

  return {
    level,
    ready: true,
    ionIoff,
    subthresholdSlope: ss,
    ioff,
    baselineStability: stabilityNoisePct,
    ionLevel,
    ssLevel,
    ioffLevel,
    stabilityLevel,
    windowPoints,
    windowLevel,
    ion,
    negativeCurrentWarning: hasNegative,
  };
}

