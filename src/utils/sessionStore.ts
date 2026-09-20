import type { EISDataPoint, FETTransferPoint, FETTimePoint } from "@/hooks/useSimulatedData";
import type { CVDataPoint } from "@/hooks/useSimulatedCVData";
import type { CVMetrics } from "@/utils/computeCVMetrics";
import type { MeasurementNotes } from "./measurementNotes";

export interface StoredEISMeasurement {
  id: string;
  mode: "eis";
  timestamp: number;
  /** Multi-Channel traceability: 1 | 2 | 3 when captured via Multi-Channel. */
  channelId?: number;
  /** Multi-Channel traceability: user-editable channel name, e.g. "Sensor 2". */
  channelLabel?: string;

  concentration: number;
  /** Optional human-readable measurement id (eis_YYYYMMDD_HHMMSS_<rand>). */
  measurementId?: string;
  /** Optional unix ms when the sweep started. */
  measurementTimestamp?: number;
  /** Optional logbook metadata. Older entries may store a plain string. */
  notes?: MeasurementNotes | string;
  params: {
    freqMin: number;
    freqMax: number;
    points: number;
    amplitude: number;
    pointDensityMode?: "total" | "perDecade";
    pointsPerDecade?: number;
    dcBias?: number;
  };
  data: EISDataPoint[];
  extracted: {
    Rs?: number;
    Rct?: number;
    Cdl?: number;
    /** CPE pre-factor when fit_model = "randles-cpe". */
    Q?: number;
    /** CPE exponent when fit_model = "randles-cpe". */
    n?: number;
    Aw?: number;
    warburgSlope?: number;
    warburgR2?: number;
    warburgIntercept?: number;
    warburgMethod?:
      | "regression_1_sqrt_omega_with_intercept"
      | "regression_1_sqrt_omega"
      | "endpoint";
    fitErrorPct?: number;
    f0?: number;
    warburgAw?: number;
    kkResidualPct?: number;
    kkPassed?: boolean;
    kkMethod?: "approximate_residual" | "lin_kk_inspired" | "lin_kk" | "none";
    fitConverged?: boolean;
    geometricFallback?: boolean;
    deltaRct?: number;
    deltaRctNormPct?: number;
    warnFlags?: string[];
    fitModel?: "randles" | "randles-cpe";
    fitSource?:
      | "geometric"
      | "geometric_fallback"
      | "auto_cnls_randles"
      | "manual_randles"
      | "cnls_randles"
      | "cnls_randles_cpe"
      | "manual_cnls_randles"
      | "manual_cnls_randles_cpe";
    weightedSsrPerDof?: number;
    rmseWeightedPercent?: number;
    fitRangeMinHz?: number;
    fitRangeMaxHz?: number;
    covarianceWarning?: boolean;
    covarianceMethod?: "log_space" | "natural_space";
    extrapolationPresent?: boolean;
    linKKPassed?: boolean;
    linKKRmsResidualPct?: number;
    linKKMaxResidualPct?: number;
    linKKTauCount?: number;
    linKKNegativeRkCount?: number;
    linKKNegativeRkPct?: number;
    approxKkInformationalOnly?: boolean;
  };
}


export interface StoredFETMeasurement {
  id: string;
  mode: "fet";
  timestamp: number;
  /** Multi-Channel traceability: 1 | 2 | 3 when captured via Multi-Channel. */
  channelId?: number;
  /** Multi-Channel traceability: user-editable channel name, e.g. "Sensor 2". */
  channelLabel?: string;

