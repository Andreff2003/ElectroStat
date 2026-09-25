/**
 * Square Wave Voltammetry (SWV) data model.
 *
 * SCIENTIFIC HONESTY
 * ------------------
 * SWV is a differential pulse technique: a square wave is superimposed on a
 * staircase potential ramp. On every staircase step two currents are sampled:
 *  - IForward at the end of the forward pulse
 *  - IReverse at the end of the reverse pulse
 * The analytical signal is the differential current:
 *
 *     I_net = I_forward - I_reverse
 *
 * Do NOT reuse CV assumptions (ΔEp reversibility, Randles-Ševčík Ip ∝ v^{1/2})
 * here — those belong to a scanning experiment, not a pulsed differential one.
 *
 * Units used throughout the app:
 *  - Potential E, staircase, pulses : V (staircase step / amplitude given in mV in the UI)
 *  - Current                        : µA
 *  - Frequency                      : Hz
 *  - Concentration (biosensor)      : nM
 *  - Time                           : s
 */

export type SWVDirection = "anodic" | "cathodic";

export type SWVBaselineMethod =
  | "none"
  | "linear_edges"
  | "quadratic"
  | "auto";

export type SWVSmoothingMethod =
  | "none"
  | "savitzky_golay"
  | "moving_average";

export type SWVSimulationModel =
  | "empirical_peak"
  /** Legacy alias — matches the string exported by SWV_SIMULATION_MODEL_ID. */
  | "empirical_swv_peak_langmuir"
  | "reversible_surface"
  | "reversible_diffusion_approx"
  | "quasi_reversible_approx";

/** Physical solver choice used by useSimulatedSWVData. */
export type SWVModel = "reversible" | "quasi-reversible" | "empirical";


export interface SWVDataPoint {
  /** V vs reference. */
  E: number;
  /** Forward-pulse current, µA. */
  IForward: number;
  /** Reverse-pulse current, µA. */
  IReverse: number;
  /** Differential SWV current, µA. Always IForward - IReverse. */
  INet: number;
  /** Elapsed time from start of sweep, s. */
  time: number;
  /** Staircase step index (0-based). */
  index: number;
  /** Sweep direction. */
  direction: SWVDirection;
  /** Optional cycle index (SWV is normally single-sweep, kept for symmetry). */
  cycle?: number;
  /** Baseline current at this E (µA), populated after baseline correction. */
  baseline?: number;
  /** Baseline-corrected differential current (µA). */
  ICorrected?: number;
  /** Live hardware only: HSTIA output fell outside the AD5941's usable ADC window for this point (forward or reverse pulse). */
  outOfRange?: boolean;
}

export interface SWVParameters {
  /** V */
  startE: number;
  /** V */
  endE: number;
  /** Staircase step, mV. */
  step_mV: number;
  /** Square-wave amplitude Esw, mV. */
  amplitude_mV: number;
  /** Square-wave frequency, Hz. */
  frequency_Hz: number;
  /** Pre-sweep quiet time, s. */
  quietTime_s: number;
  direction: SWVDirection;
  /** Biosensor analyte concentration in nM (kept for calibration UI). */
  concentration_nM?: number;
  /** Bulk concentration of O in mM — used by the physical solvers. */
  cMM?: number;
  /** Electrode area, cm². */
  area_cm2?: number;
  /** Number of electrons transferred (redox). */
  nElectrons?: number;
  /** Temperature, K. */
  temperature_K?: number;
  /** Diffusion coefficient (cm²/s) — defaults to CV_DEFAULT_D_CM2_S. */
  D_cm2_s?: number;
  /** Formal potential E0' (V) — defaults to CV_E0_PRIME_DEFAULT_V. */
  E0Prime_V?: number;
  /** Heterogeneous rate constant (cm/s) — quasi-reversible only. Defaults to CV_BV_K0. */
  k0?: number;
  /** Charge-transfer coefficient (0–1) — quasi-reversible only. Defaults to CV_BV_ALPHA. */
  alpha?: number;
  /** Analyte-specific diffusion (cm²/s) — alias of D_cm2_s used by the SWV UI. */
  diffusionCoeff?: number;
  /** Formal potential alias used by the SWV UI (V). */
  formalPotential?: number;
  baselineMethod?: SWVBaselineMethod;
  smoothing?: SWVSmoothingMethod;
  model?: SWVSimulationModel;
  /** Physical simulation model. Default: "reversible". */
  swvModel?: SWVModel;
  /** HSTIA feedback resistor, ohms — one of the AD5941's discrete gain steps (200 to 160k). Defaults to 10000 (HSTIARTIA_10K) on the firmware if omitted. */
  rtiaOhms?: number;
}


export interface SWVMetrics {
  peakCurrentRaw_uA: number | null;
  peakCurrentCorrected_uA: number | null;
  peakPotential_V: number | null;
  halfPeakWidth_mV: number | null;
  baselineMethod: SWVBaselineMethod;
  baselineMethodUsed?: SWVBaselineMethod;
  baselineSlope_uA_V?: number | null;
  baselineIntercept_uA?: number | null;
  snr?: number | null;
  noiseRms_uA?: number | null;
  /** Optional area under the corrected peak, µA·V. Informational only. */
  peakArea_uA_V?: number | null;
  /** Rough LOD estimate in nM from a simple noise-based rule; requires calibration to be meaningful. */
  lodEstimate_nM?: number | null;
  peakDetected: boolean;
  peakPolarity: "anodic" | "cathodic" | "unknown";
  warnings: string[];
}

export interface SWVCalibrationPoint {
  concentration_nM: number;
  /** Analytical signal, µA (peak current — corrected if available). */
  signal_uA: number;
  /** Raw peak current, µA (before baseline correction). */
  raw_uA: number;
  peakPotential_V: number | null;
  baselineMethod: SWVBaselineMethod;
  snr: number | null;
  timestamp: number;
  measurementId?: string;
  sampleId?: string;
  electrodeId?: string;
  notesShort?: string;
}
