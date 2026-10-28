/**
 * CSV import for ElectroStat overlays.
 *
 * Reads a CSV previously exported by this app (individual EIS/CV/SWV export
 * or a combined session export) and reconstructs the raw curve(s) so they
 * can be plotted as overlays. No re-analysis is performed — baseline /
 * corrected values are taken verbatim when present in the file.
 *
 * Session exports concatenate multiple measurements of the same mode into a
 * single RAW section with a shared measurement-id column. The parser groups
 * rows by that column and returns one entry per distinct measurement, so
 * each captured sweep re-appears as its own overlay curve instead of being
 * merged into one jumbled trace. Individual-mode exports without an id
 * column fall back to a single group labelled "imported".
 */

import type { EISDataPoint, FETTransferPoint, FETTimePoint } from "@/hooks/useSimulatedData";
import type { CVDataPoint } from "@/hooks/useSimulatedCVData";
import type { SWVDataPoint, SWVDirection } from "@/types/swv";
import { INSTRUMENT_CSV_KEYS, parseInstrumentRows, type InstrumentSettings } from "@/utils/instrumentSettings";

export interface ImportedEISMeasurement {
  id: string;
  channelLabel?: string;
  /** Instrument settings written by the export (absent in a file from before they were kept). */
  instrument?: InstrumentSettings;
  concentration: number | null;
  points: EISDataPoint[];
}
export interface ImportedCVMeasurement {
  id: string;
  channelLabel?: string;
  /** Instrument settings written by the export (absent in a file from before they were kept). */
  instrument?: InstrumentSettings;
  concentration: number | null;
  points: CVDataPoint[];
}
export interface ImportedSWVMeasurement {
  id: string;
  channelLabel?: string;
  /** Instrument settings written by the export (absent in a file from before they were kept). */
  instrument?: InstrumentSettings;
  concentration: number | null;
  points: SWVDataPoint[];
}
export interface ImportedFETTransferMeasurement {
  id: string;
  channelLabel?: string;
  /** Instrument settings written by the export (absent in a file from before they were kept). */
  instrument?: InstrumentSettings;
  concentration: number | null;
  baseline: FETTransferPoint[];
  analyte: FETTransferPoint[];
}
export interface ImportedFETTimeMeasurement {
  id: string;
  channelLabel?: string;
  /** Instrument settings written by the export (absent in a file from before they were kept). */
  instrument?: InstrumentSettings;
  concentration: number | null;
  points: FETTimePoint[];
  markers: { time: number; label: string }[];
}

export interface ImportedEIS {
  mode: "eis";
  measurements: ImportedEISMeasurement[];
  skipped: number;
}
export interface ImportedCV {
  mode: "cv";
  measurements: ImportedCVMeasurement[];
  skipped: number;
}
export interface ImportedSWV {
  mode: "swv";
  measurements: ImportedSWVMeasurement[];
  skipped: number;
}
export interface ImportedFETTransfer {
  mode: "fet_transfer";
  measurements: ImportedFETTransferMeasurement[];
  skipped: number;
}
export interface ImportedFETTime {
  mode: "fet_time";
  measurements: ImportedFETTimeMeasurement[];
  skipped: number;
}
export interface ImportError {
  error: string;
}

export type ImportResult =
  | ImportedEIS
  | ImportedCV
  | ImportedSWV
  | ImportedFETTransfer
  | ImportedFETTime
  | ImportError;

const SECTION_EIS = "=== RAW EIS DATA ===";
const SECTION_CV = "=== RAW CV DATA ===";
const SECTION_SWV = "=== RAW SWV DATA ===";
const SECTION_FET_TRANSFER = "=== RAW FET TRANSFER DATA ===";
const SECTION_FET_TIME = "=== RAW FET TIME DATA ===";


const FALLBACK_ID = "imported";

