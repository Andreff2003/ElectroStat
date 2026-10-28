/**
 * The instrument settings needed to reproduce a measurement, kept with it and written to every export.
 *
 * Some are what the app asked for (the RTIA, the DC bias, the amplitude, the frequency range), the others
 * are what the device reported back: the calibration it ran before a CV, SWV or BioFET sweep (the
 * "running" status), the number of points that were out of range (the *_done message), and, for EIS,
 * how many points it sent, skipped and flagged (eis_done). Anything not known is left out and exported
 * as N/A, so a measurement stored before these fields existed loads and exports without them.
 */

export interface InstrumentSettings {
  // Requested, CV / SWV / BioFET
  /** HSTIA RTIA the app asked for, in ohms. */
  rtiaOhms?: number;
  // Reported by the device in the "running" status of a CV, SWV or BioFET sweep
  /** A calibration was attempted before the sweep. */
  calibrated?: boolean;
  /** RTIA after the calibration against RCAL (equals the requested one when it was not calibrated). */
  rtiaCalibratedOhms?: number;
  currentOffsetUa?: number;
  potentialOffsetMv?: number;
  vzeroV?: number;
  calibrationNote?: string;
  // Reported by the device in the *_done message
  outOfRangeCount?: number;
  // Requested, EIS
  dcBias?: number;
  amplitude?: number;
  freqMin?: number;
  freqMax?: number;
  pointsPerDecade?: number;
  // Reported by the device, any technique
  /** Value of the calibration resistor the firmware was built with, in ohms. */
  rcalOhms?: number;
  // Reported by the device in eis_done
  pointsRequested?: number;
  pointsSent?: number;
  pointsSkipped?: number;
  pointsLowSignal?: number;
}

export type InstrumentTechnique = "eis" | "cv" | "swv" | "fet";

type Kind = "num" | "bool" | "text";
interface Field {
  key: keyof InstrumentSettings;
  /** The row name in the exported file. */
  csv: string;
  kind: Kind;
  techniques: InstrumentTechnique[];
}

const AMPEROMETRIC: InstrumentTechnique[] = ["cv", "swv", "fet"];

/** Every field, in the order of the exported rows. */
const FIELDS: Field[] = [
  { key: "rtiaOhms", csv: "rtia_requested_ohms", kind: "num", techniques: AMPEROMETRIC },
  { key: "calibrated", csv: "calibration_run", kind: "bool", techniques: AMPEROMETRIC },
  { key: "rtiaCalibratedOhms", csv: "rtia_calibrated_ohms", kind: "num", techniques: AMPEROMETRIC },
  { key: "currentOffsetUa", csv: "current_offset_uA", kind: "num", techniques: AMPEROMETRIC },
  { key: "potentialOffsetMv", csv: "potential_offset_mV", kind: "num", techniques: AMPEROMETRIC },
  { key: "vzeroV", csv: "vzero_V", kind: "num", techniques: AMPEROMETRIC },
  { key: "calibrationNote", csv: "calibration_note", kind: "text", techniques: AMPEROMETRIC },
  { key: "outOfRangeCount", csv: "out_of_range_points", kind: "num", techniques: AMPEROMETRIC },
  { key: "dcBias", csv: "eis_dc_bias_V", kind: "num", techniques: ["eis"] },
  { key: "amplitude", csv: "eis_amplitude_mV", kind: "num", techniques: ["eis"] },
  { key: "freqMin", csv: "eis_freq_min_Hz", kind: "num", techniques: ["eis"] },
  { key: "freqMax", csv: "eis_freq_max_Hz", kind: "num", techniques: ["eis"] },
  { key: "pointsPerDecade", csv: "eis_points_per_decade", kind: "num", techniques: ["eis"] },
  { key: "pointsRequested", csv: "eis_points_requested", kind: "num", techniques: ["eis"] },
  { key: "pointsSent", csv: "eis_points_sent", kind: "num", techniques: ["eis"] },
  { key: "pointsSkipped", csv: "eis_points_skipped", kind: "num", techniques: ["eis"] },
  { key: "pointsLowSignal", csv: "eis_points_low_signal", kind: "num", techniques: ["eis"] },
  { key: "rcalOhms", csv: "rcal_ohms", kind: "num", techniques: ["eis", "cv", "swv", "fet"] },
];

