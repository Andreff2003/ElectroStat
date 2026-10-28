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

/**
 * A point that is in the sweep but breaks its continuity: a contact that opened for a moment, a point at the
 * end of the sweep that settled badly. Besides the firmware's own low-signal flag, a point is suspect when
 * - its phase is more than SUSPECT_PHASE_DEG away from both neighbours (from its only neighbour at an end), or
 * - its |Z| is more than SUSPECT_Z_FACTOR times away from the log-log interpolation of its two neighbours.
 * Neighbours are the nearest points in frequency that are not flagged themselves, so a run of bad points
 * at the low-frequency end is found from the good ones, one pass after the other.
 */
export const SUSPECT_PHASE_DEG = 30;
export const SUSPECT_Z_FACTOR = 3;

/** A point that is excluded from the autoscale, the fits and Lin-KK: low signal (firmware) or suspect (app). */
export const isFlagged = (p: EISDataPoint): boolean => p.lowSignal === true || p.suspect === true;

const phaseOf = (p: EISDataPoint): number => (Number.isFinite(p.phase) ? p.phase : (Math.atan2(p.zImag, p.zReal) * 180) / Math.PI);
const magOf = (p: EISDataPoint): number => (p.zMag > 0 ? p.zMag : Math.hypot(p.zReal, p.zImag));

/**
 * The sweep with `suspect: true` on the points that break its continuity. The order of the points is kept, and
 * a point that is not suspect is returned as it is (the same object).
 */
export function markSuspectPoints(data: EISDataPoint[]): EISDataPoint[] {
  const n = data.length;
  if (n < 3) return data;
  // Sweep order, by frequency from high to low; ties keep their order in the data.
  const order = data.map((_, i) => i).sort((a, b) => data[b].frequency - data[a].frequency || a - b);
  const suspect = new Set<number>();
  const isOut = (i: number) => data[i].lowSignal === true || suspect.has(i);
  for (let pass = 0; pass < n; pass++) {
    const clean = order.filter((i) => !isOut(i) && data[i].frequency > 0);
    const found: number[] = [];
    for (let k = 0; k < clean.length; k++) {
      const i = clean[k];
      const prev = k > 0 ? clean[k - 1] : undefined;
      const next = k < clean.length - 1 ? clean[k + 1] : undefined;
      const neighbours = [prev, next].filter((j): j is number => j !== undefined);
      if (neighbours.length === 0) continue;
      const phaseBreak = neighbours.every((j) => Math.abs(phaseOf(data[i]) - phaseOf(data[j])) > SUSPECT_PHASE_DEG);
      let magBreak = false;
      if (prev !== undefined && next !== undefined) {
        const lf = [prev, i, next].map((j) => Math.log(data[j].frequency));
        const span = lf[2] - lf[0];
        const zp = magOf(data[prev]);
        const zn = magOf(data[next]);
        const zi = magOf(data[i]);
        if (Math.abs(span) > 1e-12 && zp > 0 && zn > 0 && zi > 0) {
          const t = (lf[1] - lf[0]) / span;
          const expected = Math.exp(Math.log(zp) + t * (Math.log(zn) - Math.log(zp)));
          const ratio = zi / expected;
          magBreak = ratio > SUSPECT_Z_FACTOR || ratio < 1 / SUSPECT_Z_FACTOR;
        }
      }
      if (phaseBreak || magBreak) found.push(i);
    }
    if (found.length === 0) break;
    for (const i of found) suspect.add(i);
  }
  if (suspect.size === 0) return data;
  return data.map((p, i) => (suspect.has(i) ? { ...p, suspect: true } : p));
}

/** The points a fit or Lin-KK may use: the sweep without its low-signal and its suspect points. */
export function usableForAnalysis(data: EISDataPoint[]): EISDataPoint[] {
  return markSuspectPoints(data).filter((p) => !isFlagged(p));
}

export interface EISPlotSplit {
  /** Points drawn normally. They also decide the axis scale. */
  shown: EISDataPoint[];
  /** Low-signal points drawn as hollow grey markers, only when the toggle is on. */
  low: EISDataPoint[];
  /** Low-signal points that are not drawn, for the note under the plot. */
  hiddenCount: number;
  /** Flagged points in the data (low signal or suspect), drawn or not. */
  lowCount: number;
  /** Of those, the ones flagged by the app because they break the continuity of the sweep. */
  suspectCount: number;
}

export function splitForPlot(data: EISDataPoint[], showLowSignal: boolean): EISPlotSplit {
  const shown: EISDataPoint[] = [];
  const low: EISDataPoint[] = [];
  let suspectCount = 0;
  for (const p of markSuspectPoints(data)) {
    if (isFlagged(p)) {
      low.push(p);
      if (p.lowSignal !== true) suspectCount++;
    } else {
      shown.push(p);
    }
  }
  return {
    shown,
    low: showLowSignal ? low : [],
    hiddenCount: showLowSignal ? 0 : low.length,
    lowCount: low.length,
    suspectCount,
  };
}

/** The text under the plot. Empty when there is nothing to say. */
export function lowSignalNote(split: EISPlotSplit): string {
  if (split.lowCount === 0) return "";
  const n = split.lowCount;
  // Only low-signal points: the wording of the firmware's flag. With points the app flagged too, say both.
  const noun = split.suspectCount > 0 ? (n === 1 ? "flagged point" : "flagged points") : n === 1 ? "low-signal point" : "low-signal points";
  const why = split.suspectCount > 0 ? ` (${n - split.suspectCount} low signal, ${split.suspectCount} out of line)` : "";
  return split.hiddenCount > 0 ? `${n} ${noun} hidden${why}` : `${n} ${noun} shown as hollow grey markers${why}`;
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