/** Split a CSV row on delimiter, honouring double-quoted fields with "" escapes. */
function splitCsvRow(row: string, delim: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (inQ) {
      if (c === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQ = true;
      else if (c === delim) {
        cells.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function detectDelimiter(lines: string[]): string {
  const first = lines.find((l) => l.trim().length > 0) ?? "";
  const m = /^sep=(.)$/i.exec(first.trim());
  if (m) return m[1];
  for (const l of lines) {
    if (l.includes(";")) return ";";
  }
  for (const l of lines) {
    if (l.includes(",")) return ",";
  }
  return ";";
}

function isSectionLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("=== ") && t.includes(" ===");
}

function parseNum(v: string | undefined): number {
  if (v == null) return NaN;
  const s = v.trim();
  if (s === "" || s === "N/A" || s === "n/a") return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function findCol(headers: string[], candidates: string[]): number {
  const norm = headers.map((h) => h.trim());
  for (const c of candidates) {
    const i = norm.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * The instrument settings of each measurement of an export, by measurement id: the rows of the
 * settings (rtia_requested_ohms, calibration_run, dc_bias_V, ...) that follow a measurement_id row,
 * in the metadata block of a single export or in an INSTRUMENT SETTINGS block of a session.
 */
function readInstrumentSettings(lines: string[], delim: string): Map<string, InstrumentSettings> {
  const keys = new Set(INSTRUMENT_CSV_KEYS);
  const rowsById = new Map<string, [string, string][]>();
  let currentId: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const cells = splitCsvRow(line, delim);
    const nonEmpty = cells.filter((c) => c.trim() !== "").length;
    if (cells[0].trim() === "measurement_id" && nonEmpty === 2) {
      currentId = cells[1].trim();
      continue;
    }
    if (currentId && nonEmpty >= 1 && keys.has(cells[0].trim())) {
      const rows = rowsById.get(currentId) ?? [];
      rows.push([cells[0], cells[1] ?? ""]);
      rowsById.set(currentId, rows);
    }
  }
  const out = new Map<string, InstrumentSettings>();
  for (const [id, rows] of rowsById) {
    const settings = parseInstrumentRows(rows);
    if (Object.keys(settings).length > 0) out.set(id, settings);
  }
  return out;
}

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

interface SectionSlice {
  headers: string[];
  rows: string[][];
}

function extractSection(
  lines: string[],
  delim: string,
  sectionMarker: string,
): SectionSlice | null {
  const startIdx = lines.findIndex((l) => l.trimStart().startsWith(sectionMarker));
  if (startIdx < 0) return null;

  let hIdx = startIdx + 1;
  while (hIdx < lines.length && lines[hIdx].trim() === "") hIdx++;
  if (hIdx >= lines.length) return null;
  const headers = splitCsvRow(lines[hIdx], delim).map((s) => s.trim());

  const rows: string[][] = [];
  for (let i = hIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      if (rows.length > 0) break;
      continue;
    }
    if (isSectionLine(line)) break;
    rows.push(splitCsvRow(line, delim));
  }
  return { headers, rows };
}

/**
 * Group a list of `{id, concentration, point}` tuples back into per-measurement
 * arrays, preserving row order. When no id column was found in the section,
 * everything collapses into a single fallback group.
 */
function groupByMeasurement<P>(
  entries: { id: string; concentration: number | null; channelLabel?: string; point: P }[],
): { id: string; concentration: number | null; channelLabel?: string; points: P[] }[] {
  const order: string[] = [];
  const map = new Map<string, { id: string; concentration: number | null; channelLabel?: string; points: P[] }>();
  for (const e of entries) {
    let g = map.get(e.id);
    if (!g) {
      g = { id: e.id, concentration: e.concentration, channelLabel: e.channelLabel, points: [] };
      map.set(e.id, g);
      order.push(e.id);
    } else {
      if (g.concentration == null && e.concentration != null) g.concentration = e.concentration;
      if (g.channelLabel == null && e.channelLabel != null) g.channelLabel = e.channelLabel;
    }
    g.points.push(e.point);
  }
  return order.map((id) => map.get(id)!);
}

/** Optional "Channel" column (absent in pre-multichannel exports). */
function readChannel(row: string[], iCh: number): string | undefined {
  if (iCh < 0) return undefined;
  const v = (row[iCh] ?? "").trim();
  if (v === "" || v === "—" || v === "-" || v === "N/A" || v === "n/a") return undefined;
  return v;
}

function readId(row: string[], iId: number): string {
  if (iId < 0) return FALLBACK_ID;
  const v = (row[iId] ?? "").trim();
  return v === "" ? FALLBACK_ID : v;
}

function parseEISSection(section: SectionSlice): ImportedEIS {
  const { headers, rows } = section;
  const iId = findCol(headers, ["Measurement ID", "measurement_id"]);
  const iCh = findCol(headers, ["Channel", "channel"]);
  const iConc = findCol(headers, ["Concentration (nM)", "concentration_nM", "concentration"]);
  const iFreq = findCol(headers, ["Frequency (Hz)", "frequency_Hz", "frequency"]);
  const iRe = findCol(headers, ["Z Real (Ω)", "zReal"]);
  const iIm = findCol(headers, ["Z Imag (Ω)", "zImag"]);
  const iMag = findCol(headers, ["|Z| (Ω)", "zMag"]);
  const iPhase = findCol(headers, ["Phase (°)", "phase"]);
  // Raw-signal diagnostics, written since the low-signal flag was added. Files
  // from before it have none of these columns, and those points are not low signal.
  const iDftCal = findCol(headers, ["DFT Cal (counts)", "dftCal"]);
  const iDftMag = findCol(headers, ["DFT Mag (counts)", "dftMag"]);
  const iRtia = findCol(headers, ["RTIA (Ω)", "rtiaOhms"]);
  const iLow = findCol(headers, ["Low signal", "lowSignal"]);
  const iSuspect = findCol(headers, ["Suspect", "suspect"]);

  const entries: { id: string; concentration: number | null; channelLabel?: string; point: EISDataPoint }[] = [];
  let skipped = 0;
  for (const r of rows) {
    const frequency = iFreq >= 0 ? parseNum(r[iFreq]) : NaN;
    const zReal = iRe >= 0 ? parseNum(r[iRe]) : NaN;
    const zImag = iIm >= 0 ? parseNum(r[iIm]) : NaN;
    let zMag = iMag >= 0 ? parseNum(r[iMag]) : NaN;
    let phase = iPhase >= 0 ? parseNum(r[iPhase]) : NaN;
    if (!Number.isFinite(frequency) || !Number.isFinite(zReal) || !Number.isFinite(zImag)) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(zMag)) zMag = Math.hypot(zReal, zImag);
    if (!Number.isFinite(phase)) phase = (Math.atan2(zImag, zReal) * 180) / Math.PI;
    const concRaw = iConc >= 0 ? parseNum(r[iConc]) : NaN;
    const point: EISDataPoint = { frequency, zReal, zImag, zMag, phase };
    const dftCal = iDftCal >= 0 ? parseNum(r[iDftCal]) : NaN;
    const dftMag = iDftMag >= 0 ? parseNum(r[iDftMag]) : NaN;
    const rtia = iRtia >= 0 ? parseNum(r[iRtia]) : NaN;
    if (Number.isFinite(dftCal)) point.dftCal = dftCal;
    if (Number.isFinite(dftMag)) point.dftMag = dftMag;
    if (Number.isFinite(rtia)) point.rtiaOhms = rtia;
    if (iLow >= 0 && (r[iLow] ?? "").trim().toLowerCase() === "yes") point.lowSignal = true;
    if (iSuspect >= 0 && (r[iSuspect] ?? "").trim().toLowerCase() === "yes") point.suspect = true;
    entries.push({
      id: readId(r, iId),
      concentration: Number.isFinite(concRaw) ? concRaw : null,
      channelLabel: readChannel(r, iCh),
      point,
    });
  }
  return { mode: "eis", measurements: groupByMeasurement(entries), skipped };
}

function parseCVSection(section: SectionSlice): ImportedCV {
  const { headers, rows } = section;
  const iId = findCol(headers, ["measurement_id", "Measurement ID"]);
  const iCh = findCol(headers, ["channel", "Channel"]);
  const iConc = findCol(headers, ["concentration_mM", "concentration_nM", "Concentration (nM)"]);
  const iTime = findCol(headers, ["time_s", "Time (s)"]);
  const iCycle = findCol(headers, ["cycle"]);
  const iBranch = findCol(headers, ["branch"]);
  const iE = findCol(headers, ["E_V", "E (V)"]);
  const iI = findCol(headers, ["I_uA", "I_raw_uA", "I (µA)"]);
  const iBase = findCol(headers, ["baseline_uA"]);
  const iCorr = findCol(headers, ["I_corrected_uA"]);

  const entries: { id: string; concentration: number | null; channelLabel?: string; point: CVDataPoint }[] = [];
  let skipped = 0;
  for (const r of rows) {
    const t = iTime >= 0 ? parseNum(r[iTime]) : NaN;
    const cycleRaw = iCycle >= 0 ? parseNum(r[iCycle]) : NaN;
    const E = iE >= 0 ? parseNum(r[iE]) : NaN;
    const I = iI >= 0 ? parseNum(r[iI]) : NaN;
    if (!Number.isFinite(E) || !Number.isFinite(I) || !Number.isFinite(t)) {
      skipped++;
      continue;
    }
    const cycle = Number.isFinite(cycleRaw) ? cycleRaw : 1;
    const branchRaw = iBranch >= 0 ? (r[iBranch] ?? "").trim() : "";
    const branch =
      branchRaw === "forward" || branchRaw === "reverse" || branchRaw === "return"
        ? (branchRaw as CVDataPoint["branch"])
        : undefined;
    const baseline = iBase >= 0 ? parseNum(r[iBase]) : NaN;
    const Icorr = iCorr >= 0 ? parseNum(r[iCorr]) : NaN;
    const p: CVDataPoint = { E, I, t, cycle };
    if (branch) p.branch = branch;
    if (Number.isFinite(baseline)) p.baseline = baseline;
    if (Number.isFinite(Icorr)) p.Icorr = Icorr;
    const concRaw = iConc >= 0 ? parseNum(r[iConc]) : NaN;
    entries.push({
      id: readId(r, iId),
      concentration: Number.isFinite(concRaw) ? concRaw : null,
      channelLabel: readChannel(r, iCh),
      point: p,
    });
  }
  return { mode: "cv", measurements: groupByMeasurement(entries), skipped };
}

function parseSWVSection(section: SectionSlice): ImportedSWV {
  const { headers, rows } = section;
  const iId = findCol(headers, ["measurement_id", "Measurement ID"]);
  const iCh = findCol(headers, ["channel", "Channel"]);
  const iConc = findCol(headers, ["concentration_nM", "concentration_mM", "Concentration (nM)"]);
  const iIdx = findCol(headers, ["index", "point_index"]);
  const iTime = findCol(headers, ["time_s"]);
  const iE = findCol(headers, ["E_V"]);
  const iFwd = findCol(headers, ["I_forward_uA"]);
  const iRev = findCol(headers, ["I_reverse_uA"]);
  const iNet = findCol(headers, ["I_net_raw_uA", "I_net_uA"]);
  const iDir = findCol(headers, ["direction"]);

  const entries: { id: string; concentration: number | null; channelLabel?: string; point: SWVDataPoint }[] = [];
  let skipped = 0;
  const runByGroup = new Map<string, number>();
  for (const r of rows) {
    const E = iE >= 0 ? parseNum(r[iE]) : NaN;
    const IForward = iFwd >= 0 ? parseNum(r[iFwd]) : NaN;
    const IReverse = iRev >= 0 ? parseNum(r[iRev]) : NaN;
    let INet = iNet >= 0 ? parseNum(r[iNet]) : NaN;
    if (!Number.isFinite(E) || !Number.isFinite(IForward) || !Number.isFinite(IReverse)) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(INet)) INet = IForward - IReverse;
    const id = readId(r, iId);
    const running = runByGroup.get(id) ?? 0;
    const time = iTime >= 0 ? parseNum(r[iTime]) : NaN;
    const idxRaw = iIdx >= 0 ? parseNum(r[iIdx]) : NaN;
    const dirRaw = iDir >= 0 ? (r[iDir] ?? "").trim() : "";
    const direction: SWVDirection = dirRaw === "cathodic" ? "cathodic" : "anodic";
    const concRaw = iConc >= 0 ? parseNum(r[iConc]) : NaN;
    entries.push({
      id,
      concentration: Number.isFinite(concRaw) ? concRaw : null,
      channelLabel: readChannel(r, iCh),
      point: {
        E,
        IForward,
        IReverse,
        INet,
        time: Number.isFinite(time) ? time : running,
        index: Number.isFinite(idxRaw) ? idxRaw : running,
        direction,
      },
    });
    runByGroup.set(id, running + 1);
  }
  return { mode: "swv", measurements: groupByMeasurement(entries), skipped };
}

function parseFETTransferSection(section: SectionSlice): ImportedFETTransfer {
  const { headers, rows } = section;
  const iId = findCol(headers, ["Measurement ID", "measurement_id"]);
  const iCh = findCol(headers, ["Channel", "channel"]);
  const iConc = findCol(headers, ["Concentration (nM)", "concentration_nM", "concentration"]);
  const iCurve = findCol(headers, ["Curve", "curve"]);
  const iVg = findCol(headers, ["Vg (V)", "Vg_V", "vg"]);
  const iId2 = findCol(headers, ["Id (µA)", "Id_uA", "id"]);

  interface Group {
    id: string;
    concentration: number | null;
    channelLabel?: string;
    baseline: FETTransferPoint[];
    analyte: FETTransferPoint[];
  }
  const order: string[] = [];
  const map = new Map<string, Group>();
  let skipped = 0;
  for (const r of rows) {
    const vg = iVg >= 0 ? parseNum(r[iVg]) : NaN;
    const id = iId2 >= 0 ? parseNum(r[iId2]) : NaN;
    if (!Number.isFinite(vg) || !Number.isFinite(id)) { skipped++; continue; }
    const key = readId(r, iId);
    let g = map.get(key);
    if (!g) {
      const concRaw = iConc >= 0 ? parseNum(r[iConc]) : NaN;
      g = { id: key, concentration: Number.isFinite(concRaw) ? concRaw : null, channelLabel: readChannel(r, iCh), baseline: [], analyte: [] };
      map.set(key, g);
      order.push(key);
    } else if (g.concentration == null && iConc >= 0) {
      const c = parseNum(r[iConc]);
      if (Number.isFinite(c)) g.concentration = c;
    }
    const curve = iCurve >= 0 ? (r[iCurve] ?? "").trim().toLowerCase() : "";
    const point: FETTransferPoint = { vg, id };
    if (curve === "analyte") g.analyte.push(point);
    else g.baseline.push(point);
  }
  return { mode: "fet_transfer", measurements: order.map((k) => map.get(k)!), skipped };
}

function parseFETTimeSection(section: SectionSlice): ImportedFETTime {
  const { headers, rows } = section;
  const iId = findCol(headers, ["Measurement ID", "measurement_id"]);
  const iCh = findCol(headers, ["Channel", "channel"]);
  const iConc = findCol(headers, ["Concentration (nM)", "concentration_nM", "concentration"]);
  const iTime = findCol(headers, ["Time (s)", "time_s", "time"]);
  const iId2 = findCol(headers, ["Id (µA)", "Id_uA", "id"]);
  const iMarker = findCol(headers, ["Marker", "marker"]);

  interface Group {
    id: string;
    concentration: number | null;
    channelLabel?: string;
    points: FETTimePoint[];
    markers: { time: number; label: string }[];
  }
  const order: string[] = [];
  const map = new Map<string, Group>();
  let skipped = 0;
  for (const r of rows) {
    const time = iTime >= 0 ? parseNum(r[iTime]) : NaN;
    const idRaw = iId2 >= 0 ? (r[iId2] ?? "").trim() : "";
    const id = parseNum(idRaw);
    const markerCell = iMarker >= 0 ? (r[iMarker] ?? "").trim() : "";
    const isMarker = !Number.isFinite(id) && markerCell !== "" && markerCell !== "N/A";
    if (!Number.isFinite(time)) { skipped++; continue; }
    if (!isMarker && !Number.isFinite(id)) { skipped++; continue; }
    const key = readId(r, iId);
    let g = map.get(key);
    if (!g) {
      const concRaw = iConc >= 0 ? parseNum(r[iConc]) : NaN;
      g = { id: key, concentration: Number.isFinite(concRaw) ? concRaw : null, channelLabel: readChannel(r, iCh), points: [], markers: [] };
      map.set(key, g);
      order.push(key);
    } else if (g.concentration == null && iConc >= 0) {
      const c = parseNum(r[iConc]);
      if (Number.isFinite(c)) g.concentration = c;
    }
    if (isMarker) g.markers.push({ time, label: markerCell });
    else g.points.push({ time, id });
  }
  return { mode: "fet_time", measurements: order.map((k) => map.get(k)!), skipped };
}

export function parseImportedCsv(
  text: string,
  expectedMode: "eis" | "cv" | "swv" | "fet_transfer" | "fet_time",
): ImportResult {
  if (!text || typeof text !== "string") {
    return { error: "Ficheiro vazio ou inválido." };
  }
  const clean = stripBOM(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = clean.split("\n");
  const delim = detectDelimiter(lines);

  const marker =
    expectedMode === "eis" ? SECTION_EIS :
    expectedMode === "cv" ? SECTION_CV :
    expectedMode === "swv" ? SECTION_SWV :
    expectedMode === "fet_transfer" ? SECTION_FET_TRANSFER : SECTION_FET_TIME;

  const hasSection = lines.some((l) => l.trimStart().startsWith(marker));
  if (!hasSection) {
    const hasEis = lines.some((l) => l.trimStart().startsWith(SECTION_EIS));
    const hasCv = lines.some((l) => l.trimStart().startsWith(SECTION_CV));
    const hasSwv = lines.some((l) => l.trimStart().startsWith(SECTION_SWV));
    const hasFetT = lines.some((l) => l.trimStart().startsWith(SECTION_FET_TRANSFER));
    const hasFetTime = lines.some((l) => l.trimStart().startsWith(SECTION_FET_TIME));
    const present = [
      hasEis && "EIS",
      hasCv && "CV",
      hasSwv && "SWV",
      hasFetT && "FET Transfer",
      hasFetTime && "FET Time",
    ].filter(Boolean).join(", ");
    return {
      error: present
        ? `Este ficheiro não contém dados ${expectedMode.toUpperCase()}. Secções encontradas: ${present}. Usa o botão Import CSV do modo correspondente (${present}).`
        : "Ficheiro não reconhecido como export ElectroStat.",
    };
  }

  const s = extractSection(lines, delim, marker);
  if (!s) return { error: "Secção RAW encontrada mas sem cabeçalho legível." };

  const result: ImportedEIS | ImportedCV | ImportedSWV | ImportedFETTransfer | ImportedFETTime =
    expectedMode === "eis" ? parseEISSection(s) :
    expectedMode === "cv" ? parseCVSection(s) :
    expectedMode === "swv" ? parseSWVSection(s) :
    expectedMode === "fet_transfer" ? parseFETTransferSection(s) : parseFETTimeSection(s);

  const instrument = readInstrumentSettings(lines, delim);
  if (instrument.size > 0) {
    // A single export whose RAW rows have no measurement id (SWV) is read as one measurement under a
    // fallback id; its settings are the only block of the file.
    const only = instrument.size === 1 ? [...instrument.values()][0] : undefined;
    for (const m of result.measurements as { id: string; instrument?: InstrumentSettings }[]) {
      const found = instrument.get(m.id) ?? (m.id === FALLBACK_ID ? only : undefined);
      if (found) m.instrument = found;
    }
  }

  const totalPoints =
    result.mode === "fet_transfer"
      ? result.measurements.reduce((n, m) => n + m.baseline.length + m.analyte.length, 0)
      : result.mode === "fet_time"
        ? result.measurements.reduce((n, m) => n + m.points.length + m.markers.length, 0)
        : result.measurements.reduce((n, m) => n + m.points.length, 0);
  if (totalPoints === 0) {
    return {
      error: `Nenhuma linha de dados válida encontrada na secção ${expectedMode.toUpperCase()}.`,
    };
  }
  return result;
}

