import type { CircuitModel, EISFitResult } from "@/utils/eisFit";
import { formatParamValue, getCircuitLabel } from "@/utils/eisFit";
import type { RandlesFitResult, WarburgResult, KKResult } from "@/utils/randlesFit";
import type { LinKKResult } from "@/utils/linKK";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { InfoHint, Hint } from "@/components/InfoHint";

/** Short explanations for the circuit parameters shown in the fit panel. */
export const PARAM_HINTS: Record<string, string> = {
  Rs: "Solution resistance — series resistance between the working and reference electrodes.",
  Rct: "Charge-transfer resistance — inversely related to the rate of electron transfer at the electrode surface. The primary signal for aptamer binding events.",
  Cdl: "Double-layer capacitance — models the electrode/electrolyte interface capacitance.",
  Q: "CPE magnitude — pseudo-capacitance of the constant phase element modelling a non-ideal interface.",
  n: "CPE exponent — 1 is an ideal capacitor, lower values indicate surface heterogeneity.",
  Aw: "Warburg coefficient — reflects diffusion-limited mass transport at low frequencies.",
};


interface Props {
  fit: EISFitResult | null;
  model: CircuitModel;
  randlesFit?: RandlesFitResult | null;
  warburg?: WarburgResult | null;
  kk?: KKResult | null;
  linKK?: LinKKResult | null;
}

/**
 * Scientific CNLS fit results. Each parameter is shown with its approximate
 * local standard error (%) from the log-space covariance. The global
 * quality-of-fit indicator is the modulus-weighted SSR per dof (a relative
 * indicator — not a classical statistical goodness-of-fit value).
 */

