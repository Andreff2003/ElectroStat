/**
 * What the CV plot says about the model behind a trace. A simulated trace comes from a model, so its legend
 * names it ("Cycle 1 · forward · reversible") and a dashed line marks the model's formal potential E°′. A
 * measurement has neither: it was not produced by a model.
 */
export type CVDataSource = "simulated" | "live" | "multichannel";

/** The model name to append to the legend of the live trace, only for simulated data. */
export function cvLegendModel(dataSource: CVDataSource, cvModel: string): string | undefined {
  return dataSource === "simulated" ? cvModel : undefined;
}

/** The potential of the dashed model E°′ line, only for simulated data. */
export function cvModelE0(dataSource: CVDataSource, formalPotential: number): number | undefined {
  return dataSource === "simulated" ? formalPotential : undefined;
}
