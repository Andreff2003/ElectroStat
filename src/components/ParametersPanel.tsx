import { useState } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InfoHint } from "@/components/InfoHint";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { SWVParameters } from "@/types/swv";
import {
  CV_DEFAULT_D_CM2_S,
  CV_E0_PRIME_DEFAULT_V,
  CV_BV_K0,
  CV_BV_ALPHA,
} from "@/utils/cvConstants";


/**
 * Measurement parameters for both EIS and BioFET modes.
 * These values are sent with the start command to the ESP32.
 */
export interface EISParams {
  freqMin: number;
  freqMax: number;
  points: number;
  amplitude: number; // mV
  pointDensityMode: "total" | "perDecade";
  pointsPerDecade: number;
  dcBias: number; // Volts
}

export interface FETParams {
  vgMin: number; // V
  vgMax: number; // V
  vgStep: number; // mV (converted to V before sending)
  intervalMs: number;
  /** HSTIA feedback resistor, ohms — one of the AD5941's discrete gain steps. */
  rtiaOhms: number;
  // Analyte / device parameters (simulation)
  kd_nM: number;
  vtBaseline_V: number;
  deltaVtMax_V: number;
  idMax_uA: number;
  idealityFactor: number;
  // Time response settings
  bindingRate_perS: number;
  readoutBias_V: number;
  timeDuration_s: number;
  timeStep_s: number;
  injectionTime_s: number;
}

export const DEFAULT_EIS_PARAMS: EISParams = {
  freqMin: 0.1,
  freqMax: 100000,
  points: 60,
  amplitude: 10,
  pointDensityMode: "perDecade",
  pointsPerDecade: 7,
  dcBias: 0,
};

/**
 * Compute the total number of EIS points from the current parameters,
 * honouring the point-density mode. Result is clamped to [10, 200] to
 * match the "Number of Points" bounds.
 */
export function computeEISPointCount(p: EISParams): number {
  if (p.pointDensityMode === "perDecade") {
    const decades = Math.max(0, Math.log10(p.freqMax / p.freqMin));
    const raw = Math.round(p.pointsPerDecade * decades) + 1;
    return Math.min(200, Math.max(10, raw));
  }
  return Math.min(200, Math.max(10, Math.round(p.points)));
}

export const DEFAULT_FET_PARAMS: FETParams = {
  vgMin: -0.5,
  vgMax: 1.5,
  vgStep: 40,
  intervalMs: 200,
  rtiaOhms: 10000,
  kd_nM: 25,
  vtBaseline_V: 0.30,
  deltaVtMax_V: 0.40,
  idMax_uA: 50,
  idealityFactor: 2.0,
  bindingRate_perS: 0.5,
  readoutBias_V: 1.0,
  timeDuration_s: 60,
  timeStep_s: 0.5,
  injectionTime_s: 10,
};

export interface CVParams {
  scanRate: number;   // mV/s
  eStart: number;     // V
  eVertex1: number;   // V
  eVertex2: number;   // V
  nCycles: number;
  n: number;          // electrons
  cMM: number;        // mM
  areaCm2: number;    // cm²
  cvModel: "reversible" | "quasi-reversible";
  // Analyte-specific electrochemistry
  diffusionCoeff: number;   // cm²/s
  formalPotential: number;  // V
  k0: number;               // cm/s — heterogeneous rate constant (quasi-reversible only)
  alpha: number;            // charge-transfer coefficient (quasi-reversible only)
  // Acquisition
  stepPotential: number;    // mV per staircase step
  quietTime: number;        // s — equilibration at E_start
  /** HSTIA feedback resistor, ohms — one of the AD5941's discrete gain steps. */
  rtiaOhms: number;
}

export const DEFAULT_CV_PARAMS: CVParams = {
  scanRate: 100,
  eStart: 0.6,
  eVertex1: -0.2,
  eVertex2: 0.6,
  nCycles: 1,
  n: 1,
  cMM: 5,
  areaCm2: 0.0707,
  cvModel: "reversible",
  diffusionCoeff: CV_DEFAULT_D_CM2_S,
  formalPotential: CV_E0_PRIME_DEFAULT_V,
  k0: CV_BV_K0,
  alpha: CV_BV_ALPHA,
  stepPotential: 2,
  quietTime: 2,
  rtiaOhms: 10000,
};

