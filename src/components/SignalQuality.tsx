import { useMemo } from "react";
import type { EISDataPoint, FETTransferPoint } from "@/hooks/useSimulatedData";
import { computeFETQuality } from "@/utils/fetQuality";
import type { CVDataPoint } from "@/hooks/useSimulatedCVData";
import type { CVMetrics } from "@/utils/computeCVMetrics";
import { computeCVSignalQuality, estimateCVStepMv } from "@/utils/cvSignalQuality";
import type { SWVDataPoint, SWVMetrics } from "@/types/swv";
import { InfoHint } from "@/components/InfoHint";



/**
 * ============================================================
 * SIGNAL QUALITY PANEL — EIS / BioFET / CV
 * ============================================================
 */

export type Level = "green" | "yellow" | "red" | "idle";

/**
 * Shared "worst wins" rollup: green only if every level is green, red if any
 * is red, yellow otherwise. "idle" entries (metric not yet computable) are
 * ignored; if every entry is idle, the rollup itself is idle. Used by every
 * mode (EIS/FET/SWV) so the rule can't silently drift between them.
 */
export function worstOf(levels: Level[]): Level {
  const relevant = levels.filter((l) => l !== "idle");
  if (relevant.length === 0) return "idle";
  if (relevant.every((l) => l === "green")) return "green";
  if (relevant.some((l) => l === "red")) return "red";
  return "yellow";
}

interface SignalQualityProps {
  mode: "eis" | "fet" | "cv" | "swv";
  eisData: EISDataPoint[];
  fetBaseline: FETTransferPoint[];
  fetAnalyte: FETTransferPoint[];
  cnlsChiSquared?: number | null;
  separatorZReal?: number | null;
  separatorFreq?: number | null;
  /** Lin-KK RMS residual % — preferred consistency metric. */
  linKKResidualPct?: number | null;
  /** Lin-KK passed flag (RMS ≤ 5%). */
  linKKPassed?: boolean | null;
  cvMetrics?: CVMetrics | null;
  cvNElectrons?: number;
  /** Raw CV points — used only to check the outOfRange flag on live data. */
  cvData?: CVDataPoint[];
  /** SWV inputs — used when mode === "swv". */
  swvData?: SWVDataPoint[];
  swvMetrics?: SWVMetrics | null;
}

/**
 * Live-hardware-only check: counts points where the firmware flagged the
 * HSTIA output as outside the AD5941's usable ADC window. Simulated data
 * and older firmware never set `outOfRange`, so `anyFlagPresent` stays
 * false and the caller shows nothing — this never affects simulated mode.
 */
function outOfRangeInfo(points: { outOfRange?: boolean }[]) {
  const anyFlagPresent = points.some((p) => p.outOfRange !== undefined);
  const count = points.filter((p) => p.outOfRange === true).length;
  return { count, total: points.length, anyFlagPresent };
}


// ---- helpers ----

const dotClass = (level: Level) => {
  switch (level) {
    case "green":
      return "bg-graph-eis shadow-[0_0_8px_hsl(var(--graph-line-eis))]";
    case "yellow":
      return "bg-graph-alt shadow-[0_0_8px_hsl(var(--graph-line-alt))]";
    case "red":
      return "bg-destructive shadow-[0_0_8px_hsl(var(--destructive))]";
    default:
      return "bg-muted-foreground/40";
  }
};

const lightClass = (level: Level, active: boolean) => {
  if (!active) return "bg-muted/40";
  switch (level) {
    case "green":
      return "bg-graph-eis shadow-[0_0_20px_hsl(var(--graph-line-eis))]";
    case "yellow":
      return "bg-graph-alt shadow-[0_0_20px_hsl(var(--graph-line-alt))]";
    case "red":
      return "bg-destructive shadow-[0_0_20px_hsl(var(--destructive))]";
    default:
      return "bg-muted/40";
  }
};

