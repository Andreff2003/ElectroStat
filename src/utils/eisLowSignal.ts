import type { EISDataPoint } from "@/hooks/useSimulatedData";

/**
 * EIS points whose raw DFT signal is too small to be meaningful (the firmware
 * flags them, see kEisMinDftCounts in firmware/ElectroStat_Timing.h) are kept
 * in the data, so exports and the activity of the instrument stay complete, but
 * the plots hide them unless asked. A point without the flag, which is every
 * simulated or replayed point and every session saved before the flag existed,
 * is not low signal.
 */
export const isLowSignal = (p: EISDataPoint): boolean => p.lowSignal === true;

export interface EISPlotSplit {
  /** Points drawn normally. They also decide the axis scale. */
  shown: EISDataPoint[];
  /** Low-signal points drawn as hollow grey markers, only when the toggle is on. */
  low: EISDataPoint[];
  /** Low-signal points that are not drawn, for the note under the plot. */
  hiddenCount: number;
  /** Low-signal points in the data, drawn or not. */
  lowCount: number;
}

export function splitForPlot(data: EISDataPoint[], showLowSignal: boolean): EISPlotSplit {
  const shown: EISDataPoint[] = [];
  const low: EISDataPoint[] = [];
  for (const p of data) (isLowSignal(p) ? low : shown).push(p);
  return {
    shown,
    low: showLowSignal ? low : [],
    hiddenCount: showLowSignal ? 0 : low.length,
    lowCount: low.length,
  };
}

/** The text under the plot. Empty when there is nothing to say. */
export function lowSignalNote(split: EISPlotSplit): string {
  if (split.lowCount === 0) return "";
  const n = split.lowCount;
  const noun = n === 1 ? "low-signal point" : "low-signal points";
  return split.hiddenCount > 0 ? `${n} ${noun} hidden` : `${n} ${noun} shown as hollow grey markers`;
}

/** Range of Z' over the points that decide the scale (the shown ones, plus the low ones when shown). */
export function zRealExtent(split: EISPlotSplit): { min: number; max: number } | null {
  const pts = [...split.shown, ...split.low];
  if (pts.length === 0) return null;
  let min = Infinity, max = -Infinity;
  for (const p of pts) {
    if (p.zReal < min) min = p.zReal;
    if (p.zReal > max) max = p.zReal;
  }
  return { min, max };
}