const CNLSFitResults = ({ fit, model, randlesFit, warburg, kk, linKK }: Props) => {
  if (!fit) {
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <h3 className="text-sm font-mono text-muted-foreground mb-2">
          CNLS Fit — {getCircuitLabel(model)}
        </h3>
        <p className="text-xs text-muted-foreground font-mono">
          Select a circuit, set the separator and click <span className="text-foreground">Fit</span>.
        </p>
      </div>
    );
  }

  const fmtErr = (e: number) =>
    Number.isFinite(e) ? `±${e < 0.01 ? e.toExponential(1) : e.toFixed(2)}%` : "±—";

  const chi = fit.chiSquared;
  const chiStr =
    chi >= 0.01 && chi < 1e4 ? chi.toFixed(4) : chi.toExponential(3);

  const chiClass =
    chi < 1e-3 ? "text-graph-primary"
    : chi < 1e-2 ? "text-foreground"
    : "text-destructive";

  // Warburg region present?
  const hasWarburg = !!(warburg && warburg.ok && (warburg.nPoints ?? 0) >= 3);
  const awValue = warburg?.Aw ?? randlesFit?.Aw;
  const awErr = randlesFit?.errors?.Aw;
  const slope = warburg?.slope;
  const slopeBad = typeof slope === "number" && (slope < 0.5 || slope > 2.0);

  // f₀ characteristic frequency from CNLS params.
  // Randles:     f0 = 1 / (2π · Rct · Cdl)
  // Randles-CPE: f0 = (Rct·Q)^(-1/n) / (2π)
  const Rct = fit.params.Rct;
  const Cdl = fit.params.Cdl;
  const Q = fit.params.Q;
  const nCpe = fit.params.n;
  let f0: number | undefined;
  if (model === "randles-cpe" && Rct && Q && nCpe && nCpe > 0) {
    f0 = Math.pow(Rct * Q, -1 / nCpe) / (2 * Math.PI);
  } else if (Rct && Cdl) {
    f0 = 1 / (2 * Math.PI * Rct * Cdl);
  } else {
    f0 = randlesFit?.f0;
  }
  const f0Str = Number.isFinite(f0 ?? NaN)
    ? (f0! >= 0.01 && f0! < 1e6 ? f0!.toFixed(2) : f0!.toExponential(2))
    : "—";


  // Fit error % — prefer CNLS weighted SSR/dof, fall back to randlesFit.
  // sqrt(weightedSsrPerDof)*100 gives a unit comparable to RMSE %
  // (~1e-5 for excellent fit, ~1e-2 for poor fit).
  const fitErrorPct = fit?.chiSquared != null
    ? Math.sqrt(fit.chiSquared) * 100
    : randlesFit?.fitErrorPct;
  // Fit error from wSSR/dof: <2% excellent, <8% good, >=8% poor
  const fitErrColor = (v: number) =>
    v < 2 ? "text-graph-primary" : v < 8 ? "text-foreground" : "text-destructive";

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-mono text-muted-foreground">
          CNLS Fit
        </h3>
        <span className="text-[10px] font-mono text-muted-foreground text-right">
          {getCircuitLabel(model)}
        </span>
      </div>

      <div className="space-y-1.5">
        {Object.keys(fit.params).map((name) => {
          const v   = fit.params[name];
          const e   = fit.errors[name];
          const u   = fit.units[name] ?? "";
          const errPct = Number.isFinite(e) ? e : Infinity;
          const errClass =
            errPct < 5  ? "text-graph-primary"
            : errPct < 20 ? "text-foreground"
            : "text-destructive";
          return (
            <div
              key={name}
              className="flex items-center justify-between bg-secondary rounded-md p-2"
            >
              <div className="flex flex-col">
                <span className="text-[10px] font-mono text-muted-foreground uppercase">
                  {name}
                  {PARAM_HINTS[name] ? <InfoHint text={PARAM_HINTS[name]} /> : null}
                </span>

                <span className="text-sm font-mono text-foreground">
                  {formatParamValue(name, v, u)}
                </span>
              </div>
              <Hint text="Approximate local standard error of this parameter, from the log-space covariance matrix. <5% green, <20% neutral, ≥20% red — a high value means the fit doesn't pin this parameter down well.">
                <span className={`text-xs font-mono cursor-help ${errClass}`}>
                  {fmtErr(errPct)}
                </span>
              </Hint>
            </div>
          );
        })}
      </div>

      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center justify-between text-xs font-mono cursor-help border-t border-border pt-2">
              <span className="text-muted-foreground">Weighted SSR / dof</span>
              <span className={chiClass}>{chiStr}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs font-mono">
            Modulus-weighted SSR per degree of freedom — a relative indicator,
            not a classical statistical goodness-of-fit. &lt;0.001 green
            (excellent), &lt;0.01 neutral (acceptable), otherwise red (poor
            fit or wrong circuit).
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {fit.covarianceWarning && (
        <div className="text-[10px] font-mono text-yellow-500 leading-snug">
          ⚠ Covariance matrix ill-conditioned — parameter SE% unreliable.
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
        <span>N = {fit.nPoints} points</span>
        <span>P = {fit.nFreeParams} free params</span>
        <span>dof = {Math.max(2 * fit.nPoints - fit.nFreeParams, 0)}</span>
      </div>

      {/* Aw card or "no Warburg" notice */}
      {hasWarburg && Number.isFinite(awValue ?? NaN) ? (
        <div className="flex items-center justify-between bg-secondary rounded-md p-2">
          <div className="flex flex-col">
            <span className="text-[10px] font-mono text-muted-foreground uppercase">
              Aw
              <InfoHint text={PARAM_HINTS.Aw} />
            </span>

            <span className="text-sm font-mono text-foreground">
              {awValue!.toFixed(3)} Ω/√s
            </span>
          </div>
          <span className="text-xs font-mono text-muted-foreground">
            {Number.isFinite(awErr) ? `±${awErr!.toFixed(2)}%` : "±—"}
          </span>
        </div>
      ) : (
        <div className="text-[10px] font-mono text-muted-foreground border-t border-border pt-2">
          Aw — no Warburg region detected
        </div>
      )}

      {/* Fit error % */}
      {Number.isFinite(fitErrorPct ?? NaN) && (
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-muted-foreground">
            Fit error
            <InfoHint text="sqrt(weighted SSR/dof) × 100, an RMSE-like percentage. <2% excellent (green), <8% good (neutral), ≥8% poor (red)." />
          </span>
          <span className={fitErrColor(fitErrorPct!)}>{fitErrorPct!.toFixed(2)} %</span>
        </div>
      )}

      {/* f₀ characteristic */}
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-muted-foreground">
          f₀ (characteristic)
          <InfoHint
            text={
              model === "randles-cpe"
                ? "Characteristic frequency, f₀ = (Rct·Q)^(−1/n)/2π — marks the Rct/CPE balance point."
                : "Characteristic frequency, f₀ = 1/(2π·Rct·Cdl) — marks the Rct/Cdl balance point."
            }
          />
        </span>
        <span className="text-foreground">{f0Str} Hz</span>
      </div>


      {/* Lin-KK validation — primary consistency test */}
      {linKK && (
        <div className="border-t border-border pt-2 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Lin-KK validation
              <InfoHint text="Passing supports consistency with linear, causal, stable EIS behavior within the measured frequency range. Does NOT prove the selected equivalent circuit is correct." />
            </span>
            <span
              className={
                linKK.passed
                  ? "inline-flex items-center rounded-md border border-graph-primary/40 bg-graph-primary/10 px-2 py-0.5 text-[10px] font-mono text-graph-primary"
                  : linKK.residualRmsPct <= 10
                    ? "inline-flex items-center rounded-md border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-[10px] font-mono text-yellow-500"
                    : "inline-flex items-center rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-mono text-destructive"
              }

            >
              {linKK.passed ? "✓ Pass" : linKK.residualRmsPct <= 10 ? "⚠ Warning" : "✗ Fail"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[10px] font-mono text-muted-foreground">
            <div>RMS res.: <span className="text-foreground">{linKK.residualRmsPct.toFixed(2)} %</span></div>
            <div>Max res.: <span className="text-foreground">{linKK.maxResidualPct.toFixed(2)} %</span></div>
            <div>RC: <span className="text-foreground">{linKK.tauCount}</span></div>
          </div>
          {linKK.warnings.length > 0 && (
            <div className="text-[10px] font-mono text-yellow-500 leading-snug">
              {linKK.warnings.join(" · ")}
            </div>
          )}
          <div className="text-[9px] font-mono text-muted-foreground/70 leading-snug">
            Passing supports consistency with linear, causal, stable EIS behavior within the measured frequency range.
          </div>
        </div>
      )}

      {/* Approx KK is no longer rendered in the main UI. It remains in the
          CSV export marked `approx_kk_informational_only=true` for traceability.
          Lin-KK (above) is the consistency check shown to the user. */}
      {false && kk && null}


      {/* Warburg slope */}
      {hasWarburg && typeof slope === "number" && (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center justify-between text-xs font-mono cursor-help">
                <span className="text-muted-foreground">Warburg slope</span>
                <span className="flex items-center gap-2">
                  <span className="text-foreground">
                    {slope.toFixed(2)}
                    <span className="text-muted-foreground ml-2">(ideal 1.00)</span>
                    {Number.isFinite(warburg?.r2Imag ?? NaN) && (
                      <span className="text-muted-foreground ml-2">R²={warburg!.r2Imag!.toFixed(3)}</span>
                    )}
                  </span>
                  {slopeBad && (
                    <span className="inline-flex items-center rounded-md border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 text-[9px] font-mono text-yellow-500">
                      ⚠
                    </span>
                  )}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs font-mono">
              Warburg slope is estimated from the selected low-frequency tail
              (method: regression of -Im(Z) vs 1/√ω). Ideal semi-infinite
              diffusion gives slope ≈ 1 in -Z'' vs Z'. Values far from 1
              indicate the selected region is not a pure 45° Warburg tail, or
              the circuit includes mixed kinetic/capacitive effects.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Existing CNLS warnings */}
      {fit.warnings && fit.warnings.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {fit.warnings.map((w, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-md border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-[10px] font-mono text-yellow-500"
            >
              ⚠ {w}
            </span>
          ))}
        </div>
      )}

      {/* Randles warn flags */}
      {randlesFit?.warnFlags && randlesFit.warnFlags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {randlesFit.warnFlags.map((w, i) => (
            <span
              key={`rf-${i}`}
              className="inline-flex items-center rounded-md border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-[10px] font-mono text-yellow-500"
            >
              ⚠ {w}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default CNLSFitResults;