/**
 * The AD5941's 8 discrete HSTIA feedback-resistor gain steps. Used by the
 * CV/BioFET/SWV parameter panels — EIS uses the AD5941's own DFT-based
 * impedance path (with its own pre-existing gain table) and isn't affected.
 */
export const AD5941_RTIA_OPTIONS: { label: string; value: number }[] = [
  { label: "200 Ω", value: 200 },
  { label: "1 kΩ", value: 1000 },
  { label: "5 kΩ", value: 5000 },
  { label: "10 kΩ (default)", value: 10000 },
  { label: "20 kΩ", value: 20000 },
  { label: "40 kΩ", value: 40000 },
  { label: "80 kΩ", value: 80000 },
  { label: "160 kΩ", value: 160000 },
];

/** Redox-probe presets — apply only D and E°', leave everything else untouched. */
export const CV_REDOX_PRESETS: Record<
  string,
  { label: string; D: number; E0: number } | null
> = {
  custom: null,
  ferricyanide: { label: "[Fe(CN)6]³⁻/⁴⁻", D: 7.26e-6, E0: 0.22 },
  ruthenium: { label: "[Ru(NH3)6]³⁺/²⁺", D: 5.3e-6, E0: -0.18 },
  ferrocenemethanol: { label: "Ferrocenemethanol", D: 7.8e-6, E0: 0.2 },
};

interface ParametersPanelProps {
  mode: "eis" | "fet" | "cv" | "swv";
  eisParams: EISParams;
  fetParams: FETParams;
  cvParams?: CVParams;
  swvParams?: SWVParameters;
  onChangeEIS: (params: EISParams) => void;
  onChangeFET: (params: FETParams) => void;
  onChangeCV?: (params: CVParams) => void;
  onChangeSWV?: (params: SWVParameters) => void;
  disabled?: boolean;
}


interface NumFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  /** Short, always-visible note — only what's needed to pick a value (a default or recommended range). */
  hint?: string;
  /** Longer explanation, shown on hover via the (i) icon next to the label. */
  info?: string;
}

const NumField = ({ label, value, min, max, step, onChange, disabled, hint, info }: NumFieldProps) => (
  <div className="flex flex-col gap-1">
    <Label className="text-[10px] font-mono uppercase text-muted-foreground">
      {label}
      {info && <InfoHint text={info} />}
    </Label>
    <Input
      type="number"
      value={Number.isFinite(value) ? value : ""}
      min={min}
      max={max}
      step={step ?? "any"}
      disabled={disabled}
      onChange={(e) => {
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) {
          onChange(Math.min(max, Math.max(min, n)));
        }
      }}
      className="h-8 font-mono text-xs"
    />
    {hint && <span className="text-[10px] text-muted-foreground font-mono">{hint}</span>}
  </div>
);