/** Compute EIS quality metrics. */
function computeEISMetrics(
  dataAll: EISDataPoint[],
  cnlsChiSquared?: number | null,
  separatorZReal?: number | null,
  separatorFreq?: number | null,
  linKKResidualPct?: number | null,
  linKKPassed?: boolean | null,
) {
  const data = dataAll;

  // Resolve the separator on the FREQUENCY axis. The Warburg tail folds
  // back to lower Z' values, so filtering by zReal alone misclassifies
  // points. Prefer an explicit separatorFreq; otherwise locate the
  // frequency of the closest-zReal point and use that.
  let sepFreq: number | null = null;
  if (separatorFreq != null && Number.isFinite(separatorFreq)) {
    sepFreq = separatorFreq;
  } else if (separatorZReal != null && data.length > 0) {
    const closest = data.reduce(
      (best, d) =>
        Math.abs(d.zReal - separatorZReal) < Math.abs(best.zReal - separatorZReal) ? d : best,
      data[0],
    );
    sepFreq = closest.frequency;
  }
  const semiData = sepFreq != null ? data.filter((d) => d.frequency >= sepFreq!) : data;

  if (data.length < 10) {
    return {
      level: "idle" as Level,
      ready: false,
      semicircleFit: 0,
      pointNoise: 0,
      rsStability: 0,
      totalPoints: data.length,
      linKKPct: NaN,
      semicircleLevel: "idle" as Level,
      noiseLevel: "idle" as Level,
      rsLevel: "idle" as Level,
      pointsLevel: "idle" as Level,
      linKKLevel: "idle" as Level,
    };
  }

  const reals = data.map((d) => d.zReal);
  const maxR = Math.max(...reals);
  const minR = Math.min(...reals);

  // 1. Semicircle Fit (%) — when CNLS is available, derive from
  // sqrt(weighted SSR/dof)*100 ≈ modulus-weighted RMSE %.
  let fitPct: number;
  if (Number.isFinite(cnlsChiSquared ?? NaN) && (cnlsChiSquared as number) >= 0) {
    const errPct = Math.sqrt(cnlsChiSquared as number) * 100;
    fitPct = Math.max(0, Math.min(100, 100 - errPct));
  } else {
    const sReals = semiData.map((d) => d.zReal);
    const sMax = sReals.length ? Math.max(...sReals) : maxR;
    const sMin = sReals.length ? Math.min(...sReals) : minR;
    const centerX = (sMax + sMin) / 2;
    const R = (sMax - sMin) / 2;
    const pts = semiData.length >= 5 ? semiData : data;
    const distances = pts.map((d) =>
      Math.sqrt((d.zReal - centerX) ** 2 + d.zImag ** 2)
    );
    const meanD = distances.reduce((a, b) => a + b, 0) / distances.length;
    const variance =
      distances.reduce((a, b) => a + (b - meanD) ** 2, 0) / distances.length;
    const stdDev = Math.sqrt(variance);
    fitPct = R > 1e-6
      ? Math.max(0, Math.min(100, 100 - (stdDev / R) * 100))
      : 0;
  }

  // 2. Residual noise (% of |Z|).
  // Preferred: when a CNLS fit is available, sqrt(weighted SSR/dof)·100 IS
  // the modulus-weighted RMS residual — exactly the quantity the user
  // expects to track the fit error. Fallback when no CNLS exists: use the
  // SECOND-DIFFERENCE residual against a 3-point LINEAR predictor (mean of
  // neighbors). The old 3-point median collapsed to zero for any smooth
  // monotonic curve because mags[i] WAS the median by construction.
  let noisePct = 0;
  if (Number.isFinite(cnlsChiSquared ?? NaN) && (cnlsChiSquared as number) >= 0) {
    noisePct = Math.sqrt(Math.max(cnlsChiSquared as number, 0)) * 100;
  } else if (data.length >= 5) {
    const sorted = [...data].sort((a, b) => b.frequency - a.frequency);
    const mags = sorted.map((d) => Math.sqrt(d.zReal ** 2 + d.zImag ** 2));
    const rel: number[] = [];
    for (let i = 1; i < mags.length - 1; i++) {
      const expected = (mags[i - 1] + mags[i + 1]) / 2;
      if (mags[i] > 1e-9) rel.push(Math.abs(mags[i] - expected) / mags[i]);
    }
    if (rel.length > 0) {
      // RMS of normalized residuals is robust and not zero for smooth data
      // unless the curve is exactly linear in |Z|.
      const ms = rel.reduce((s, v) => s + v * v, 0) / rel.length;
      noisePct = 100 * Math.sqrt(ms);
    }
  }

  // 3. Rs — minimum Z' (typical 50–2000 Ω)
  const rs = minR;

  // 4. Lin-KK consistency (% RMS residual).
  const linKKPct = Number.isFinite(linKKResidualPct ?? NaN)
    ? (linKKResidualPct as number)
    : NaN;

  // Per-metric levels — thresholds tuned for real experimental data so that
  // borderline-but-usable EIS sweeps are flagged yellow (acceptable) instead
  // of red. A 94.9 % semicircle / 5 % residual noise sweep should NOT be
  // labelled "Poor Signal".
  const semicircleLevel: Level =
    fitPct >= 95 ? "green" : fitPct >= 85 ? "yellow" : "red";
  // Residual noise: ≤3 % green, ≤8 % yellow, else red.
  const noiseLevel: Level =
    noisePct <= 3 ? "green" : noisePct <= 8 ? "yellow" : "red";
  // Rs: keep wide acceptable band; never harder than yellow inside 0–5000 Ω.
  const rsLevel: Level =
    rs >= 50 && rs <= 2000 ? "green" : rs > 0 && rs < 5000 ? "yellow" : "red";
  const pointsLevel: Level =
    data.length >= 30 ? "green" : data.length >= 15 ? "yellow" : "red";
  // Lin-KK: green if passed AND RMS≤5%; yellow 5–10%; red >10% or explicit fail.
  let linKKLevel: Level = "idle";
  if (Number.isFinite(linKKPct)) {
    if (linKKPct <= 5 && (linKKPassed === true || linKKPassed == null)) linKKLevel = "green";
    else if (linKKPct <= 10) linKKLevel = "yellow";
    else linKKLevel = "red";
  }

  // Overall via the shared worst-of rollup. Lin-KK is essential when
  // available (worstOf ignores it otherwise). The legacy Approx-KK metric is
  // informational only and never drives overall.
  const level = worstOf([semicircleLevel, noiseLevel, rsLevel, pointsLevel, linKKLevel]);

  return {
    level,
    ready: true,
    semicircleFit: fitPct,
    pointNoise: noisePct,
    rsStability: rs,
    totalPoints: data.length,
    linKKPct,
    semicircleLevel,
    noiseLevel,
    rsLevel,
    pointsLevel,
    linKKLevel,
  };
}

