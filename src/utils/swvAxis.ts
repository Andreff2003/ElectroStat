import type { SWVModel } from "@/types/swv";

/**
 * Current axis of the SWV plot. Currents are stored in µA, but a nM-level sweep
 * peaks at a fraction of a nA, where µA ticks read 0.00040. Below 0.01 µA of
 * visible span (the same cut-off the tooltip uses) the ticks are drawn in nA.
 */
export interface SWVCurrentAxis {
  unit: "µA" | "nA";
  /** Multiply a value in µA by this to get it in `unit`. */
  factor: number;
  decimals: number;
}

export function swvCurrentAxis(visibleSpan_uA: number): SWVCurrentAxis {
  if (!(visibleSpan_uA > 0)) return { unit: "µA", factor: 1, decimals: 2 };
  if (visibleSpan_uA < 0.01) {
    const spanNa = visibleSpan_uA * 1000;
    const decimals = Math.min(4, Math.max(0, Math.ceil(-Math.log10(spanNa / 5))));
    return { unit: "nA", factor: 1000, decimals };
  }
  const decimals = Math.min(8, Math.max(2, Math.ceil(-Math.log10(visibleSpan_uA / 5))));
  return { unit: "µA", factor: 1, decimals };
}

/** Tick text for a value in µA; never prints a negative zero. */
export function formatSwvTick(value_uA: number, axis: SWVCurrentAxis): string {
  const v = value_uA * axis.factor;
  const text = v.toFixed(axis.decimals);
  return Number(text) === 0 ? (0).toFixed(axis.decimals) : text;
}

/**
 * Name of an overlay curve: the concentration and the simulation model, so two
 * captures at the same concentration under different models can be told apart.
 */
export function swvOverlayLabel(
  concentration_nM: number | undefined,
  model: SWVModel | undefined,
  blankIndex: number,
): string {
  const m = model ?? "reversible";
  return (concentration_nM ?? 0) > 0
    ? `${concentration_nM} nM · ${m}`
    : `Blank ${blankIndex} · ${m}`;
}
