import type { EISDataPoint, FETTransferPoint, FETTimePoint } from "@/hooks/useSimulatedData";
import type { CVDataPoint } from "@/hooks/useSimulatedCVData";
import type { CVMetrics } from "@/utils/computeCVMetrics";
import type {
  CVCalibrationPoint,
  CVResponseMode,
} from "@/utils/cvCalibration";
import {
  summarizeCalibration,
  randlesSevcikIpUA,
  responseFor,
} from "@/utils/cvCalibration";
import {
  CV_DEFAULT_D_CM2_S,
  CV_E0_PRIME_DEFAULT_V,
  CV_SOLVER_DEFAULT_SPATIAL_NODES,
  CV_SOLVER_DEFAULT_STEP_V,
  CV_SOLVER_DOMAIN_RULE,
  CV_T_DEFAULT_K,
} from "@/utils/cvConstants";
import {
  type MeasurementNotes,
  shortNotesSummary,
  sanitizeNotesForCSV,
  sanitizeMeasurementNotes,
} from "@/utils/measurementNotes";
import type { CVMeasurementNotes } from "@/utils/cvMeasurementNotes";
import type { StoredMeasurement } from "./sessionStore";
import { getActivityLog, type ActivityEntry } from "./activityLog";

/** Normalise a possibly-legacy `notes` field (string or object) for compact CSV display. */
function notesCell(n: MeasurementNotes | string | undefined | null): string {
  if (n == null) return "N/A";
  if (typeof n === "string") return sanitizeNotesForCSV(n);
  const summary = shortNotesSummary(n);
  return summary ? sanitizeNotesForCSV(summary) : "N/A";
}

// ───────────────────────── helpers ─────────────────────────

const DELIM = ";";
const BOM = "\uFEFF";
const EXCEL_SEP_HINT = `sep=${DELIM}\n`;
const SECTION_PAD = 8; // empty columns after section header

/**
 * Escape a CSV field. Quote when it contains the delimiter (`;`), a double
 * quote, or any newline. Numeric decimal point (`.`) is preserved so the file
 * stays compatible with Python/R/Origin while opening cleanly in Excel (EU).
 */