/** Compute BioFET quality metrics from analyte + baseline curves (see utils/fetQuality.ts). */
export const computeFETMetrics = computeFETQuality;

/** Compute SWV quality metrics from data + extracted peak metrics. */
function computeSWVMetrics(
  data: SWVDataPoint[],
  metrics: SWVMetrics | null | undefined,
) {
  if (!data || data.length < 5 || !metrics) {
    return {
      level: "idle" as Level,
      ready: false,
      peakDetected: false,
      snr: null as number | null,
      stepMv: null as number | null,
      pointsAcrossPeak: null as number | null,
      peakLevel: "idle" as Level,
      snrLevel: "idle" as Level,
      resolutionLevel: "idle" as Level,
    };
  }
  const peak = metrics.peakDetected;
  const snr = metrics.snr ?? null;
  const stepMv = estimateCVStepMv(data);
  const hw = metrics.halfPeakWidth_mV ?? null;
  const pointsAcrossPeak = stepMv != null && hw != null && hw > 0 ? hw / stepMv : null;

  const peakLevel: Level =
    peak && (snr ?? 0) >= 10
      ? "green"
      : peak
        ? "yellow" // peak detected but SNR unknown/low — still usable
        : "red";
  const snrLevel: Level =
    snr == null ? (peak ? "yellow" : "red") : snr >= 10 ? "green" : snr >= 3 ? "yellow" : "red";
  // Scan resolution: staircase step against the measured half-peak width. With
  // fewer than ~5 points across the peak, Ep and the peak height are quantised
  // by the step (at 50 mV steps Ep moved 30 mV in the simulator).
  const resolutionLevel: Level =
    pointsAcrossPeak == null
      ? "idle"
      : pointsAcrossPeak >= 10
        ? "green"
        : pointsAcrossPeak >= 5
          ? "yellow"
          : "red";

  // Half-peak width and noise-to-peak describe the redox system / repeat the SNR,
  // so they do not score the light (width stays in the SWV metrics grid).
  const level = worstOf([peakLevel, snrLevel, resolutionLevel]);
  return {
    level,
    ready: true,
    peakDetected: peak,
    snr,
    stepMv,
    pointsAcrossPeak,
    peakLevel,
    snrLevel,
    resolutionLevel,
  };
}

