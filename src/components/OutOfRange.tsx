import { ReferenceDot } from "recharts";
import type { ReactElement } from "react";

/**
 * Points the AD5941 flagged as outside its usable ADC window (the HSTIA output left 0.2 to 2.1 V, so the
 * reported current may be wrong) are drawn with a distinct marker, a hollow red circle, and a note under the
 * plot says how many and what to do. See the "HSTIA Range" row of the signal quality card.
 */
export const OUT_OF_RANGE_COLOR = "hsl(0 80% 55%)";

/** More markers than this would only paint a red band, so the note carries the count. */
const MAX_MARKERS = 300;

export function countOutOfRange(points: readonly { outOfRange?: boolean }[]): number {
  let n = 0;
  for (const p of points) if (p.outOfRange === true) n++;
  return n;
}

/** The RTIA as a person writes it: 10 kΩ, 2.5 kΩ, 200 Ω. */
export function formatRtia(ohms: number | null | undefined): string {
  if (ohms == null || !Number.isFinite(ohms) || ohms <= 0) return "the RTIA in use";
  if (ohms >= 1000) return `${Number((ohms / 1000).toPrecision(4))} kΩ`;
  return `${Number(ohms.toPrecision(4))} Ω`;
}

/** The text under a plot. Empty when no point is flagged. */
export function outOfRangeNoteText(count: number, rtiaOhms?: number | null): string {
  if (count <= 0) return "";
  return `${count} ${count === 1 ? "point" : "points"} outside the ADC window at RTIA ${formatRtia(rtiaOhms)} — use a lower RTIA gain`;
}

/** Hollow red markers for the flagged points, as children of a recharts chart. */
export function outOfRangeDots<T extends { outOfRange?: boolean }>(
  points: readonly T[],
  x: (p: T) => number,
  y: (p: T) => number,
  keyPrefix = "oor",
): ReactElement[] {
  const out: ReactElement[] = [];
  for (let i = 0; i < points.length && out.length < MAX_MARKERS; i++) {
    const p = points[i];
    if (p.outOfRange !== true) continue;
    const px = x(p);
    const py = y(p);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    out.push(
      <ReferenceDot
        key={`${keyPrefix}_${i}`}
        x={px}
        y={py}
        r={4}
        fill="none"
        stroke={OUT_OF_RANGE_COLOR}
        strokeWidth={1.5}
        ifOverflow="visible"
        isFront
      />,
    );
  }
  return out;
}

export function OutOfRangeNote({ count, rtiaOhms }: { count: number; rtiaOhms?: number | null }) {
  const text = outOfRangeNoteText(count, rtiaOhms);
  if (!text) return null;
  return (
    <div
      data-testid="out-of-range-note"
      className="flex items-center gap-2 px-2 pt-1 text-[11px] font-mono"
      style={{ color: OUT_OF_RANGE_COLOR }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="4" fill="none" stroke={OUT_OF_RANGE_COLOR} strokeWidth="1.5" />
      </svg>
      <span>{text}</span>
    </div>
  );
}