  concentration: number;
  measurementId?: string;
  measurementTimestamp?: number;
  notes?: MeasurementNotes | string;
  params: {
    vgMin: number;
    vgMax: number;
    vgStep: number;
    intervalMs: number;
  };
  baseline: FETTransferPoint[];
  analyte: FETTransferPoint[];
  timeData: FETTimePoint[];
  markers: { time: number; label: string }[];
  extracted: {
    Vt?: number;
    vtBaseline?: number;
    vtAnalyte?: number;
    deltaVt_mV?: number;
    deltaVt_mV_signed?: number;
    calibrationSignal_mV_used?: number;
    vtMethod?: "sqrt_extrapolation" | "constant_current_fallback" | "invalid";
    vtFitR2?: number;
    vtRegionPoints?: number;
    vtIoffUsed?: number;
    vtWarning?: string;
    vtBaselineMethod?: "sqrt_extrapolation" | "constant_current_fallback" | "invalid";
    vtBaselineFitR2?: number;
    vtBaselineRegionPoints?: number;
    vtBaselineIoffUsed?: number;
    vtBaselineWarning?: string;
    vtAnalyteMethod?: "sqrt_extrapolation" | "constant_current_fallback" | "invalid";
    vtAnalyteFitR2?: number;
    vtAnalyteRegionPoints?: number;
    vtAnalyteIoffUsed?: number;
    vtAnalyteWarning?: string;
    ion_uA?: number | null;
    ioff_uA?: number | null;
    ionIoffRatio?: number | null;
    subthresholdSlope_mV_dec?: number | null;
    baselineStabilityNoisePct?: number | null;
    responseMode?: "auto" | "signed" | "absolute";
    responseSign?: 1 | -1;
  };
}

export interface StoredCVMeasurement {
  id: string;
  mode: "cv";
  timestamp: number;
  /** Multi-Channel traceability: 1 | 2 | 3 when captured via Multi-Channel. */
  channelId?: number;
  /** Multi-Channel traceability: user-editable channel name, e.g. "Sensor 2". */
  channelLabel?: string;

  concentration?: number;
  measurementId: string;
  measurementTimestamp: number;
  notes?: MeasurementNotes;
  params: {
    scanRate: number;
    eStart: number;
    eVertex1: number;
    eVertex2: number;
    nCycles: number;
    n: number;
    cMM: number;
    areaCm2: number;
    cvModel: string;
    diffusionCoeff?: number;
    formalPotential?: number;
    k0?: number;
    alpha?: number;
    stepPotential?: number;
    quietTime?: number;
  };
  data: CVDataPoint[];
  metrics?: CVMetrics | null;
}

export interface StoredSWVMeasurement {
  id: string;
  mode: "swv";
  timestamp: number;
  /** Multi-Channel traceability: 1 | 2 | 3 when captured via Multi-Channel. */
  channelId?: number;
  /** Multi-Channel traceability: user-editable channel name, e.g. "Sensor 2". */
  channelLabel?: string;

  source: "simulated" | "live" | "imported" | "unknown";
  concentration?: number;
  measurementId?: string;
  measurementTimestamp?: number;
  notes?: MeasurementNotes | string;
  params: import("@/types/swv").SWVParameters;
  data: import("@/types/swv").SWVDataPoint[];
  correctedData?: import("@/types/swv").SWVDataPoint[];
  extracted: import("@/types/swv").SWVMetrics;
}

export type StoredMeasurement =
  | StoredEISMeasurement
  | StoredFETMeasurement
  | StoredCVMeasurement
  | StoredSWVMeasurement;

const KEY = "electrostat-session-v1";
// The app used to be called HelpStat; read sessions saved under the old key so
// upgrading does not drop the user's stored measurements.
const LEGACY_KEY = "helpstat-session-v1";

export function loadSession(): StoredMeasurement[] {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("Failed to load session", err);
    return [];
  }
}

export type SessionSaveStatus = "saved" | "error";

export function saveSession(
  measurements: StoredMeasurement[],
  onStatus?: (status: SessionSaveStatus, error?: unknown) => void,
) {
  try {
    localStorage.setItem(KEY, JSON.stringify(measurements));
    onStatus?.("saved");
  } catch (err) {
    // QuotaExceededError lands here — surface it so the UI can warn the
    // user instead of silently losing their measurement history.
    console.warn("Failed to save session", err);
    onStatus?.("error", err);
  }
}

// Debounced writer: the session array (with full raw point arrays) is
// expensive to stringify, so callers that fire on every state change should
// go through this instead of saveSession directly.
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveSessionDebounced(
  measurements: StoredMeasurement[],
  onStatus?: (status: SessionSaveStatus, error?: unknown) => void,
  delayMs = 600,
) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSession(measurements, onStatus);
  }, delayMs);
}

/** Test hook — flush any pending debounced write synchronously. */
export function flushSessionSave(
  measurements: StoredMeasurement[],
  onStatus?: (status: SessionSaveStatus, error?: unknown) => void,
) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveSession(measurements, onStatus);
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch (err) {
    console.warn("Failed to clear session", err);
  }
}

export function newId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