const ParametersPanel = ({
  mode,
  eisParams,
  fetParams,
  cvParams,
  swvParams,
  onChangeEIS,
  onChangeFET,
  onChangeCV,
  onChangeSWV,
  disabled,
}: ParametersPanelProps) => {
  const [open, setOpen] = useState(false);
  const modeLabel =
    mode === "eis" ? "EIS" : mode === "fet" ? "BioFET" : mode === "cv" ? "CV" : "SWV";


  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-card">
      <CollapsibleTrigger className="flex w-full items-center justify-between p-3 text-left">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-primary" />
          <span className="font-mono text-sm text-foreground">Measurement Parameters</span>
          <span className="font-mono text-[10px] text-muted-foreground uppercase">
            {modeLabel}
          </span>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="border-t border-border px-3 pb-3 pt-3">
        {mode === "eis" && (() => {
          const decades = Math.max(0, Math.log10(eisParams.freqMax / eisParams.freqMin));
          const rawTotal = Math.round(eisParams.pointsPerDecade * decades) + 1;
          const computedTotal = Math.min(200, Math.max(10, rawTotal));
          const clamped = computedTotal !== rawTotal;
          const dcBiasWarn = Math.abs(eisParams.dcBias) > 0.3;
          return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="flex flex-col gap-1 col-span-2">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">
                Point Density
              </Label>
              <select
                disabled={disabled}
                value={eisParams.pointDensityMode}
                onChange={(e) =>
                  onChangeEIS({
                    ...eisParams,
                    pointDensityMode: e.target.value as EISParams["pointDensityMode"],
                  })
                }
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              >
                <option value="perDecade">Per decade (log-spaced)</option>
                <option value="total">Fixed total</option>
              </select>
            </div>
            <NumField
              label="Frequency Min (Hz)"
              value={eisParams.freqMin}
              min={0.01}
              max={100000}
              onChange={(v) => onChangeEIS({ ...eisParams, freqMin: v })}
              disabled={disabled}
              hint="0.1–1 Hz recommended"
              info="Lower frequencies are needed to capture the Warburg diffusion tail in the Nyquist plot."
            />
            <NumField
              label="Frequency Max (Hz)"
              value={eisParams.freqMax}
              min={100}
              max={1000000}
              onChange={(v) => onChangeEIS({ ...eisParams, freqMax: v })}
              disabled={disabled}
            />
            {eisParams.pointDensityMode === "perDecade" ? (
              <div className="flex flex-col gap-1">
                <NumField
                  label="Points per Decade"
                  value={eisParams.pointsPerDecade}
                  min={3}
                  max={20}
                  step={1}
                  onChange={(v) =>
                    onChangeEIS({ ...eisParams, pointsPerDecade: Math.round(v) })
                  }
                  disabled={disabled}
                  hint="7–10 recommended"
                  info="Higher values give a better-resolved semicircle fit."
                />
                <span className="text-[10px] text-muted-foreground font-mono">
                  ≈ {computedTotal} points over {decades.toFixed(1)} decades
                  {clamped && " (clamped to 10–200)"}
                </span>
              </div>
            ) : (
              <NumField
                label="Number of Points"
                value={eisParams.points}
                min={10}
                max={200}
                step={1}
                onChange={(v) => onChangeEIS({ ...eisParams, points: Math.round(v) })}
                disabled={disabled}
                hint="10 – 200"
              />
            )}
            <NumField
              label="Excitation Amp (mV)"
              value={eisParams.amplitude}
              min={1}
              max={200}
              onChange={(v) => onChangeEIS({ ...eisParams, amplitude: v })}
              disabled={disabled}
              hint="≤ ~800 mV on this hardware"
              info="Peak-to-peak AC excitation amplitude. The firmware clamps the sine generator to roughly 0-800 mV; the app warns if this is exceeded."
            />
            <div className="flex flex-col gap-1 col-span-2">
              <NumField
                label="DC Bias (V)"
                value={eisParams.dcBias}
                min={-1}
                max={1}
                step={0.01}
                onChange={(v) => onChangeEIS({ ...eisParams, dcBias: v })}
                disabled={disabled}
                hint="0 V recommended (open-circuit)"
                info="The AC excitation signal is superimposed on this DC offset. Keep at 0 V unless deliberately polarising the electrode away from its natural equilibrium potential."
              />
              {dcBiasWarn && (
                <span className="text-[10px] font-mono text-amber-500">
                  ⚠ Large DC bias may polarise the electrode away from OCP
                </span>
              )}
            </div>
          </div>
          );
        })()}
        {mode === "fet" && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <NumField
              label="Vg Min (V)"
              value={fetParams.vgMin}
              min={-2}
              max={0}
              onChange={(v) => onChangeFET({ ...fetParams, vgMin: v })}
              disabled={disabled}
              hint="≤ ±1.1 V on this hardware"
              info="The LPDAC bias path on real hardware supports roughly ±1.1 V around the Vzero reference; a sweep asking for more will clip at the extremes."
            />
            <NumField
              label="Vg Max (V)"
              value={fetParams.vgMax}
              min={0}
              max={3}
              onChange={(v) => onChangeFET({ ...fetParams, vgMax: v })}
              disabled={disabled}
              hint="≤ ±1.1 V on this hardware"
              info="The LPDAC bias path on real hardware supports roughly ±1.1 V around the Vzero reference; a sweep asking for more will clip at the extremes."
            />
            <NumField
              label="Vg Step (mV)"
              value={fetParams.vgStep}
              min={1}
              max={200}
              onChange={(v) => onChangeFET({ ...fetParams, vgStep: v })}
              disabled={disabled}
            />
            <NumField
              label="Sampling Interval (ms)"
              value={fetParams.intervalMs}
              min={50}
              max={2000}
              step={1}
              onChange={(v) => onChangeFET({ ...fetParams, intervalMs: Math.round(v) })}
              disabled={disabled}
              info="Playback tick for the simulator; also sent as ESP32 sample interval."
            />
            <div className="flex flex-col gap-1 col-span-2">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">
                RTIA Gain
                <InfoHint text="HSTIA feedback resistor on real hardware. Too low underuses the ADC range for small currents, too high saturates it for large ones; the app flags out-of-range readings per point." />
              </Label>
              <select
                disabled={disabled}
                value={fetParams.rtiaOhms}
                onChange={(e) => onChangeFET({ ...fetParams, rtiaOhms: Number(e.target.value) })}
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              >
                {AD5941_RTIA_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <span className="text-[10px] text-muted-foreground font-mono">10 kΩ default.</span>
            </div>

            {/* ── Analyte / device parameters ─────────────────────── */}
            <div className="col-span-2 md:col-span-4 border-t border-border pt-3 mt-1 text-[10px] font-mono uppercase text-muted-foreground">
              Analyte & Device
            </div>
            <NumField
              label="Kd (nM)"
              value={fetParams.kd_nM}
              min={0.1} max={10000} step={0.1}
              onChange={(v) => onChangeFET({ ...fetParams, kd_nM: v })}
              disabled={disabled}
              info="Aptamer/MIP dissociation constant for your specific analyte."
            />
            <NumField
              label="Vt Baseline (V)"
              value={fetParams.vtBaseline_V}
              min={-1} max={2} step={0.01}
              onChange={(v) => onChangeFET({ ...fetParams, vtBaseline_V: v })}
              disabled={disabled}
            />
            <NumField
              label="ΔVt Max (V)"
              value={fetParams.deltaVtMax_V}
              min={0} max={1} step={0.01}
              onChange={(v) => onChangeFET({ ...fetParams, deltaVtMax_V: v })}
              disabled={disabled}
              info="Maximum threshold shift at saturating analyte concentration."
            />
            <NumField
              label="Id Max (µA)"
              value={fetParams.idMax_uA}
              min={1} max={1000} step={1}
              onChange={(v) => onChangeFET({ ...fetParams, idMax_uA: v })}
              disabled={disabled}
            />
            <NumField
              label="Ideality Factor (n)"
              value={fetParams.idealityFactor}
              min={1} max={4} step={0.1}
              onChange={(v) => onChangeFET({ ...fetParams, idealityFactor: v })}
              disabled={disabled}
              hint="1 = ideal MOSFET"
              info="Subthreshold slope factor; higher means a more sluggish subthreshold turn-on."
            />

            {/* ── Time response settings ──────────────────────────── */}
            <div className="col-span-2 md:col-span-4 border-t border-border pt-3 mt-1 text-[10px] font-mono uppercase text-muted-foreground">
              Time Response
            </div>
            <NumField
              label="Binding Rate (1/s)"
              value={fetParams.bindingRate_perS}
              min={0.01} max={10} step={0.01}
              onChange={(v) => onChangeFET({ ...fetParams, bindingRate_perS: v })}
              disabled={disabled}
              info="Pseudo-first-order association rate constant."
            />
            <NumField
              label="Readout Bias (V)"
              value={fetParams.readoutBias_V}
              min={-1} max={2} step={0.01}
              onChange={(v) => onChangeFET({ ...fetParams, readoutBias_V: v })}
              disabled={disabled}
              hint="≤ ±1.1 V on this hardware"
              info="Fixed gate voltage at which drain current is monitored over time. The LPDAC bias path on real hardware supports roughly ±1.1 V around the Vzero reference."
            />
            <NumField
              label="Duration (s)"
              value={fetParams.timeDuration_s}
              min={10} max={600} step={10}
              onChange={(v) => onChangeFET({ ...fetParams, timeDuration_s: v })}
              disabled={disabled}
            />
            <NumField
              label="Time Step (s)"
              value={fetParams.timeStep_s}
              min={0.1} max={5} step={0.1}
              onChange={(v) => onChangeFET({ ...fetParams, timeStep_s: v })}
              disabled={disabled}
            />
            <NumField
              label="Injection Time (s)"
              value={fetParams.injectionTime_s}
              min={0} max={fetParams.timeDuration_s} step={0.5}
              onChange={(v) => onChangeFET({ ...fetParams, injectionTime_s: v })}
              disabled={disabled}
              info="Simulated analyte injection onset; also settable by clicking + Add Sample before starting."
            />
          </div>
        )}
        {mode === "cv" && cvParams && onChangeCV && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <NumField
              label="Scan Rate (mV/s)"
              value={cvParams.scanRate}
              min={10}
              max={500}
              step={10}
              onChange={(v) => onChangeCV({ ...cvParams, scanRate: v })}
              disabled={disabled}
              hint="10 – 500"
            />
            <NumField
              label="E Start (V)"
              value={cvParams.eStart}
              min={-2}
              max={2}
              onChange={(v) => onChangeCV({ ...cvParams, eStart: v })}
              disabled={disabled}
              hint="≤ ±1.1 V on this hardware"
              info="The LPDAC bias path on real hardware supports roughly ±1.1 V around the Vzero reference; a sweep asking for more will clip at the extremes."
            />
            <NumField
              label="E Vertex 1 (V)"
              value={cvParams.eVertex1}
              min={-2}
              max={2}
              onChange={(v) => onChangeCV({ ...cvParams, eVertex1: v })}
              disabled={disabled}
              hint="≤ ±1.1 V on this hardware"
              info="The LPDAC bias path on real hardware supports roughly ±1.1 V around the Vzero reference; a sweep asking for more will clip at the extremes."
            />
            <NumField
              label="E Vertex 2 (V)"
              value={cvParams.eVertex2}
              min={-2}
              max={2}
              onChange={(v) => onChangeCV({ ...cvParams, eVertex2: v })}
              disabled={disabled}
              hint="≤ ±1.1 V on this hardware"
              info="The LPDAC bias path on real hardware supports roughly ±1.1 V around the Vzero reference; a sweep asking for more will clip at the extremes."
            />
            <NumField
              label="Cycles"
              value={cvParams.nCycles}
              min={1}
              max={5}
              step={1}
              onChange={(v) => onChangeCV({ ...cvParams, nCycles: Math.round(v) })}
              disabled={disabled}
            />
            <NumField
              label="n (electrons)"
              value={cvParams.n}
              min={1}
              max={4}
              step={1}
              onChange={(v) => onChangeCV({ ...cvParams, n: Math.round(v) })}
              disabled={disabled}
            />
            <NumField
              label="C (mM)"
              value={cvParams.cMM}
              min={0}
              max={1000}
              onChange={(v) => onChangeCV({ ...cvParams, cMM: v })}
              disabled={disabled}
            />
            <NumField
              label="A (cm²)"
              value={cvParams.areaCm2}
              min={1e-4}
              max={10}
              onChange={(v) => onChangeCV({ ...cvParams, areaCm2: v })}
              disabled={disabled}
            />
            <div className="flex flex-col gap-1 col-span-2">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">
                CV Model
                <InfoHint text="Reversible = semi-infinite diffusion with a Nernst boundary. Quasi-reversible is an educational Butler-Volmer approximation; D apparent may be biased." />
              </Label>
              <select
                disabled={disabled}
                value={cvParams.cvModel}
                onChange={(e) =>
                  onChangeCV({
                    ...cvParams,
                    cvModel: e.target.value as CVParams["cvModel"],
                  })
                }
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              >
                <option value="reversible">Reversible (diffusion + Nernst)</option>
                <option value="quasi-reversible">
                  Quasi-reversible (Butler–Volmer)
                </option>
              </select>
              <span className="text-[10px] text-muted-foreground font-mono">Default: reversible.</span>
            </div>

            {/* ── Analyte-specific electrochemistry ─────────────────── */}
            <div className="col-span-2 md:col-span-4 border-t border-border pt-3 mt-1 flex flex-col gap-1">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">
                Redox Probe Preset
                <InfoHint text={'Fills D and E°\' with literature values. k₀, α and acquisition fields are left unchanged. "Custom" allows any analyte-specific value.'} />
              </Label>
              <select
                disabled={disabled}
                onChange={(e) => {
                  const preset = CV_REDOX_PRESETS[e.target.value];
                  if (preset) {
                    onChangeCV({
                      ...cvParams,
                      diffusionCoeff: preset.D,
                      formalPotential: preset.E0,
                    });
                  }
                }}
                defaultValue="custom"
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              >
                <option value="custom">Custom (keep current D and E°')</option>
                <option value="ferricyanide">
                  [Fe(CN)6]³⁻/⁴⁻ (D=7.26e-6, E°'=0.22 V)
                </option>
                <option value="ruthenium">
                  [Ru(NH3)6]³⁺/²⁺ (D=5.3e-6, E°'=-0.18 V)
                </option>
                <option value="ferrocenemethanol">
                  Ferrocenemethanol (D=7.8e-6, E°'=0.20 V)
                </option>
              </select>
            </div>
            <NumField
              label="D (cm²/s)"
              value={cvParams.diffusionCoeff}
              min={1e-8}
              max={1e-3}
              step={1e-7}
              onChange={(v) => onChangeCV({ ...cvParams, diffusionCoeff: v })}
              disabled={disabled}
              hint="Default: 7.26e-6 (ferri/ferrocyanide)"
              info="Diffusion coefficient of the analyte."
            />
            <NumField
              label="E°' (V)"
              value={cvParams.formalPotential}
              min={-1}
              max={1}
              step={0.01}
              onChange={(v) => onChangeCV({ ...cvParams, formalPotential: v })}
              disabled={disabled}
              hint="Default: 0.22 V (ferri/ferro vs Ag/AgCl)"
              info="Formal redox potential vs reference electrode."
            />
            <NumField
              label="k₀ (cm/s)"
              value={cvParams.k0}
              min={1e-6}
              max={10}
              step={0.001}
              onChange={(v) => onChangeCV({ ...cvParams, k0: v })}
              disabled={disabled || cvParams.cvModel !== "quasi-reversible"}
              info="Heterogeneous electron-transfer rate constant. Lower k₀ gives a larger ΔEp."
            />
            <NumField
              label="α (transfer coeff.)"
              value={cvParams.alpha}
              min={0.1}
              max={0.9}
              step={0.05}
              onChange={(v) => onChangeCV({ ...cvParams, alpha: v })}
              disabled={disabled || cvParams.cvModel !== "quasi-reversible"}
              hint="Typically 0.3–0.7"
            />
            <div className="col-span-2 md:col-span-4 text-[10px] font-mono text-muted-foreground">
              k₀ and α only apply to the Quasi-reversible (Butler–Volmer) model.
            </div>

            {/* ── Acquisition: step potential & quiet time ─────────── */}
            <NumField
              label="Step (mV)"
              value={cvParams.stepPotential}
              min={0.5}
              max={20}
              step={0.5}
              onChange={(v) => onChangeCV({ ...cvParams, stepPotential: v })}
              disabled={disabled}
              info="Potential increment per data point (staircase approximation of the linear scan)."
            />
            <NumField
              label="Quiet Time (s)"
              value={cvParams.quietTime}
              min={0}
              max={60}
              step={1}
              onChange={(v) => onChangeCV({ ...cvParams, quietTime: v })}
              disabled={disabled}
              info="Equilibration time at E Start before the scan begins."
            />
            <div className="flex flex-col gap-1 col-span-2">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">
                RTIA Gain
                <InfoHint text="HSTIA feedback resistor on real hardware. Too low underuses the ADC range for small currents, too high saturates it for large ones; the app flags out-of-range readings per point." />
              </Label>
              <select
                disabled={disabled}
                value={cvParams.rtiaOhms}
                onChange={(e) => onChangeCV({ ...cvParams, rtiaOhms: Number(e.target.value) })}
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              >
                {AD5941_RTIA_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <span className="text-[10px] text-muted-foreground font-mono">10 kΩ default.</span>
            </div>
            {(() => {
              const totalRangeV =
                2 *
                Math.abs(
                  Math.max(cvParams.eVertex1, cvParams.eVertex2) -
                    Math.min(cvParams.eVertex1, cvParams.eVertex2),
                ) *
                cvParams.nCycles;
              const estPts =
                cvParams.stepPotential > 0
                  ? Math.round((totalRangeV * 1000) / cvParams.stepPotential)
                  : 0;
              // The quasi-reversible solver convolves the full current history
              // at every step, so its cost grows with the SQUARE of the point
              // count and it runs synchronously. Warn before the browser tab
              // locks up for seconds on a dense sweep.
              const heavyQuasi =
                cvParams.cvModel === "quasi-reversible" && estPts > 8000;
              return (
                <div className="col-span-2 md:col-span-4 text-[10px] font-mono space-y-1">
                  <div className="text-muted-foreground">
                    ≈ {estPts} points per full sweep
                  </div>
                  {heavyQuasi && (
                    <div className="text-yellow-500">
                      ⚠ {estPts} points with the quasi-reversible model is slow;
                      this solver scales quadratically and will freeze the page
                      while it runs. Increase the step or reduce cycles.
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
        {mode === "swv" && swvParams && onChangeSWV && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <NumField
              label="E Start (V)"
              value={swvParams.startE}
              min={-2}
              max={2}
              onChange={(v) => onChangeSWV({ ...swvParams, startE: v })}
              disabled={disabled}
              hint="Window ± amplitude ≤ ±1.1 V"
              info="The LPDAC bias path on real hardware supports roughly ±1.1 V around the Vzero reference; E Start/E End plus the pulse Amplitude together must stay inside that window or the sweep will clip."
            />
            <NumField
              label="E End (V)"
              value={swvParams.endE}
              min={-2}
              max={2}
              onChange={(v) => onChangeSWV({ ...swvParams, endE: v })}
              disabled={disabled}
              hint="Window ± amplitude ≤ ±1.1 V"
              info="The LPDAC bias path on real hardware supports roughly ±1.1 V around the Vzero reference; E Start/E End plus the pulse Amplitude together must stay inside that window or the sweep will clip."
            />
            <NumField
              label="Step (mV)"
              value={swvParams.step_mV}
              min={0.1}
              max={50}
              onChange={(v) => onChangeSWV({ ...swvParams, step_mV: v })}
              disabled={disabled}
            />
            <NumField
              label="Amplitude (mV)"
              value={swvParams.amplitude_mV}
              min={1}
              max={200}
              onChange={(v) => onChangeSWV({ ...swvParams, amplitude_mV: v })}
              disabled={disabled}
              hint="Window ± amplitude ≤ ±1.1 V"
              info="The LPDAC bias path on real hardware supports roughly ±1.1 V around the Vzero reference; the pulse amplitude adds to E Start/E End, so a large amplitude can push the window past that limit even if E Start/E End alone look fine."
            />
            <NumField
              label="Frequency (Hz)"
              value={swvParams.frequency_Hz}
              min={1}
              max={1000}
              onChange={(v) => onChangeSWV({ ...swvParams, frequency_Hz: v })}
              disabled={disabled}
            />
            <NumField
              label="Quiet Time (s)"
              value={swvParams.quietTime_s}
              min={0}
              max={60}
              onChange={(v) => onChangeSWV({ ...swvParams, quietTime_s: v })}
              disabled={disabled}
            />
            <NumField
              label="Area (cm²)"
              value={swvParams.area_cm2 ?? 0}
              min={1e-4}
              max={10}
              onChange={(v) => onChangeSWV({ ...swvParams, area_cm2: v })}
              disabled={disabled}
            />
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">
                RTIA Gain
                <InfoHint text="HSTIA feedback resistor. SWV's differential current is usually smaller than CV's, so a higher gain may use the ADC range better." />
              </Label>
              <select
                disabled={disabled}
                value={swvParams.rtiaOhms ?? 10000}
                onChange={(e) => onChangeSWV({ ...swvParams, rtiaOhms: Number(e.target.value) })}
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              >
                {AD5941_RTIA_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <span className="text-[10px] text-muted-foreground font-mono">10 kΩ default.</span>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">
                Direction
              </Label>
              <select
                disabled={disabled}
                value={swvParams.direction}
                onChange={(e) =>
                  onChangeSWV({
                    ...swvParams,
                    direction: e.target.value as SWVParameters["direction"],
                  })
                }
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              >
                <option value="anodic">anodic</option>
                <option value="cathodic">cathodic</option>
              </select>
            </div>
            <div className="flex flex-col gap-1 col-span-2">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">
                SWV Model
                <InfoHint text="Reversible = same diffusion physics as CV's reversible model, applied per half-pulse. Quasi-reversible is an educational approximation and much slower on dense sweeps." />
              </Label>
              <select
                disabled={disabled}
                value={swvParams.swvModel ?? "reversible"}
                onChange={(e) =>
                  onChangeSWV({
                    ...swvParams,
                    swvModel: e.target.value as NonNullable<SWVParameters["swvModel"]>,
                  })
                }
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              >
                <option value="reversible">Reversible (diffusion + Nernst)</option>
                <option value="quasi-reversible">
                  Quasi-reversible (Butler–Volmer)
                </option>
              </select>
              <span className="text-[10px] text-muted-foreground font-mono">Default: reversible.</span>
            </div>

            {/* ── Analyte-specific electrochemistry (SWV) ──────────── */}
            <div className="col-span-2 md:col-span-4 border-t border-border pt-3 mt-1 flex flex-col gap-1">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">
                Redox Probe Preset
              </Label>
              <select
                disabled={disabled}
                defaultValue="custom"
                onChange={(e) => {
                  const preset = CV_REDOX_PRESETS[e.target.value];
                  if (preset) {
                    onChangeSWV({
                      ...swvParams,
                      diffusionCoeff: preset.D,
                      formalPotential: preset.E0,
                    });
                  }
                }}
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              >
                <option value="custom">Custom (keep current D and E°')</option>
                <option value="ferricyanide">[Fe(CN)6]³⁻/⁴⁻ (D=7.26e-6, E°'=0.22 V)</option>
                <option value="ruthenium">[Ru(NH3)6]³⁺/²⁺ (D=5.3e-6, E°'=-0.18 V)</option>
                <option value="ferrocenemethanol">Ferrocenemethanol (D=7.8e-6, E°'=0.20 V)</option>
              </select>
            </div>
            <NumField
              label="n (electrons)"
              value={swvParams.nElectrons ?? 1}
              min={1} max={4} step={1}
              onChange={(v) => onChangeSWV({ ...swvParams, nElectrons: v })}
              disabled={disabled}
            />
            <NumField
              label="D (cm²/s)"
              value={swvParams.diffusionCoeff ?? CV_DEFAULT_D_CM2_S}
              min={1e-8} max={1e-3} step={1e-7}
              onChange={(v) => onChangeSWV({ ...swvParams, diffusionCoeff: v })}
              disabled={disabled}
              hint="Default: 7.26e-6 (ferri/ferrocyanide)"
              info="Diffusion coefficient of the analyte."
            />
            <NumField
              label="E°' (V)"
              value={swvParams.formalPotential ?? CV_E0_PRIME_DEFAULT_V}
              min={-1} max={1} step={0.01}
              onChange={(v) => onChangeSWV({ ...swvParams, formalPotential: v })}
              disabled={disabled}
              info="Formal redox potential vs reference electrode."
            />
            <NumField
              label="k₀ (cm/s)"
              value={swvParams.k0 ?? CV_BV_K0}
              min={1e-6} max={10} step={0.001}
              onChange={(v) => onChangeSWV({ ...swvParams, k0: v })}
              disabled={disabled}
              info="Heterogeneous electron-transfer rate constant. SWV peak height and shape are sensitive to k₀, especially at higher frequencies."
            />
            <NumField
              label="α (transfer coeff.)"
              value={swvParams.alpha ?? CV_BV_ALPHA}
              min={0.1} max={0.9} step={0.05}
              onChange={(v) => onChangeSWV({ ...swvParams, alpha: v })}
              disabled={disabled}
            />
            <div className="col-span-2 md:col-span-4 text-[10px] font-mono text-muted-foreground">
              SWV peak current and peak potential are more sensitive to k₀ than
              CV, since the square-wave frequency probes faster kinetics. This
              makes SWV useful for distinguishing surface-confined
              (aptamer-bound) electron-transfer kinetics from diffusional ones.
            </div>
          </div>
        )}

      </CollapsibleContent>
    </Collapsible>
  );
};

export default ParametersPanel;