const DIAGNOSTICS: Record<Level, string> = {
  green: "Good Signal — electrode ready.",
  yellow: "Acceptable Signal — usable, but check fit/noise.",
  red: "Poor Signal — check electrode/connections.",
  idle: "Waiting for measurement data...",
};


const HEADLINES: Record<Level, string> = {
  green: "Good Signal",
  yellow: "Acceptable Signal",
  red: "Poor Signal",
  idle: "Idle",
};

/** Text equivalent of the colour coding, for assistive technologies. */
const LEVEL_TEXT: Record<Level, string> = {
  green: "good",
  yellow: "acceptable",
  red: "poor",
  idle: "not available",
};

interface MetricRowProps {
  label: string;
  value: string;
  level: Level;
}

const MetricRow = ({ label, value, level, title }: MetricRowProps & { title?: string }) => (
  <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
    <div className="flex items-center gap-2 min-w-0">
      <div
        className={`w-2 h-2 rounded-full shrink-0 ${dotClass(level)}`}
        role="img"
        aria-label={`${label} status: ${LEVEL_TEXT[level]}`}
      />
      <span className="text-[11px] font-mono text-muted-foreground truncate">
        {label}
        {title ? <InfoHint text={title} /> : null}
      </span>
    </div>
    <span className="text-xs font-mono text-foreground tabular-nums">{value}</span>
  </div>
);