function csvEscape(s: string): string {
  if (/[";\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

/** Format timestamp as ISO 8601 "YYYY-MM-DD HH:MM:SS" (local time). */
function fmtTs(ts: number | string | Date | undefined | null): string {
  if (ts == null) return "N/A";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "N/A";
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Round numeric values to 3 decimal places. "N/A" if null/undefined/NaN. */
function fmtNum(v: unknown): string {
  if (v == null) return "N/A";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(3);
}

/** Pass-through for strings, else "N/A". */
function fmtStr(v: unknown): string {
  if (v == null || v === "") return "N/A";
  return String(v).replace(/[\t\r\n]+/g, " ");
}

function toRow(cells: (string | number)[]): string {
  return cells
    .map((c) => {
      if (typeof c === "number") return Number.isFinite(c) ? c.toString() : "N/A";
      return csvEscape(c);
    })
    .join(DELIM);
}

function downloadTSV(filename: string, content: string) {
  // Prepend Excel "sep=;" hint so European Excel installs split columns correctly
  // without depending on the user's regional list separator. Decimals stay as `.`.
  const body = EXCEL_SEP_HINT + content;
  const blob = new Blob([BOM + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/\.tsv$/i, ".csv");
  link.click();
  URL.revokeObjectURL(url);
}

function metaRow(measurementsCount: number, source: ExportSource): string {
  return toRow([
    "ElectroStat Export",
    fmtTs(Date.now()),
    `Measurements: ${measurementsCount}`,
    `Source: ${source}`,
  ]);
}

const BLANK = "\n\n";

export type ExportSource = "simulated" | "live" | "imported" | "unknown";

export interface CalibrationExportPoint {
  concentration: number;
  signal: number;
  raw: number;
  timestamp: number;
  mode?: "eis" | "fet" | "swv";
  measurementId?: string;
  sampleId?: string;
  electrodeId?: string;
  notesShort?: string;
  // BioFET-specific traceability
  deltaVt_mV_signed?: number;
  calibrationSignal_mV_used?: number;
  responseMode?: "auto" | "signed" | "absolute";
  responseSign?: 1 | -1;
  vtBaseline?: number;
  vtAnalyte?: number;
  vtMethod?: string;
  vtFitR2?: number | null;
  vtRegionPoints?: number;
  vtWarning?: string;
  // SWV-specific traceability
  peakPotential_V?: number | null;
  snr?: number | null;
}

// ───────────────────────── section builders ─────────────────────────

const RAW_EIS_HEADERS = [
  "Measurement ID",
  "Channel",
  "Timestamp",
  "Mode",
  "Concentration (nM)",
  "Frequency (Hz)",
  "Z Real (Ω)",
  "Z Imag (Ω)",
  "|Z| (Ω)",
  "Phase (°)",
];

const RAW_FET_TRANSFER_HEADERS = [
  "Measurement ID",
  "Channel",
  "Timestamp",
  "Concentration (nM)",
  "Curve",
  "Vg (V)",
  "Id (µA)",
];

const RAW_FET_TIME_HEADERS = [
  "Measurement ID",
  "Channel",
  "Timestamp",
  "Concentration (nM)",
  "Time (s)",
  "Id (µA)",
  "Marker",
];


const PROC_HEADERS = [
  "Measurement ID",
  "Timestamp",
  "Mode",
  "Concentration (nM)",
  "Rs (Ω)",
  "Rct (Ω)",
  "Cdl (µF)",
  "Aw (Ω/√s)",
  "f0 (Hz)",
  "Warburg Slope",
  "Warburg Aw",
  "KK Residual (%)",
  "KK Passed",
  "Fit Error (%)",
  "Fit Converged",
  "ΔRct (Ω)",
  "ΔRct normalised (%)",
  "Freq Min (Hz)",
  "Freq Max (Hz)",
  "Points",
  "Amplitude (mV)",
  "Warn Flags",
  "Vt (V)",
  "Vg Min (V)",
  "Vg Max (V)",
  "Vg Step (mV)",
  "Interval (ms)",
  "Notes",
  // EIS provenance / quality (appended; FET & CV rows pad with N/A).
  "Fit Model",
  "Fit Source",
  "Weighted SSR / dof",
  "RMSE Weighted (%)",
  "Fit Range Min (Hz)",
  "Fit Range Max (Hz)",
  "KK Method",
  "Warburg Method",
  "Warburg R²",
  "Covariance Warning",
  "Extrapolation Present",
  "Covariance Method",
  "Lin-KK Passed",
  "Lin-KK RMS Residual (%)",
  "Lin-KK Max Residual (%)",
  "Lin-KK Tau Count",
  "Approx KK Informational Only",
  "DC Bias (V)",
];
const EIS_EXTRA_PAD = 17; // count of EIS-extra columns (keep in sync with PROC_HEADERS).

const CAL_HEADERS = [
  "concentration_nM",
  "signal",
  "raw",
  "timestamp",
  "mode",
  "measurement_id",
  "sample_id",
  "electrode_id",
  "notes_short",
  "deltaVt_mV_signed",
  "calibration_signal_mV_used",
  "responseMode",
  "responseSign",
  "vt_baseline_V",
  "vt_analyte_V",
  "vt_method",
  "vt_fit_r2",
  "vt_region_points",
  "vt_warning",
  // SWV-specific traceability
  "peak_potential_V",
  "snr",
];
const CAL_PAD = CAL_HEADERS.length;

function sectionHeader(label: string): string {
  // First cell holds the section marker; pad with empty cells so it sits alone in column A.
  return `=== ${label} ===` + DELIM.repeat(SECTION_PAD);
}

/** Channel label for traceability; "—" for single-device sessions. */
function channelCell(m: { channelLabel?: string }): string {
  return m.channelLabel && m.channelLabel.trim() !== "" ? m.channelLabel : NO_CHANNEL;
}

const NO_CHANNEL = "—";

function buildRawSection(measurements: StoredMeasurement[]): string {
  const lines: string[] = [];

  // EIS raw block
  const eisList = measurements.filter(
    (m): m is Extract<StoredMeasurement, { mode: "eis" }> => m.mode === "eis",
  );
  if (eisList.length > 0) {
    lines.push(sectionHeader("RAW EIS DATA"));
    lines.push(toRow(RAW_EIS_HEADERS));
    for (const m of eisList) {
      const ts = fmtTs(m.timestamp);
      for (const p of m.data) {
        lines.push(
          toRow([
            m.id,
            channelCell(m),
            ts,
            "eis",
            fmtNum(m.concentration),
            fmtNum(p.frequency),
            fmtNum(p.zReal),
            fmtNum(p.zImag),
            fmtNum(p.zMag),
            fmtNum(p.phase),
          ]),
        );
      }
    }
  }

  // FET raw blocks — same schema as individual export
  const fetList = measurements.filter(
    (m): m is Extract<StoredMeasurement, { mode: "fet" }> => m.mode === "fet",
  );
  if (fetList.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(sectionHeader("RAW FET TRANSFER DATA"));
    lines.push(toRow(RAW_FET_TRANSFER_HEADERS));
    for (const m of fetList) {
      const ts = fmtTs(m.timestamp);
      const conc = fmtNum(m.concentration);
      for (const p of m.baseline) {
        lines.push(toRow([m.id, channelCell(m), ts, conc, "baseline", fmtNum(p.vg), fmtNum(p.id)]));
      }
      for (const p of m.analyte) {
        lines.push(toRow([m.id, channelCell(m), ts, conc, "analyte", fmtNum(p.vg), fmtNum(p.id)]));
      }
    }

    lines.push("");
    lines.push(sectionHeader("RAW FET TIME DATA"));
    lines.push(toRow(RAW_FET_TIME_HEADERS));
    for (const m of fetList) {
      const ts = fmtTs(m.timestamp);
      const conc = fmtNum(m.concentration);
      for (const p of m.timeData) {
        lines.push(toRow([m.id, channelCell(m), ts, conc, fmtNum(p.time), fmtNum(p.id), "N/A"]));
      }
      for (const mk of m.markers) {
        lines.push(toRow([m.id, channelCell(m), ts, conc, fmtNum(mk.time), "N/A", fmtStr(mk.label)]));
      }
    }
  }

  // CV raw data — emitted as its own block so columns are CV-specific.
  const cvList = measurements.filter((m): m is Extract<StoredMeasurement, { mode: "cv" }> => m.mode === "cv");
  if (cvList.length > 0) {
    lines.push("");
    lines.push(sectionHeader("RAW CV DATA"));
    lines.push(toRow([
      "measurement_id", "channel", "timestamp", "mode", "concentration_mM",
      "point_index", "time_s", "cycle", "branch",
      "E_V", "I_raw_uA", "baseline_uA", "I_corrected_uA",
    ]));
    for (const m of cvList) {
      const ts = fmtTs(m.measurementTimestamp ?? m.timestamp);
      const mid = m.measurementId ?? m.id;
      const useCorrected =
        m.metrics?.correctedData &&
        m.metrics.correctedData.length === m.data.length;
      for (let i = 0; i < m.data.length; i++) {
        const p = m.data[i];
        const cp = useCorrected ? m.metrics!.correctedData![i] : undefined;
        lines.push(toRow([
          mid, channelCell(m), ts, "cv", fmtSig(m.concentration ?? null),
          `${i}`, fmtSig(p.t), `${p.cycle}`, fmtStr(p.branch ?? ""),
          fmtSig(p.E), fmtSig(p.I),
          fmtSig(cp?.baseline ?? p.baseline),
          fmtSig(cp?.Icorr ?? p.Icorr),
        ]));
      }
    }
  }

  // SWV raw data — own block, SWV-specific columns.
  const swvList = measurements.filter(
    (m): m is Extract<StoredMeasurement, { mode: "swv" }> => m.mode === "swv",
  );
  if (swvList.length > 0) {
    lines.push("");
    lines.push(sectionHeader("RAW SWV DATA"));
    lines.push(toRow([
      "measurement_id", "channel", "timestamp", "mode", "concentration_nM",
      "point_index", "time_s", "E_V",
      "I_forward_uA", "I_reverse_uA", "I_net_raw_uA",
      "baseline_uA", "I_net_corrected_uA", "direction",
    ]));
    for (const m of swvList) {
      const ts = fmtTs(m.measurementTimestamp ?? m.timestamp);
      const mid = m.measurementId ?? m.id;
      const corr = m.correctedData && m.correctedData.length === m.data.length ? m.correctedData : null;
      for (let i = 0; i < m.data.length; i++) {
        const p = m.data[i];
        const cp = corr ? corr[i] : undefined;
        lines.push(toRow([
          mid, channelCell(m), ts, "swv", fmtSig(m.concentration ?? null),
          `${i}`, fmtSig(p.time), fmtSig(p.E),
          fmtSig(p.IForward), fmtSig(p.IReverse), fmtSig(p.INet),
          fmtSig(cp?.baseline ?? null), fmtSig(cp?.ICorrected ?? null),
          fmtStr(p.direction),
        ]));
      }
    }
  }

  return lines.join("\n");
}

function buildProcessedSection(measurements: StoredMeasurement[]): string {
  const lines: string[] = [];
  lines.push(sectionHeader("PROCESSED RESULTS"));
  lines.push(toRow(PROC_HEADERS));
  for (const m of measurements) {
    const ts = fmtTs(m.timestamp);
    if (m.mode === "eis") {
      const e = m.extracted;
      const fitErrPctStr =
        e.fitErrorPct == null
          ? "N/A"
          : e.fitErrorPct === -1
            ? "-1"
            : Number(e.fitErrorPct).toFixed(3);
      lines.push(toRow([
        m.id, ts, "eis", fmtNum(m.concentration),
        fmtNum(e.Rs), fmtNum(e.Rct),
        e.Cdl != null && Number.isFinite(e.Cdl) ? (e.Cdl * 1e6).toFixed(3) : "N/A",
        fmtNum(e.Aw),
        fmtNum(e.f0),
        fmtNum(e.warburgSlope),
        fmtNum(e.warburgAw),
        fmtNum(e.kkResidualPct),
        e.kkPassed == null ? "N/A" : e.kkPassed ? "Yes" : "No",
        fitErrPctStr,
        e.fitConverged == null ? "N/A" : e.fitConverged ? "Yes" : "No",
        fmtNum(e.deltaRct),
        fmtNum(e.deltaRctNormPct),
        fmtNum(m.params.freqMin), fmtNum(m.params.freqMax),
        fmtNum(m.params.points), fmtNum(m.params.amplitude),
        e.warnFlags && e.warnFlags.length > 0 ? sanitizeNotesForCSV(e.warnFlags.join(" | ")) : "N/A",
        "N/A", "N/A", "N/A", "N/A", "N/A",
        notesCell(m.notes),
        // EIS provenance / quality
        e.fitModel ?? "N/A",
        e.fitSource ?? (e.fitConverged ? "manual_randles" : "geometric"),
        fmtNum(e.weightedSsrPerDof),
        fmtNum(e.rmseWeightedPercent),
        fmtNum(e.fitRangeMinHz),
        fmtNum(e.fitRangeMaxHz),
        e.kkMethod ?? (e.kkPassed != null ? "approximate_residual" : "none"),
        e.warburgMethod ?? (e.warburgAw != null ? "regression_1_sqrt_omega_with_intercept" : "N/A"),
        fmtNum(e.warburgR2),
        e.covarianceWarning == null ? "N/A" : e.covarianceWarning ? "Yes" : "No",
        e.extrapolationPresent == null ? "N/A" : e.extrapolationPresent ? "Yes" : "No",
        e.covarianceMethod ?? "log_space",
        e.linKKPassed == null ? "N/A" : e.linKKPassed ? "Yes" : "No",
        fmtNum(e.linKKRmsResidualPct),
        fmtNum(e.linKKMaxResidualPct),
        e.linKKTauCount == null ? "N/A" : String(e.linKKTauCount),
        e.approxKkInformationalOnly == null ? "true" : e.approxKkInformationalOnly ? "true" : "false",
        fmtNum(m.params.dcBias ?? 0),
      ]));
    } else if (m.mode === "fet") {
      const fe = m.extracted;
      lines.push(toRow([
        m.id, ts, "fet", fmtNum(m.concentration),
        "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A",
        "N/A", "N/A", "N/A", "N/A",
        "N/A", "N/A", "N/A", "N/A", "N/A",
        fmtNum(fe.vtAnalyte ?? fe.Vt),
        fmtNum(m.params.vgMin), fmtNum(m.params.vgMax),
        fmtNum(m.params.vgStep), fmtNum(m.params.intervalMs),
        notesCell(m.notes),
        // FET-specific traceability appended into the EIS-extra columns.
        // Columns: vt_baseline_V, vt_analyte_V, deltaVt_mV, deltaVt_mV_signed,
        //   calibration_signal_mV_used, vt_method, vt_fit_r2, vt_region_points,
        //   vt_warning, ion_uA, ioff_uA, ion_ioff_ratio,
        //   subthreshold_slope_mV_dec, baseline_stability_noise_pct,
        //   responseMode, responseSign
        fmtNum(fe.vtBaseline),
        fmtNum(fe.vtAnalyte ?? fe.Vt),
        fmtNum(fe.deltaVt_mV),
        fmtNum(fe.deltaVt_mV_signed ?? fe.deltaVt_mV),
        fmtNum(fe.calibrationSignal_mV_used),
        fe.vtMethod ?? "N/A",
        fmtNum(fe.vtFitR2),
        fe.vtRegionPoints == null ? "N/A" : String(fe.vtRegionPoints),
        fe.vtWarning ?? "N/A",
        fmtNum(fe.ion_uA),
        fmtNum(fe.ioff_uA),
        fmtNum(fe.ionIoffRatio),
        fmtNum(fe.subthresholdSlope_mV_dec),
        fmtNum(fe.baselineStabilityNoisePct),
        fe.responseMode ?? "N/A",
        fe.responseSign == null ? "N/A" : String(fe.responseSign),
        "N/A",
      ]));
    } else if (m.mode === "cv") {
      // CV row — full CV details are exported via exportCVData; this is a session summary.
      lines.push(toRow([
        m.id, ts, "cv", fmtNum(m.concentration ?? null),
        "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A",
        "N/A", "N/A", "N/A", "N/A",
        fmtNum(m.params.scanRate), fmtNum(m.params.nCycles),
        fmtNum(m.params.n), fmtNum(m.params.areaCm2),
        m.params.cvModel,
        "N/A", "N/A", "N/A", "N/A", "N/A",
        notesCell(m.notes),
        ...Array(EIS_EXTRA_PAD).fill("N/A"),
      ]));
    } else if (m.mode === "swv") {
      // SWV summary row — full detail via exportSWVData.
      lines.push(toRow([
        m.id, ts, "swv", fmtNum(m.concentration ?? null),
        "N/A", "N/A", "N/A", "N/A",
        fmtNum(m.extracted.peakPotential_V),
        "N/A", "N/A", "N/A", "N/A",
        fmtNum(m.extracted.peakCurrentCorrected_uA),
        m.extracted.peakDetected ? "Yes" : "No",
        fmtNum(m.extracted.halfPeakWidth_mV),
        fmtNum(m.extracted.snr),
        fmtNum(m.params.startE), fmtNum(m.params.endE),
        fmtNum(m.params.step_mV), fmtNum(m.params.amplitude_mV),
        m.extracted.baselineMethodUsed ?? m.extracted.baselineMethod ?? "N/A",
        "N/A", "N/A", "N/A", "N/A", "N/A",
        notesCell(m.notes),
        ...Array(EIS_EXTRA_PAD).fill("N/A"),
      ]));
    }
  }
  return lines.join("\n");
}

function buildCalibrationSection(points: CalibrationExportPoint[]): string {
  const lines: string[] = [];
  lines.push(sectionHeader("CALIBRATION"));
  lines.push(toRow(CAL_HEADERS));
  if (points.length === 0) {
    lines.push(toRow(Array(CAL_PAD).fill("N/A")));
  } else {
      for (const p of [...points].sort((a, b) => a.concentration - b.concentration || a.timestamp - b.timestamp)) {
        lines.push(toRow([
          fmtNum(p.concentration),
          fmtNum(p.signal),
          fmtNum(p.raw),
          fmtTs(p.timestamp),
          fmtStr(p.mode),
          fmtStr(p.measurementId),
          fmtStr(p.sampleId),
          fmtStr(p.electrodeId),
          fmtStr(p.notesShort),
          fmtNum(p.deltaVt_mV_signed),
          fmtNum(p.calibrationSignal_mV_used),
          fmtStr(p.responseMode),
          p.responseSign == null ? "N/A" : String(p.responseSign),
          fmtNum(p.vtBaseline),
          fmtNum(p.vtAnalyte),
          fmtStr(p.vtMethod),
          fmtNum(p.vtFitR2),
          p.vtRegionPoints == null ? "N/A" : String(p.vtRegionPoints),
          fmtStr(p.vtWarning),
          fmtNum(p.peakPotential_V),
          fmtNum(p.snr),
        ]));
      }
  }
  return lines.join("\n");
}

function buildActivitySection(): string {
  const lines: string[] = [];
  lines.push(sectionHeader("ACTIVITY LOG"));
  lines.push(toRow(["Timestamp", "Category", "Message"]));
  const log = getActivityLog();
  if (log.length === 0) {
    lines.push(toRow(["N/A", "N/A", "N/A"]));
  } else {
    for (const e of log as ActivityEntry[]) {
      lines.push(toRow([fmtTs(e.timestamp), fmtStr(e.category), fmtStr(e.message)]));
    }
  }
  return lines.join("\n");
}

/**
 * Per-CV-measurement metadata + processed metrics block for session export.
 * One METADATA block + one PROCESSED row per CV measurement. Safe with
 * missing metrics / notes (emits N/A).
 */
function buildSessionCVMetaAndMetrics(
  measurements: StoredMeasurement[],
): string {
  const cvList = measurements.filter(
    (m): m is Extract<StoredMeasurement, { mode: "cv" }> => m.mode === "cv",
  );
  if (cvList.length === 0) return "";
  const blocks: string[] = [];
  for (const m of cvList) {
    const id = m.measurementId ?? m.id;
    const ts = fmtTs(m.measurementTimestamp ?? m.timestamp);
    const n = m.notes;
    const metrics = m.metrics ?? null;
    blocks.push(
      [
        sectionHeader(`CV MEASUREMENT METADATA — ${id}`),
        toRow(["measurement_id", id]),
        toRow(["measurement_timestamp", ts]),
        toRow(["mode", "CV"]),
        toRow(["concentration_mM", fmtSig(m.concentration ?? null)]),
        toRow(["cv_model", fmtStr(m.params.cvModel)]),
        toRow(["scan_rate_mVs", fmtSig(m.params.scanRate)]),
        toRow(["E_start_V", fmtSig(m.params.eStart)]),
        toRow(["E_vertex1_V", fmtSig(m.params.eVertex1)]),
        toRow(["E_vertex2_V", fmtSig(m.params.eVertex2)]),
        toRow(["n_cycles", `${m.params.nCycles}`]),
        toRow(["area_cm2", fmtSig(m.params.areaCm2)]),
        toRow(["n_electrons", `${m.params.n}`]),
        toRow(["baseline_method_input", metrics?.baselineMethodInput ?? "N/A"]),
        toRow(["baseline_resolved_method", metrics?.baselineResolvedMethod ?? "N/A"]),
        toRow(["title", fmtStr(n?.title)]),
        toRow(["operator", fmtStr(n?.operator)]),
        toRow(["sample_id", fmtStr(n?.sampleId)]),
        toRow(["electrode_id", fmtStr(n?.electrodeId)]),
        toRow(["analyte", fmtStr(n?.analyte)]),
        toRow(["electrolyte", fmtStr(n?.electrolyte)]),
        toRow(["reference_electrode", fmtStr(n?.referenceElectrode)]),
        toRow(["working_electrode", fmtStr(n?.workingElectrode)]),
        toRow(["counter_electrode", fmtStr(n?.counterElectrode)]),
        toRow(["temperature_C", fmtSig(n?.temperature_C)]),
        toRow(["pH", fmtSig(n?.pH)]),
        toRow(["tags", n?.tags && n.tags.length > 0 ? n.tags.join("|") : "N/A"]),
        toRow(["notes", sanitizeNotesForCSV(n?.notes)]),
      ].join("\n"),
    );
  }
  const procHeaders = [
    "measurement_id", "mode",
    "Epa_V", "Epc_V", "deltaEp_mV", "E0prime_V",
    "Ipa_raw_uA", "Ipc_raw_uA",
    "Ipa_corrected_uA", "Ipc_corrected_uA",
    "abs_Ipa_over_Ipc",
    "noise_uA", "SNR_anodic", "SNR_cathodic",
    "n_est", "n_est_valid",
    "D_apparent_cm2_s", "D_status", "D_peak_source",
    "reversibility",
    "baseline_method", "baseline_resolved_method",
    "warnings",
  ];
  const proc: string[] = [sectionHeader("PROCESSED CV RESULTS"), toRow(procHeaders)];
  for (const m of cvList) {
    const id = m.measurementId ?? m.id;
    const metrics = m.metrics;
    if (!metrics) {
      proc.push(toRow([id, "cv", ...procHeaders.slice(2).map(() => "N/A")]));
      continue;
    }
    proc.push(toRow([
      id, "cv",
      fmtSig(metrics.Epa), fmtSig(metrics.Epc), fmtSig(metrics.deltaEp), fmtSig(metrics.E0prime),
      fmtSig(metrics.IpaRaw), fmtSig(metrics.IpcRaw),
      fmtSig(metrics.IpaCorrected), fmtSig(metrics.IpcCorrected),
      fmtSig(metrics.IpaIpcRatio),
      fmtSig(metrics.noise_uA), fmtSig(metrics.SNR_anodic), fmtSig(metrics.SNR_cathodic),
      fmtSig(metrics.n_electrons), metrics.n_est_valid ? "Yes" : "No",
      fmtSig(metrics.D_apparent), metrics.D_status, metrics.D_peak_source ?? "none",
      metrics.reversibility,
      metrics.baselineMethod, metrics.baselineResolvedMethod,
      metrics.warnings.length ? metrics.warnings.join(" | ") : "N/A",
    ]));
  }
  blocks.push(proc.join("\n"));
  return blocks.join(BLANK);
}

// ───────────────────────── public exports ─────────────────────────

export interface ModeExportMetadata {
  notes?: MeasurementNotes;
  measurementId?: string;
  measurementTimestamp?: number;
}

/**
 * Build a small "MEASUREMENT METADATA" key/value block for EIS/FET exports.
 * Always emits the same row set so columns stay stable even when notes are absent.
 */
function buildNotesMetaSection(
  technique: "EIS" | "BioFET-transfer" | "BioFET-time",
  source: ExportSource,
  meta: ModeExportMetadata,
  fallbackId: string,
  fallbackTs: number,
): string {
  const n = meta.notes;
  const rows = [
    sectionHeader("MEASUREMENT METADATA"),
    toRow(["measurement_id", meta.measurementId ?? fallbackId]),
    toRow(["measurement_timestamp", fmtTs(meta.measurementTimestamp ?? fallbackTs)]),
    toRow(["technique", technique]),
    toRow(["source", source]),
    toRow(["title", fmtStr(n?.title)]),
    toRow(["operator", fmtStr(n?.operator)]),
    toRow(["sample_id", fmtStr(n?.sampleId)]),
    toRow(["electrode_id", fmtStr(n?.electrodeId)]),
    toRow(["analyte", fmtStr(n?.analyte)]),
    toRow(["electrolyte", fmtStr(n?.electrolyte)]),
    toRow(["reference_electrode", fmtStr(n?.referenceElectrode)]),
    toRow(["working_electrode", fmtStr(n?.workingElectrode)]),
    toRow(["counter_electrode", fmtStr(n?.counterElectrode)]),
    toRow(["temperature_C", fmtSig(n?.temperature_C)]),
    toRow(["pH", fmtSig(n?.pH)]),
    toRow(["tags", n?.tags && n.tags.length > 0 ? n.tags.join("|") : "N/A"]),
    toRow(["notes", sanitizeNotesForCSV(n?.notes)]),
  ];
  return rows.join("\n");
}

/**
 * Optional payload of processed EIS fit results to include in the
 * single-measurement EIS export. All fields optional — missing values
 * render as N/A. Designed so the EIS CSV is self-contained for analysis
 * without requiring the full session export.
 */
export interface EISExportFitOptions {
  cnlsFit?: import("./eisFit").EISFitResult | null;
  randlesFit?: import("./randlesFit").RandlesFitResult | null;
  linKK?: import("./linKK").LinKKResult | null;
  warburg?: import("./randlesFit").WarburgResult | null;
  signalQuality?: unknown;
  fitSource?: string;
  fitRangeMinHz?: number;
  fitRangeMaxHz?: number;
}

function buildEISProcessedFitSection(o: EISExportFitOptions): string {
  const f = o.cnlsFit ?? null;
  const r = o.randlesFit ?? null;
  const model = f?.model ?? (r ? "randles" : undefined);
  const Rs = f?.params.Rs ?? r?.Rs;
  const Rct = f?.params.Rct ?? r?.Rct;
  const Cdl = f?.params.Cdl ?? r?.Cdl;
  const Q = f?.params.Q;
  const nCpe = f?.params.n;
  let f0: number | undefined;
  if (model === "randles-cpe" && Rct && Q && nCpe && nCpe > 0) {
    f0 = Math.pow(Rct * Q, -1 / nCpe) / (2 * Math.PI);
  } else if (Rct && Cdl) {
    f0 = 1 / (2 * Math.PI * Rct * Cdl);
  } else {
    f0 = r?.f0;
  }
  const wssr = f?.weightedSsrPerDof ?? f?.chiSquared ?? r?.chiSquared;
  const rmsePct = wssr != null && Number.isFinite(wssr)
    ? Math.sqrt(Math.max(wssr, 0)) * 100
    : r?.fitErrorPct;
  const fitRangeMin = o.fitRangeMinHz ?? f?.fitFreqRange?.min ?? r?.fitFreqRange?.min;
  const fitRangeMax = o.fitRangeMaxHz ?? f?.fitFreqRange?.max ?? r?.fitFreqRange?.max;
  const fitSource = o.fitSource
    ?? (model === "randles-cpe" ? "cnls_randles_cpe" : model === "randles-warburg" ? "cnls_randles_warburg" : f ? "cnls_randles" : r?.auto ? "auto_cnls_randles" : r ? "manual_randles" : "geometric");

  const errPct = (name: string): string => {
    const e = f?.errors?.[name] ?? r?.errors?.[name];
    return Number.isFinite(e) ? `${(e as number).toFixed(2)}` : "N/A";
  };

  const rows: [string, string][] = [
    ["fit_model", model ?? "N/A"],
    ["fit_source", fitSource ?? "N/A"],
    ["fit_converged", f ? (f.converged ? "Yes" : "No") : (r ? (r.fitErrorPct !== -1 ? "Yes" : "No") : "N/A")],
    ["Rs_ohm", fmtSig(Rs)],
    ["Rs_SE_pct", errPct("Rs")],
    ["Rct_ohm", fmtSig(Rct)],
    ["Rct_SE_pct", errPct("Rct")],
    ["Cdl_F", model === "randles-cpe" ? "N/A" : fmtSig(Cdl)],
    ["Cdl_uF", model === "randles-cpe" || Cdl == null ? "N/A" : fmtSig(Cdl * 1e6)],
    ["Cdl_SE_pct", model === "randles-cpe" ? "N/A" : errPct("Cdl")],
    ["Q_s_alpha_per_ohm", fmtSig(Q)],
    ["Q_SE_pct", errPct("Q")],
    ["n_cpe", fmtSig(nCpe)],
    ["n_cpe_SE_pct", errPct("n")],
    ["f0_Hz", fmtSig(f0)],
    ["weighted_ssr_per_dof", fmtSig(wssr)],
    ["rmse_weighted_percent", fmtSig(rmsePct)],
    ["residual_noise_percent", fmtSig(rmsePct)],
    ["fit_range_min_Hz", fmtSig(fitRangeMin)],
    ["fit_range_max_Hz", fmtSig(fitRangeMax)],
    ["n_points", fmtSig(f?.nPoints ?? r?.semicirclePoints)],
    ["n_free_params", fmtSig(f?.nFreeParams)],
    ["covariance_method", f?.covarianceMethod ?? "N/A"],
    ["covariance_warning", f?.covarianceWarning == null ? "N/A" : f.covarianceWarning ? "Yes" : "No"],
    ["extrapolation_present", f?.extrapolationPresent == null ? "N/A" : f.extrapolationPresent ? "Yes" : "No"],
  ];
  const lines = [sectionHeader("PROCESSED EIS FIT RESULTS")];
  for (const [k, v] of rows) lines.push(toRow([k, v]));
  const warns = [
    ...(f?.warnings ?? []),
    ...(r?.warnFlags ?? []),
  ];
  lines.push(toRow(["warnings", warns.length > 0 ? sanitizeNotesForCSV(warns.join(" | ")) : "N/A"]));
  return lines.join("\n");
}

function buildEISLinKKSection(lk: import("./linKK").LinKKResult | null | undefined): string {
  const lines = [sectionHeader("LIN-KK RESULTS")];
  if (!lk) {
    for (const k of [
      "lin_kk_method", "lin_kk_passed", "lin_kk_rms_residual_percent",
      "lin_kk_max_residual_percent", "lin_kk_tau_count",
      "lin_kk_negative_Rk_count", "lin_kk_negative_Rk_percent", "lin_kk_warnings",
    ]) lines.push(toRow([k, "N/A"]));
    return lines.join("\n");
  }
  lines.push(toRow(["lin_kk_method", lk.method ?? "N/A"]));
  lines.push(toRow(["lin_kk_passed", lk.passed ? "Yes" : "No"]));
  lines.push(toRow(["lin_kk_rms_residual_percent", fmtSig(lk.residualRmsPct)]));
  lines.push(toRow(["lin_kk_max_residual_percent", fmtSig(lk.maxResidualPct)]));
  lines.push(toRow(["lin_kk_tau_count", fmtSig(lk.tauCount)]));
  lines.push(toRow(["lin_kk_negative_Rk_count", fmtSig(lk.negativeRkCount)]));
  lines.push(toRow(["lin_kk_negative_Rk_percent", fmtSig(lk.negativeRkPct)]));
  lines.push(toRow(["lin_kk_warnings", lk.warnings && lk.warnings.length > 0
    ? sanitizeNotesForCSV(lk.warnings.join(" | "))
    : "N/A"]));
  return lines.join("\n");
}

function buildEISWarburgSection(wb: import("./randlesFit").WarburgResult | null | undefined): string {
  const lines = [sectionHeader("WARBURG RESULTS")];
  if (!wb) {
    for (const k of [
      "warburg_method", "Aw_ohm_s_minus_half", "warburg_intercept_imag_ohm",
      "warburg_slope_nyquist", "warburg_r2", "n_points", "warburg_warnings",
    ]) lines.push(toRow([k, "N/A"]));
    return lines.join("\n");
  }
  lines.push(toRow(["warburg_method", wb.method ?? "N/A"]));
  lines.push(toRow(["Aw_ohm_s_minus_half", fmtSig(wb.Aw)]));
  lines.push(toRow(["warburg_intercept_imag_ohm", fmtSig(wb.interceptImag)]));
  lines.push(toRow(["warburg_slope_nyquist", fmtSig(wb.slope ?? wb.slopeNyquist)]));
  lines.push(toRow(["warburg_r2", fmtSig(wb.r2Imag ?? wb.r2)]));
  lines.push(toRow(["n_points", fmtSig(wb.nPoints)]));
  const warns = wb.warnings ?? (wb.warburgWarning ? [wb.warburgWarning] : []);
  lines.push(toRow(["warburg_warnings", warns.length > 0 ? sanitizeNotesForCSV(warns.join(" | ")) : "N/A"]));
  return lines.join("\n");
}

export function exportEISData(
  data: EISDataPoint[],
  source: ExportSource = "simulated",
  meta: ModeExportMetadata & EISExportFitOptions = {},
) {
  const now = Date.now();
  const id = meta.measurementId ?? `eis_${now}`;
  const ts = fmtTs(meta.measurementTimestamp ?? now);
  const rawLines = [sectionHeader("RAW EIS DATA"), toRow(RAW_EIS_HEADERS)];
  for (const p of data) {
    rawLines.push(toRow([
      id, NO_CHANNEL, ts, "eis", "N/A",
      fmtNum(p.frequency), fmtNum(p.zReal), fmtNum(p.zImag), fmtNum(p.zMag), fmtNum(p.phase),
    ]));
  }
  const out = [
    metaRow(1, source),
    buildNotesMetaSection("EIS", source, meta, id, now),
    rawLines.join("\n"),
    buildEISProcessedFitSection(meta),
    buildEISLinKKSection(meta.linKK ?? null),
    buildEISWarburgSection(meta.warburg ?? null),
  ].join(BLANK);
  downloadTSV(`eis_data_${now}.tsv`, out);
}


export function exportFETTransferData(
  baseline: FETTransferPoint[],
  analyte: FETTransferPoint[],
  source: ExportSource = "simulated",
  meta: ModeExportMetadata = {},
) {
  const now = Date.now();
  const id = meta.measurementId ?? `fet_${now}`;
  const ts = fmtTs(meta.measurementTimestamp ?? now);
  const rawLines = [sectionHeader("RAW FET TRANSFER DATA"), toRow(RAW_FET_TRANSFER_HEADERS)];
  for (const p of baseline) {
    rawLines.push(toRow([id, NO_CHANNEL, ts, "N/A", "baseline", fmtNum(p.vg), fmtNum(p.id)]));
  }
  for (const p of analyte) {
    rawLines.push(toRow([id, NO_CHANNEL, ts, "N/A", "analyte", fmtNum(p.vg), fmtNum(p.id)]));
  }
  const out = [
    metaRow(1, source),
    buildNotesMetaSection("BioFET-transfer", source, meta, id, now),
    rawLines.join("\n"),
    [sectionHeader("PROCESSED RESULTS"), toRow(PROC_HEADERS)].join("\n"),
    [sectionHeader("CALIBRATION"), toRow(CAL_HEADERS)].join("\n"),
  ].join(BLANK);
  downloadTSV(`fet_transfer_${now}.tsv`, out);
}

export function exportFETTimeData(
  data: FETTimePoint[],
  source: ExportSource = "simulated",
  meta: ModeExportMetadata = {},
) {
  const now = Date.now();
  const id = meta.measurementId ?? `fet_time_${now}`;
  const ts = fmtTs(meta.measurementTimestamp ?? now);
  const rawLines = [sectionHeader("RAW FET TIME DATA"), toRow(RAW_FET_TIME_HEADERS)];
  for (const p of data) {
    rawLines.push(toRow([id, NO_CHANNEL, ts, "N/A", fmtNum(p.time), fmtNum(p.id), "N/A"]));
  }
  const out = [
    metaRow(1, source),
    buildNotesMetaSection("BioFET-time", source, meta, id, now),
    rawLines.join("\n"),
    [sectionHeader("PROCESSED RESULTS"), toRow(PROC_HEADERS)].join("\n"),
    [sectionHeader("CALIBRATION"), toRow(CAL_HEADERS)].join("\n"),
  ].join(BLANK);
  downloadTSV(`fet_time_${now}.tsv`, out);
}



/**
 * Combined BioFET single-measurement export: metadata + raw transfer + raw
 * time + processed BioFET results in one CSV. The processed block is
 * BioFET-specific so values are easy to find without scrolling past the
 * EIS schema.
 */
export interface FETExportMetrics {
  vtBaseline?: number | null;
  vtAnalyte?: number | null;
  deltaVt_mV?: number | null;
  deltaVt_mV_signed?: number | null;
  calibrationSignal_mV_used?: number | null;
  vtMethod?: string;
  vtFitR2?: number | null;
  vtRegionPoints?: number;
  vtIoffUsed?: number;
  vtWarning?: string;
  ion_uA?: number | null;
  ioff_uA?: number | null;
  ionIoffRatio?: number | null;
  subthresholdSlope_mV_dec?: number | null;
  baselineStabilityNoisePct?: number | null;
}

export interface FETDataExportArgs {
  baseline: FETTransferPoint[];
  analyte: FETTransferPoint[];
  timeData: FETTimePoint[];
  markers?: { time: number; label: string }[];
  source?: ExportSource;
  meta?: ModeExportMetadata;
  concentration?: number | null;
  params?: {
    vgMin: number; vgMax: number; vgStep: number; intervalMs: number;
    kd_nM?: number; vtBaseline_V?: number; deltaVtMax_V?: number;
    idMax_uA?: number; idealityFactor?: number;
    bindingRate_perS?: number; readoutBias_V?: number;
    timeDuration_s?: number; timeStep_s?: number; injectionTime_s?: number;
  };
  metrics?: FETExportMetrics;
  responseMode?: "auto" | "signed" | "absolute";
  responseSign?: 1 | -1;
}

export function exportFETData(args: FETDataExportArgs) {
  const source = args.source ?? "simulated";
  const meta = args.meta ?? {};
  const now = Date.now();
  const id = meta.measurementId ?? `fet_${now}`;
  const ts = fmtTs(meta.measurementTimestamp ?? now);
  const conc = args.concentration ?? null;

  const rawTransfer = [
    sectionHeader("RAW FET TRANSFER DATA"),
    toRow(RAW_FET_TRANSFER_HEADERS),
  ];
  for (const p of args.baseline)
    rawTransfer.push(toRow([id, NO_CHANNEL, ts, fmtNum(conc), "baseline", fmtNum(p.vg), fmtNum(p.id)]));
  for (const p of args.analyte)
    rawTransfer.push(toRow([id, NO_CHANNEL, ts, fmtNum(conc), "analyte", fmtNum(p.vg), fmtNum(p.id)]));

  const rawTime = [
    sectionHeader("RAW FET TIME DATA"),
    toRow(RAW_FET_TIME_HEADERS),
  ];
  for (const p of args.timeData)
    rawTime.push(toRow([id, NO_CHANNEL, ts, fmtNum(conc), fmtNum(p.time), fmtNum(p.id), "N/A"]));
  for (const mk of (args.markers ?? []))
    rawTime.push(toRow([id, NO_CHANNEL, ts, fmtNum(conc), fmtNum(mk.time), "N/A", fmtStr(mk.label)]));


  const m = args.metrics ?? {};
  const procRows = [
    sectionHeader("PROCESSED BIOFET RESULTS"),
    toRow(["key", "value"]),
    toRow(["measurement_id", id]),
    toRow(["concentration_nM", fmtNum(conc)]),
    toRow(["vt_baseline_V", fmtNum(m.vtBaseline)]),
    toRow(["vt_analyte_V", fmtNum(m.vtAnalyte)]),
    toRow(["deltaVt_mV", fmtNum(m.deltaVt_mV)]),
    toRow(["deltaVt_mV_signed", fmtNum(m.deltaVt_mV_signed ?? m.deltaVt_mV)]),
    toRow(["calibration_signal_mV_used", fmtNum(m.calibrationSignal_mV_used)]),
    toRow(["vt_method", fmtStr(m.vtMethod)]),
    toRow(["vt_fit_r2", fmtNum(m.vtFitR2)]),
    toRow(["vt_region_points", m.vtRegionPoints == null ? "N/A" : String(m.vtRegionPoints)]),
    toRow(["vt_ioff_used_uA", fmtNum(m.vtIoffUsed)]),
    toRow(["vt_warning", fmtStr(m.vtWarning)]),
    toRow(["ion_uA", fmtNum(m.ion_uA)]),
    toRow(["ioff_uA", fmtNum(m.ioff_uA)]),
    toRow(["ion_ioff_ratio", fmtNum(m.ionIoffRatio)]),
    toRow(["subthreshold_slope_mV_dec", fmtNum(m.subthresholdSlope_mV_dec)]),
    toRow(["baseline_stability_noise_pct", fmtNum(m.baselineStabilityNoisePct)]),
    toRow(["responseMode", fmtStr(args.responseMode)]),
    toRow(["responseSign", args.responseSign == null ? "N/A" : String(args.responseSign)]),
    toRow(["vgMin_V", fmtNum(args.params?.vgMin)]),
    toRow(["vgMax_V", fmtNum(args.params?.vgMax)]),
    toRow(["vgStep_mV", fmtNum(args.params?.vgStep)]),
    toRow(["intervalMs", fmtNum(args.params?.intervalMs)]),
    toRow(["kd_nM", fmtNum(args.params?.kd_nM)]),
    toRow(["vtBaseline_V", fmtNum(args.params?.vtBaseline_V)]),
    toRow(["deltaVtMax_V", fmtNum(args.params?.deltaVtMax_V)]),
    toRow(["idMax_uA", fmtNum(args.params?.idMax_uA)]),
    toRow(["idealityFactor", fmtNum(args.params?.idealityFactor)]),
    toRow(["bindingRate_perS", fmtNum(args.params?.bindingRate_perS)]),
    toRow(["readoutBias_V", fmtNum(args.params?.readoutBias_V)]),
    toRow(["timeDuration_s", fmtNum(args.params?.timeDuration_s)]),
    toRow(["timeStep_s", fmtNum(args.params?.timeStep_s)]),
    toRow(["injectionTime_s", fmtNum(args.params?.injectionTime_s)]),
  ];

  const out = [
    metaRow(1, source),
    buildNotesMetaSection("BioFET-transfer", source, meta, id, now),
    rawTransfer.join("\n"),
    rawTime.join("\n"),
    procRows.join("\n"),
  ].join(BLANK);
  downloadTSV(`fet_data_${now}.tsv`, out);
}

export function exportSessionCSV(
  measurements: StoredMeasurement[],
  options: { source?: ExportSource; calibration?: CalibrationExportPoint[] } = {},
) {
  const source = options.source ?? "simulated";
  const calibration = options.calibration ?? [];
  const cvBlock = buildSessionCVMetaAndMetrics(measurements);
  const sections = [
    metaRow(measurements.length, source),
    buildRawSection(measurements),
    buildProcessedSection(measurements),
  ];
  if (cvBlock) sections.push(cvBlock);
  sections.push(buildCalibrationSection(calibration));
  sections.push(buildActivitySection());
  const out = sections.join(BLANK);
  downloadTSV(`electrostat_session_${Date.now()}.tsv`, out);
}

export function exportCalibrationCSV(
  mode: "eis" | "fet" | "swv",
  points: CalibrationExportPoint[],
  source: ExportSource = "simulated",
) {
  const stamped = points.map((p) => ({ ...p, mode: p.mode ?? mode }));
  const out = [
    metaRow(stamped.length, source),
    buildCalibrationSection(stamped),
  ].join(BLANK);
  downloadTSV(`calibration_${mode}_${Date.now()}.tsv`, out);
}

// ───────────────────────── CV ─────────────────────────

const RAW_CV_HEADERS = [
  "measurement_id", "channel", "timestamp", "time_s", "cycle", "branch",
  "E_V", "I_uA", "baseline_uA", "I_corrected_uA",
];

/** Format a number with 6 sig figs, scientific for tiny values. */
function fmtSig(v: unknown): string {
  if (v == null) return "N/A";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "N/A";
  if (n !== 0 && (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e6)) {
    return n.toExponential(6);
  }
  return n.toPrecision(7);
}

export interface CVExportParams {
  scanRate: number;
  eStart: number;
  eVertex1: number;
  eVertex2: number;
  nCycles: number;
  n: number;
  cMM: number;
  areaCm2: number;
  cvModel: string;
  // Analyte / kinetic (optional — fall back to CV_* defaults in export)
  diffusionCoeff?: number;
  formalPotential?: number;
  k0?: number;
  alpha?: number;
  // Acquisition
  stepPotential?: number;
  quietTime?: number;
  /** Optional logbook / measurement notes — purely metadata. */
  notes?: CVMeasurementNotes;
  /** Stable measurement id (cv_YYYYMMDD_HHMMSS_<rand>). */
  measurementId?: string;
  /** Unix ms when the measurement started. */
  measurementTimestamp?: number;
}

// sanitizeNotesForCSV imported from @/utils/measurementNotes

/**
 * Pure builder — assembles the CV CSV/TSV body as a string. Exposed so unit
 * tests can assert headers, baseline columns and processed metrics without
 * touching the DOM download path.
 */
export function buildCVExportText(
  data: CVDataPoint[],
  metrics: CVMetrics | null,
  cvParams: CVExportParams,
  source: ExportSource = "simulated",
  plotMode: "raw" | "corrected" = "raw",
): string {
  const id = cvParams.measurementId ?? `cv_${Date.now()}`;
  const ts = fmtTs(cvParams.measurementTimestamp ?? Date.now());
  const notes = cvParams.notes;
  const isReversible = cvParams.cvModel === "reversible";
  const isSimulated = source === "simulated";
  // Solver provenance is meaningful only for simulated data. Live/hardware/imported
  // curves were not produced by the in-app solver — never advertise solver fields.
  const simulationModel = isSimulated
    ? isReversible
      ? "reversible-diffusion"
      : "quasi-reversible-approx"
    : source === "live"
      ? "not_applicable_live_hardware_data"
      : source === "imported"
        ? "not_applicable_imported_data"
        : "unknown";
  const solverType = isSimulated
    ? isReversible
      ? "implicit-diffusion-nernst"
      : "butler-volmer-cottrell-approx"
    : "not_applicable";
  const solverField = (v: string) => (isSimulated ? v : "n/a");
  const meta = [
    sectionHeader("METADATA"),
    toRow(["measurement_id", id]),
    toRow(["measurement_timestamp", ts]),
    toRow(["technique", "CV"]),
    toRow(["timestamp", ts]),
    toRow(["source", source]),
    toRow(["cv_model", cvParams.cvModel]),
    toRow(["simulation_model", simulationModel]),
    toRow(["solver_type", solverType]),
    toRow(["solver_step_V", solverField(fmtSig((cvParams.stepPotential ?? CV_SOLVER_DEFAULT_STEP_V * 1000) / 1000))]),
    toRow(["solver_spatial_nodes", solverField(isReversible ? `${CV_SOLVER_DEFAULT_SPATIAL_NODES}` : "n/a")]),
    toRow(["solver_D_cm2_s", solverField(fmtSig(cvParams.diffusionCoeff ?? CV_DEFAULT_D_CM2_S))]),
    toRow(["solver_temperature_K", solverField(fmtSig(CV_T_DEFAULT_K))]),
    toRow(["solver_E0prime_V", solverField(fmtSig(cvParams.formalPotential ?? CV_E0_PRIME_DEFAULT_V))]),
    toRow(["solver_domain_rule", solverField(isReversible ? CV_SOLVER_DOMAIN_RULE : "n/a")]),
    toRow(["scan_rate_mVs", fmtSig(cvParams.scanRate)]),
    toRow(["E_start_V", fmtSig(cvParams.eStart)]),
    toRow(["E_vertex1_V", fmtSig(cvParams.eVertex1)]),
    toRow(["E_vertex2_V", fmtSig(cvParams.eVertex2)]),
    toRow(["n_cycles", `${cvParams.nCycles}`]),
    toRow(["concentration_mM", fmtSig(cvParams.cMM)]),
    toRow(["area_cm2", fmtSig(cvParams.areaCm2)]),
    toRow(["n_electrons", `${cvParams.n}`]),
    toRow(["diffusionCoeff_cm2_s", fmtSig(cvParams.diffusionCoeff)]),
    toRow(["formalPotential_V", fmtSig(cvParams.formalPotential)]),
    toRow(["k0_cm_s", fmtSig(cvParams.k0)]),
    toRow(["alpha_transfer_coeff", fmtSig(cvParams.alpha)]),
    toRow(["stepPotential_mV", fmtSig(cvParams.stepPotential)]),
    toRow(["quietTime_s", fmtSig(cvParams.quietTime)]),
    toRow(["temperature_K", fmtSig(CV_T_DEFAULT_K)]),
    toRow(["baseline_method", metrics?.baselineMethod ?? "n/a"]),
    toRow(["baseline_method_input", metrics?.baselineMethodInput ?? "n/a"]),
    toRow(["baseline_resolved_method", metrics?.baselineResolvedMethod ?? "n/a"]),
    toRow(["metrics_cycle", metrics ? `${metrics.metricsCycle}` : "n/a"]),
    toRow([
      "corrected_data_available",
      metrics?.correctedDataAvailable ? "Yes" : "No",
    ]),
    toRow([
      "corrected_data_covers_all_cycles",
      metrics?.correctedDataCoversAllCycles ? "Yes" : "No",
    ]),
    toRow(["exported_current_mode", plotMode]),
    // ── Logbook / measurement notes (optional, never sent to hardware)
    toRow(["title", fmtStr(notes?.title)]),
    toRow(["operator", fmtStr(notes?.operator)]),
    toRow(["sample_id", fmtStr(notes?.sampleId)]),
    toRow(["electrode_id", fmtStr(notes?.electrodeId)]),
    toRow(["analyte", fmtStr(notes?.analyte)]),
    toRow(["electrolyte", fmtStr(notes?.electrolyte)]),
    toRow(["reference_electrode", fmtStr(notes?.referenceElectrode)]),
    toRow(["working_electrode", fmtStr(notes?.workingElectrode)]),
    toRow(["counter_electrode", fmtStr(notes?.counterElectrode)]),
    toRow(["temperature_C", fmtSig(notes?.temperature_C)]),
    toRow(["pH", fmtSig(notes?.pH)]),
    toRow([
      "tags",
      notes?.tags && notes.tags.length > 0 ? notes.tags.join("|") : "N/A",
    ]),
    toRow(["notes", sanitizeNotesForCSV(notes?.notes)]),
  ].join("\n");
  const raw = [sectionHeader("RAW CV DATA"), toRow(RAW_CV_HEADERS)];
  // Prefer the per-point baseline/Icorr from metrics.correctedData when available.
  const corrIdx = new Map<number, CVDataPoint>();
  if (metrics?.correctedData) {
    metrics.correctedData.forEach((p, i) => corrIdx.set(i, p));
  }
  const useCorrected =
    metrics?.correctedData && metrics.correctedData.length === data.length;
  for (let i = 0; i < data.length; i++) {
    const p = data[i];
    const cp = useCorrected ? metrics!.correctedData![i] : undefined;
    raw.push(toRow([
      id, NO_CHANNEL, ts,
      fmtSig(p.t), `${p.cycle}`, fmtStr(p.branch ?? ""),
      fmtSig(p.E), fmtSig(p.I),
      fmtSig(cp?.baseline ?? p.baseline),
      fmtSig(cp?.Icorr ?? p.Icorr),
    ]));
  }
  const procHeaders = [
    "measurement_id", "timestamp", "scan_rate_mVs", "cv_model",
    "Ipa_raw_uA", "Ipc_raw_uA",
    "Ipa_corrected_uA", "Ipc_corrected_uA",
    "Epa_V", "Epc_V", "E0prime_V",
    "deltaEp_mV", "abs_Ipa_over_Ipc",
    "n_est", "n_est_valid",
    "D_apparent_cm2_s", "D_status", "D_peak_source",
    "noise_uA", "SNR_anodic", "SNR_cathodic",
    "reversibility", "baseline_method", "warnings",
    "diffusionCoeff_cm2_s", "formalPotential_V", "k0_cm_s",
    "alpha_transfer_coeff", "stepPotential_mV", "quietTime_s",
  ];
  const proc = [sectionHeader("PROCESSED RESULTS"), toRow(procHeaders)];
  if (metrics) {
    proc.push(toRow([
      id, ts, fmtSig(cvParams.scanRate), fmtStr(cvParams.cvModel),
      fmtSig(metrics.IpaRaw), fmtSig(metrics.IpcRaw),
      fmtSig(metrics.IpaCorrected), fmtSig(metrics.IpcCorrected),
      fmtSig(metrics.Epa), fmtSig(metrics.Epc), fmtSig(metrics.E0prime),
      fmtSig(metrics.deltaEp), fmtSig(metrics.IpaIpcRatio),
      fmtSig(metrics.n_electrons), metrics.n_est_valid ? "Yes" : "No",
      fmtSig(metrics.D_apparent), metrics.D_status, metrics.D_peak_source ?? "none",
      fmtSig(metrics.noise_uA), fmtSig(metrics.SNR_anodic), fmtSig(metrics.SNR_cathodic),
      metrics.reversibility, metrics.baselineMethod,
      metrics.warnings.length ? metrics.warnings.join(" | ") : "N/A",
      fmtSig(cvParams.diffusionCoeff), fmtSig(cvParams.formalPotential),
      fmtSig(cvParams.k0), fmtSig(cvParams.alpha),
      fmtSig(cvParams.stepPotential), fmtSig(cvParams.quietTime),
    ]));
  } else {
    proc.push(toRow(procHeaders.map(() => "N/A")));
  }
  return [metaRow(1, source), meta, raw.join("\n"), proc.join("\n")].join(BLANK);
}

export function exportCVData(
  data: CVDataPoint[],
  metrics: CVMetrics | null,
  cvParams: CVExportParams,
  source: ExportSource = "simulated",
  plotMode: "raw" | "corrected" = "raw",
) {
  const out = buildCVExportText(data, metrics, cvParams, source, plotMode);
  downloadTSV(`cv_data_${Date.now()}.tsv`, out);
}

// ───────────────────────── CV Calibration ─────────────────────────

const CV_CAL_HEADERS = [
  "concentration_mM",
  "Ipa_corrected_uA",
  "Ipc_abs_corrected_uA",
  "response_mean_uA",
  "expected_ip_uA",
  "residual_uA",
  "deltaEp_mV",
  "abs_Ipa_over_Ipc",
  "D_apparent_cm2_s",
  "cv_model",
  "measurement_id",
  "sample_id",
  "electrode_id",
  "notes_short",
  "timestamp",
];

export interface CVCalibrationExportOptions {
  source?: ExportSource;
  responseMode: CVResponseMode;
  n: number;
  areaCm2: number;
  scanRate_mVs: number;
}

export function exportCVCalibrationCSV(
  points: CVCalibrationPoint[],
  opts: CVCalibrationExportOptions,
) {
  const source = opts.source ?? "simulated";
  const summary = summarizeCalibration(points, opts.responseMode);
  const lines: string[] = [];
  lines.push(metaRow(points.length, source));
  lines.push(sectionHeader("CV CALIBRATION"));
  lines.push(toRow(CV_CAL_HEADERS));
  const sorted = [...points].sort((a, b) => a.concentration_mM - b.concentration_mM);
  for (const p of sorted) {
    const expected = randlesSevcikIpUA({
      n: opts.n,
      areaCm2: opts.areaCm2,
      cMM: p.concentration_mM,
      scanRate_mVs: opts.scanRate_mVs,
    });
    const measured = responseFor(p, opts.responseMode);
    const residual =
      summary.fit != null && measured != null
        ? measured - (summary.fit.slope * p.concentration_mM + summary.fit.intercept)
        : null;
    lines.push(
      toRow([
        fmtSig(p.concentration_mM),
        fmtSig(p.Ipa_uA),
        fmtSig(p.IpcAbs_uA),
        fmtSig(p.responseMean_uA),
        fmtSig(expected),
        fmtSig(residual),
        fmtSig(p.deltaEp_mV),
        fmtSig(p.ratio),
        fmtSig(p.Dapparent),
        fmtStr(p.cvModel),
        fmtStr(p.measurementId),
        fmtStr(p.sampleId),
        fmtStr(p.electrodeId),
        p.notes ? sanitizeNotesForCSV(p.notes) : "N/A",
        fmtTs(p.timestamp),
      ]),
    );
  }
  // Summary block
  lines.push("");
  lines.push(sectionHeader("CV CALIBRATION SUMMARY"));
  lines.push(
    toRow([
      "response_mode",
      "slope_uA_per_mM",
      "intercept_uA",
      "r2",
      "n_points",
      "sigma_blank_uA",
      "LOD_mM",
      "LOQ_mM",
      "sigma_source",
      "quality",
    ]),
  );
  lines.push(
    toRow([
      opts.responseMode,
      fmtSig(summary.fit?.slope),
      fmtSig(summary.fit?.intercept),
      fmtSig(summary.fit?.r2),
      `${summary.fit?.nPoints ?? 0}`,
      fmtSig(summary.sigma_uA),
      fmtSig(summary.lod_mM),
      fmtSig(summary.loq_mM),
      summary.sigmaSource,
      summary.quality,
    ]),
  );
  downloadTSV(`cv_calibration_${Date.now()}.tsv`, lines.join("\n"));
}

// ───────────────────────── SWV ─────────────────────────

import type {
  SWVDataPoint,
  SWVMetrics,
  SWVParameters,
} from "@/types/swv";
import type { CalibrationPoint } from "@/components/CalibrationPanel";

export interface ExportSWVOptions {
  data: SWVDataPoint[];
  corrected?: SWVDataPoint[];
  metrics: SWVMetrics | null;
  params: SWVParameters;
  source: ExportSource;
  measurementId?: string;
  measurementTimestamp?: number;
  notes?: MeasurementNotes | null;
  calibration?: CalibrationPoint[];
  simulationModel?: string;
}

/**
 * Individual SWV measurement export — METADATA, RAW SWV DATA, BASELINE /
 * CORRECTED DATA, PROCESSED SWV RESULTS and optional CALIBRATION sections.
 * All currents in µA, potentials in V, concentrations in nM.
 */
export function exportSWVData(opts: ExportSWVOptions) {
  const {
    data, corrected, metrics, params, source, measurementId, measurementTimestamp,
    notes, calibration, simulationModel,
  } = opts;
  const now = Date.now();
  const mid = measurementId ?? `swv_${now}`;
  const ts = fmtTs(measurementTimestamp ?? now);
  const cleanNotes = sanitizeMeasurementNotes(notes ?? undefined);

  const meta: string[] = [];
  meta.push(sectionHeader("METADATA"));
  meta.push(toRow(["measurement_id", mid]));
  meta.push(toRow(["timestamp", ts]));
  meta.push(toRow(["source", source]));
  meta.push(toRow(["mode", "SWV"]));
  meta.push(toRow(["startE_V", fmtSig(params.startE)]));
  meta.push(toRow(["endE_V", fmtSig(params.endE)]));
  meta.push(toRow(["step_mV", fmtSig(params.step_mV)]));
  meta.push(toRow(["amplitude_mV", fmtSig(params.amplitude_mV)]));
  meta.push(toRow(["frequency_Hz", fmtSig(params.frequency_Hz)]));
  meta.push(toRow(["quietTime_s", fmtSig(params.quietTime_s)]));
  meta.push(toRow(["direction", fmtStr(params.direction)]));
  meta.push(toRow(["concentration_nM", fmtSig(params.concentration_nM ?? null)]));
  meta.push(toRow(["area_cm2", fmtSig(params.area_cm2 ?? null)]));
  meta.push(toRow(["n_electrons", fmtSig(params.nElectrons ?? null)]));
  meta.push(toRow(["diffusionCoeff_cm2_s", fmtSig(params.diffusionCoeff ?? params.D_cm2_s ?? null)]));
  meta.push(toRow(["formalPotential_V", fmtSig(params.formalPotential ?? params.E0Prime_V ?? null)]));
  meta.push(toRow(["k0_cm_s", fmtSig(params.k0 ?? null)]));
  meta.push(toRow(["alpha", fmtSig(params.alpha ?? null)]));
  meta.push(toRow(["temperature_K", fmtSig(params.temperature_K ?? null)]));
  meta.push(toRow(["baseline_method_input", fmtStr(params.baselineMethod ?? "none")]));
  meta.push(toRow([
    "baseline_method_resolved",
    fmtStr(metrics?.baselineMethodUsed ?? metrics?.baselineMethod ?? params.baselineMethod ?? "none"),
  ]));
  meta.push(toRow(["smoothing", fmtStr(params.smoothing ?? "none")]));
  // Never invent a provenance label: the caller passes the model that actually
  // ran. `params.model` is a legacy metadata field that did not select any
  // solver, so it is only used as a last-resort echo, never defaulted.
  const effectiveSimModel =
    simulationModel ?? (source === "simulated" ? (params.model ?? null) : null);
  if (effectiveSimModel) meta.push(toRow(["simulation_model", effectiveSimModel]));
  if (cleanNotes) {
    meta.push(toRow(["notes_title", fmtStr(cleanNotes.title)]));
    meta.push(toRow(["notes_operator", fmtStr(cleanNotes.operator)]));
    meta.push(toRow(["notes_sample_id", fmtStr(cleanNotes.sampleId)]));
    meta.push(toRow(["notes_electrode_id", fmtStr(cleanNotes.electrodeId)]));
    meta.push(toRow(["notes_short", fmtStr(shortNotesSummary(cleanNotes))]));
    meta.push(toRow(["notes", fmtStr(cleanNotes.notes)]));
  }

  const raw: string[] = [];
  raw.push(sectionHeader("RAW SWV DATA"));
  raw.push(toRow([
    "index", "channel", "time_s", "E_V", "I_forward_uA", "I_reverse_uA", "I_net_raw_uA", "direction",
  ]));
  for (let i = 0; i < data.length; i++) {
    const p = data[i];
    raw.push(toRow([
      `${i}`, NO_CHANNEL, fmtSig(p.time), fmtSig(p.E),
      fmtSig(p.IForward), fmtSig(p.IReverse), fmtSig(p.INet),
      fmtStr(p.direction),
    ]));
  }

  const corrLines: string[] = [];
  corrLines.push(sectionHeader("BASELINE / CORRECTED DATA"));
  corrLines.push(toRow(["index", "E_V", "baseline_uA", "I_net_corrected_uA"]));
  const corrSrc = corrected && corrected.length === data.length ? corrected : null;
  for (let i = 0; i < data.length; i++) {
    corrLines.push(toRow([
      `${i}`,
      fmtSig(data[i].E),
      fmtSig(corrSrc?.[i]?.baseline ?? null),
      fmtSig(corrSrc?.[i]?.ICorrected ?? null),
    ]));
  }

  const proc: string[] = [];
  proc.push(sectionHeader("PROCESSED SWV RESULTS"));
  proc.push(toRow([
    "peak_detected", "peak_polarity", "peak_potential_V",
    "peak_current_raw_uA", "peak_current_corrected_uA",
    "half_peak_width_mV", "SNR", "noise_rms_uA",
    "baseline_method_used", "baseline_slope_uA_per_V", "baseline_intercept_uA",
    "peak_area_uA_V", "warnings",
  ]));
  proc.push(toRow([
    metrics?.peakDetected ? "Yes" : "No",
    fmtStr(metrics?.peakPolarity ?? "unknown"),
    fmtSig(metrics?.peakPotential_V ?? null),
    fmtSig(metrics?.peakCurrentRaw_uA ?? null),
    fmtSig(metrics?.peakCurrentCorrected_uA ?? null),
    fmtSig(metrics?.halfPeakWidth_mV ?? null),
    fmtSig(metrics?.snr ?? null),
    fmtSig(metrics?.noiseRms_uA ?? null),
    fmtStr(metrics?.baselineMethodUsed ?? metrics?.baselineMethod ?? "none"),
    fmtSig(metrics?.baselineSlope_uA_V ?? null),
    fmtSig(metrics?.baselineIntercept_uA ?? null),
    fmtSig(metrics?.peakArea_uA_V ?? null),
    metrics?.warnings?.length ? sanitizeNotesForCSV(metrics.warnings.join(" | ")) : "N/A",
  ]));

  const cal: string[] = [];
  if (calibration && calibration.length > 0) {
    cal.push(sectionHeader("CALIBRATION"));
    cal.push(toRow([
      "concentration_nM", "signal_uA", "raw_uA", "peak_potential_V",
      "baseline_method", "SNR", "timestamp",
      "measurement_id", "sample_id", "electrode_id", "notes_short",
    ]));
    for (const p of [...calibration].sort((a, b) => a.concentration - b.concentration || a.timestamp - b.timestamp)) {
      cal.push(toRow([
        fmtSig(p.concentration),
        fmtSig(p.signal),
        fmtSig(p.raw),
        fmtSig(p.peakPotential_V ?? null),
        fmtStr(params.baselineMethod ?? "auto"),
        fmtSig(p.snr ?? null),
        fmtTs(p.timestamp),
        fmtStr(p.measurementId),
        fmtStr(p.sampleId),
        fmtStr(p.electrodeId),
        fmtStr(p.notesShort),
      ]));
    }
  }

  const out = [
    metaRow(1, source),
    meta.join("\n"),
    raw.join("\n"),
    corrLines.join("\n"),
    proc.join("\n"),
    ...(cal.length ? [cal.join("\n")] : []),
  ].join(BLANK);
  downloadTSV(`swv_data_${now}.tsv`, out);
}