/** The row names of the exported settings, for the reader of a file. */
export const INSTRUMENT_CSV_KEYS: readonly string[] = FIELDS.map((f) => f.csv);

const NA = "N/A";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function formatValue(kind: Kind, v: unknown): string {
  if (v == null) return NA;
  if (kind === "num") return finite(v) ? String(Number(v.toPrecision(10))) : NA;
  if (kind === "bool") return v === true ? "Yes" : v === false ? "No" : NA;
  const t = String(v).replace(/[\r\n;]+/g, " ").trim();
  return t === "" ? NA : t;
}

/**
 * The key/value rows of the settings of one technique, always the same rows in the same order
 * (N/A for what is not known).
 */
export function instrumentRows(
  technique: InstrumentTechnique,
  settings: InstrumentSettings | null | undefined,
): [string, string][] {
  const s = settings ?? {};
  return FIELDS.filter((f) => f.techniques.includes(technique)).map((f) => [f.csv, formatValue(f.kind, s[f.key])]);
}

/** The settings back from the rows written by instrumentRows (N/A and unknown rows are skipped). */
export function parseInstrumentRows(rows: Iterable<[string, string]>): InstrumentSettings {
  const out: InstrumentSettings = {};
  const byCsv = new Map(FIELDS.map((f) => [f.csv, f]));
  for (const [key, raw] of rows) {
    const f = byCsv.get(key.trim());
    if (!f) continue;
    const value = raw.trim();
    if (value === "" || value === NA || value === "n/a") continue;
    if (f.kind === "num") {
      const n = Number(value);
      if (Number.isFinite(n)) (out as Record<string, unknown>)[f.key] = n;
    } else if (f.kind === "bool") {
      if (value === "Yes") (out as Record<string, unknown>)[f.key] = true;
      else if (value === "No") (out as Record<string, unknown>)[f.key] = false;
    } else {
      (out as Record<string, unknown>)[f.key] = value;
    }
  }
  return out;
}

/** True when nothing is known (nothing to store or to write beyond N/A). */
export function isEmptyInstrument(s: InstrumentSettings | null | undefined): boolean {
  return !s || Object.values(s).every((v) => v === undefined);
}

/**
 * What the device said about a sweep, as the hook keeps it: the fields of its "running" status
 * and of its done message, side by side (see DeviceRunInfo in useWebSocketData).
 */
export interface DeviceRunInfo {
  running?: Record<string, unknown>;
  done?: Record<string, unknown>;
}

const num = (v: unknown): number | undefined => (finite(v) ? v : undefined);

/**
 * The settings of a measurement: what the app requested, joined with what the device reported
 * (the two sets of fields do not overlap, so neither overrides the other).
 */
export function buildInstrumentSettings(
  technique: InstrumentTechnique,
  requested: InstrumentSettings,
  device?: DeviceRunInfo | null,
): InstrumentSettings {
  const out: InstrumentSettings = { ...requested };
  const run = device?.running ?? {};
  const done = device?.done ?? {};
  if (technique === "eis") {
    out.rcalOhms = num(run.rcalOhms) ?? out.rcalOhms;
    out.pointsRequested = num(done.requested);
    out.pointsSent = num(done.points);
    out.pointsSkipped = num(done.skipped);
    out.pointsLowSignal = num(done.lowSignal);
  } else {
    if (typeof run.calibrated === "boolean") out.calibrated = run.calibrated;
    out.rtiaCalibratedOhms = num(run.rtiaCalibratedOhms);
    out.currentOffsetUa = num(run.currentOffsetUa);
    out.potentialOffsetMv = num(run.potentialOffsetMv);
    out.vzeroV = num(run.vzeroV);
    if (typeof run.calibrationNote === "string" && run.calibrationNote !== "") out.calibrationNote = run.calibrationNote;
    out.rcalOhms = num(run.rcalOhms) ?? out.rcalOhms;
    out.outOfRangeCount = num(done.outOfRangeCount);
  }
  // Drop what the device did not say, so that "known" means known.
  for (const k of Object.keys(out) as (keyof InstrumentSettings)[]) if (out[k] === undefined) delete out[k];
  return out;
}