const SignalQuality = ({ mode, eisData, fetBaseline, fetAnalyte, cnlsChiSquared, separatorZReal, separatorFreq, linKKResidualPct, linKKPassed, cvMetrics, cvNElectrons = 1, cvData, swvData, swvMetrics }: SignalQualityProps) => {
  const eisMetrics = useMemo(
    () => computeEISMetrics(eisData, cnlsChiSquared, separatorZReal, separatorFreq, linKKResidualPct, linKKPassed),
    [eisData, cnlsChiSquared, separatorZReal, separatorFreq, linKKResidualPct, linKKPassed],
  );
  const fetMetrics = useMemo(
    () => computeFETMetrics(fetAnalyte, fetBaseline),
    [fetAnalyte, fetBaseline]
  );

  const cvStepMv = useMemo(() => estimateCVStepMv(cvData), [cvData]);
  const cvLevels = useMemo(
    () => computeCVSignalQuality(cvMetrics ?? null, { stepMv: cvStepMv, n: cvNElectrons }),
    [cvMetrics, cvStepMv, cvNElectrons],
  );

  const swvQuality = useMemo(
    () => computeSWVMetrics(swvData ?? [], swvMetrics ?? null),
    [swvData, swvMetrics],
  );

  const rangeInfo = useMemo(
    () =>
      outOfRangeInfo(
        mode === "fet" ? [...fetBaseline, ...fetAnalyte]
        : mode === "cv" ? (cvData ?? [])
        : mode === "swv" ? (swvData ?? [])
        : [],
      ),
    [mode, fetBaseline, fetAnalyte, cvData, swvData],
  );
  const rangeLevel: Level = !rangeInfo.anyFlagPresent ? "idle" : rangeInfo.count > 0 ? "red" : "green";

  const m =
    mode === "eis" ? eisMetrics
    : mode === "fet" ? fetMetrics
    : mode === "cv" ? cvLevels
    : swvQuality;
  const level: Level = worstOf([m.level, rangeLevel]);
  const ready = m.ready;
  const pending = "Calculating...";
  const modeLabel = mode === "eis" ? "EIS" : mode === "fet" ? "BioFET" : mode === "cv" ? "CV" : "SWV";


  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Signal Quality
        </h3>
        <span className="text-[10px] font-mono text-muted-foreground">
          {modeLabel}
        </span>
      </div>

      {/* Traffic light */}
      <div className="flex items-center gap-4 mb-4 p-3 rounded-md bg-secondary/40">
        <div
          className="flex flex-col gap-2 p-2 rounded-md bg-background/60 border border-border"
          role="img"
          aria-label={`Overall signal quality: ${LEVEL_TEXT[level]}`}
        >
          {/* Unified semaphore order across EIS / BioFET / CV: green (top) → yellow → red (bottom). */}
          <div aria-hidden="true" className={`w-6 h-6 rounded-full transition-all ${lightClass("green", level === "green")}`} />
          <div aria-hidden="true" className={`w-6 h-6 rounded-full transition-all ${lightClass("yellow", level === "yellow")}`} />
          <div aria-hidden="true" className={`w-6 h-6 rounded-full transition-all ${lightClass("red", level === "red")}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-mono font-semibold text-foreground">
            {HEADLINES[level]}
          </div>
          <div className="text-[10px] text-muted-foreground mt-1 leading-snug">
            {mode === "cv" && level === "yellow"
              ? "Acceptable Signal — usable, but check peak detection, SNR and scan resolution."
              : DIAGNOSTICS[level]}
          </div>
        </div>
      </div>

      <div className="space-y-0">
        {mode === "eis" && (
          <>
            <MetricRow label="Semicircle Fit" title="How closely the points trace a smooth semicircle. ≥95% green, 85–95% yellow, below that red. Low values suggest noise or a badly placed separator." value={ready ? `${eisMetrics.semicircleFit.toFixed(1)} %` : pending} level={eisMetrics.semicircleLevel} />
            <MetricRow label="Residual Noise" title="Deviation from a smooth curve, as % of signal size. ≤3% green, 3–8% yellow, above that red." value={ready ? `${eisMetrics.pointNoise.toFixed(2)} %` : pending} level={eisMetrics.noiseLevel} />
            <MetricRow
              label="Lin-KK (RMS res.)"
              title="Lin-KK consistency: fit to a sum of M parallel RC elements. RMS residual ≤5% green, 5–10% yellow, above that red. Supports linear/causal/stable behavior in the measured range but does NOT prove a specific equivalent circuit."
              value={Number.isFinite(eisMetrics.linKKPct) ? `${eisMetrics.linKKPct.toFixed(2)} %` : "—"}
              level={eisMetrics.linKKLevel}
            />
            <MetricRow label="Rs (Ω)" title="Solution resistance, from the highest-frequency point. Typically 50–2000 Ω green, up to 5000 Ω yellow, outside that red. Should stay stable across repeat measurements." value={ready ? `${eisMetrics.rsStability.toFixed(0)} Ω` : pending} level={eisMetrics.rsLevel} />
            <MetricRow label="Total Points" title="Number of frequency points in this sweep — more points make the fit more reliable. ≥30 green, 15–29 yellow, fewer than 15 red." value={`${eisMetrics.totalPoints}`} level={eisMetrics.pointsLevel} />

          </>
        )}
        {mode === "fet" && (
          <>
            <MetricRow label="Ion / Ioff Ratio" title="On/off current ratio — higher means a cleaner switching response, independent of analyte binding. >100 green, >20 yellow, below that red." value={ready ? fetMetrics.ionIoff.toFixed(1) : pending} level={fetMetrics.ionLevel} />
            <MetricRow
              label="Subthreshold Slope"
              title="How sharply current turns on with gate voltage. Lower = sharper response. <200 mV/dec green, <400 mV/dec yellow, above that red. Approximate (quadratic fit)."
              value={ready ? (fetMetrics.subthresholdSlope > 0 ? `${fetMetrics.subthresholdSlope.toFixed(0)} mV/dec` : "—") : pending}
              level={fetMetrics.ssLevel}
            />
            <MetricRow label="Ioff Current" title="Off-state drain current. Should stay small and stable. Below 1 µA green, below 5 µA yellow, above that red." value={ready ? `${fetMetrics.ioff.toFixed(2)} µA` : pending} level={fetMetrics.ioffLevel} />

            <MetricRow label="Vt Window Points" title="Points of the strong-inversion window (20-80 % of Ion) the threshold voltage is fitted to. It depends on the gate-voltage step. 6 or more green, 4 to 5 yellow, fewer red (below 4 the square-root fit is refused and a less accurate constant-current method is used)." value={ready ? `${fetMetrics.windowPoints}` : pending} level={fetMetrics.windowLevel} />
            <MetricRow label="Baseline Noise" title="Scatter of the baseline curve around its smooth on-state trend (RMS of the residuals of a quadratic fit, as % of the mean current, on points above 30% of Ion). <5% green, <15% yellow, else red." value={ready && fetMetrics.stabilityLevel !== "idle" ? `${fetMetrics.baselineStability.toFixed(1)} %` : ready ? "—" : pending} level={fetMetrics.stabilityLevel} />
            {rangeInfo.anyFlagPresent && (
              <MetricRow
                label="HSTIA Range"
                title="Live hardware only: points where the AD5941's HSTIA output fell outside its usable 0.2-2.1V ADC window — the reported current for those points may be inaccurate. Pick a different RTIA Gain in Parameters if this appears."
                value={`${rangeInfo.count} / ${rangeInfo.total} out of range`}
                level={rangeLevel}
              />
            )}
            {fetMetrics.negativeCurrentWarning && (
              <div className="text-[10px] font-mono text-yellow-500 mt-1 leading-snug">
                ⚠ Ion/Ioff use |Id| — some Id values are negative.
              </div>
            )}
          </>
        )}
        {mode === "cv" && (
          <>
            <MetricRow label="Peaks Detected" title="Oxidation/reduction peaks found, out of 2 expected. Both found = green, one = yellow, none = red." value={cvMetrics ? `${(cvMetrics.hasAnodic ? 1 : 0) + (cvMetrics.hasCathodic ? 1 : 0)} / 2` : pending} level={cvLevels.peakLevel} />
            <MetricRow
              label="SNR (min)"
              title="min(SNR_anodic, SNR_cathodic) — corrected peak current ÷ noise estimate. ≥10 green, ≥3 yellow, below that red."
              value={cvMetrics ? `${Math.min(cvMetrics.SNR_anodic, cvMetrics.SNR_cathodic).toFixed(1)}` : pending}
              level={cvLevels.snrLevel}
            />
            <MetricRow
              label="Scan Resolution"
              title={`Potential step between points. A reversible peak pair is about 59/n mV wide (n=${cvNElectrons}), so the step sets how precisely Ep and ΔEp can be located. ≥10 points across that width green, ≥5 yellow, fewer red.`}
              value={cvStepMv != null ? `${cvStepMv.toFixed(cvStepMv < 10 ? 1 : 0)} mV step` : "—"}
              level={cvLevels.resolutionLevel}
            />
            {rangeInfo.anyFlagPresent && (
              <MetricRow
                label="HSTIA Range"
                title="Live hardware only: points where the AD5941's HSTIA output fell outside its usable 0.2-2.1V ADC window — the reported current for those points may be inaccurate. Pick a different RTIA Gain in Parameters if this appears."
                value={`${rangeInfo.count} / ${rangeInfo.total} out of range`}
                level={rangeLevel}
              />
            )}
          </>
        )}
        {mode === "swv" && (
          <>
            <MetricRow
              label="Peak detected"
              title="Whether a signed extremum clearing the minimum SNR and amplitude thresholds was found. Green requires a peak with SNR ≥10, yellow a peak with lower/unknown SNR, red no peak at all."
              value={ready ? (swvQuality.peakDetected ? "Yes" : "No") : pending}
              level={swvQuality.peakLevel}
            />
            <MetricRow
              label="SNR"
              title="Peak current (corrected) ÷ RMS noise from non-peak region. ≥10 green, ≥3 yellow, below that red."
              value={swvQuality.snr != null ? swvQuality.snr.toFixed(2) : ready ? "—" : pending}
              level={swvQuality.snrLevel}
            />
            <MetricRow
              label="Scan Resolution"
              title="Staircase step against the measured half-peak width. ≥10 points across the peak green, ≥5 yellow, fewer red: with too coarse a step the peak potential and height are quantised by the step."
              value={
                swvQuality.stepMv != null && swvQuality.pointsAcrossPeak != null
                  ? `${swvQuality.stepMv.toFixed(swvQuality.stepMv < 10 ? 1 : 0)} mV step · ${swvQuality.pointsAcrossPeak.toFixed(0)} pts/peak`
                  : ready ? "—" : pending
              }
              level={swvQuality.resolutionLevel}
            />
            {rangeInfo.anyFlagPresent && (
              <MetricRow
                label="HSTIA Range"
                title="Live hardware only: points where the AD5941's HSTIA output fell outside its usable 0.2-2.1V ADC window (forward and/or reverse pulse) — the reported current for those points may be inaccurate. Pick a different RTIA Gain in Parameters if this appears."
                value={`${rangeInfo.count} / ${rangeInfo.total} out of range`}
                level={rangeLevel}
              />
            )}
          </>
        )}

      </div>
    </div>
  );
};

export default SignalQuality;