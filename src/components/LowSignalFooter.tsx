import { lowSignalNote, type EISPlotSplit } from "@/utils/eisLowSignal";

/**
 * The line under the Nyquist and Bode plots when the firmware flagged some
 * points as low signal: how many are hidden, and the toggle that draws them as
 * hollow grey markers. See utils/eisLowSignal.ts.
 */
export function LowSignalFooter({
  split,
  show,
  onChange,
}: {
  split: EISPlotSplit;
  show: boolean;
  onChange: (show: boolean) => void;
}) {
  return (
    <div
      className="mt-1 px-2 pb-1 flex items-center justify-between gap-3 text-[11px] font-mono text-muted-foreground"
      data-testid="low-signal-footer"
    >
      <span data-testid="low-signal-note">{lowSignalNote(split)}</span>
      <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
        <input
          type="checkbox"
          checked={show}
          onChange={(e) => onChange(e.target.checked)}
          aria-label="Show low-signal points"
        />
        Show low-signal points
      </label>
    </div>
  );
}
