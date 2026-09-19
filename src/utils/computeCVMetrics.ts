import type { CVDataPoint } from "@/hooks/useSimulatedCVData";
import {
  CV_F,
  CV_R,
  CV_T_DEFAULT_K,
  CV_RS_PREFACTOR,
} from "@/utils/cvConstants";

export type CVReversibility = "reversible" | "quasi-reversible" | "irreversible";
export type BaselineMethod =
  | "per-branch-linear"
  | "partial-per-branch-linear"
  | "global-linear"
  | "linear-edges"
  | "none";
export type BaselineMethodInput =
  | "auto"
  | "none"
  | "linear-first-15"
  | "linear-edges";
export type BaselineResolvedMethod =
  | "linear-first-15"
  | "linear-edges"
  | "mixed"
  | "none";
export type DStatus = "valid" | "apparent" | "invalid";

export interface CVMetrics {
  // Raw (uncorrected) peak currents in µA
  IpaRaw: number;
  IpcRaw: number;
  // Baseline-corrected peak currents in µA
  IpaCorrected: number;
  IpcCorrected: number;
  // Backward-compat aliases — equal to the corrected values
  Ipa: number;
  Ipc: number;
  // Peak potentials in V
  Epa: number;
  Epc: number;
  E0prime: number;
  // Spread
  deltaEp: number;          // mV
  IpaIpcRatio: number;      // |Ipa/Ipc|
  // Derived parameters — NaN when not physically valid
  n_electrons: number;      // from 59.16 / ΔEp, only valid for reversible @25°C
  n_est_valid: boolean;
  D_apparent: number;       // cm²/s
  D_valid: boolean;
  D_status: DStatus;
  /** Which corrected peak(s) were fed into the Randles-Ševčík expression. */
  D_peak_source?: "anodic" | "cathodic" | "none";
  reversibility: CVReversibility;
  baselineMethod: BaselineMethod;
  baselineMethodInput: BaselineMethodInput;
  baselineResolvedMethod: BaselineResolvedMethod;
  metricsCycle: number;
  correctedDataAvailable: boolean;
  correctedDataCoversAllCycles: boolean;
  noise_uA: number;         // estimated noise (1.4826·MAD)
  SNR_anodic: number;       // |Ipa_corr| / noise
  SNR_cathodic: number;     // |Ipc_corr| / noise
  hasAnodic: boolean;
  hasCathodic: boolean;
  warnings: string[];
  correctedData?: CVDataPoint[]; // copy with baseline/Icorr fields populated
}

export interface CVMetricsInput {
  scanRate_mVs: number;
  n: number;
  cMM: number;
  areaCm2: number;
  baselineMethodInput?: BaselineMethodInput; // default "auto"
}

// Randles-Ševčík prefactor at 25 °C (0.4463 · F · sqrt(F/RT)) ≈ 268648.45
const F = CV_F;
const R = CV_R;
const TEMP_K = CV_T_DEFAULT_K;
export const RS_PREFACTOR = CV_RS_PREFACTOR;

/** Locate switching index by following the actual sign of dE/dt. */
function findSwitchIdx(sample: CVDataPoint[]): { switchIdx: number; goesPositive: boolean } {
  let dE0 = 0;
  for (let i = 1; i < sample.length; i++) {
    const d = sample[i].E - sample[0].E;
    if (Math.abs(d) > 1e-6) { dE0 = d; break; }
  }
  const goesPositive = dE0 > 0;
  let switchIdx = 0;
  if (goesPositive) {
    let m = sample[0].E;
    for (let i = 1; i < sample.length; i++) {
      if (sample[i].E > m) { m = sample[i].E; switchIdx = i; }
    }
  } else {
    let m = sample[0].E;
    for (let i = 1; i < sample.length; i++) {
      if (sample[i].E < m) { m = sample[i].E; switchIdx = i; }
    }
  }
  return { switchIdx, goesPositive };
}

/** Generic linear fit y = m·x + b through the supplied segment. */
function linearFit(seg: CVDataPoint[]): ((E: number) => number) | null {
  if (seg.length < 2) return null;
  const sx = seg.reduce((a, p) => a + p.E, 0);
  const sy = seg.reduce((a, p) => a + p.I, 0);
  const sxx = seg.reduce((a, p) => a + p.E * p.E, 0);
  const sxy = seg.reduce((a, p) => a + p.E * p.I, 0);
  const m = seg.length;
  const denom = m * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) {
    const mean = sy / m;
    return () => mean;
  }
  const slope = (m * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / m;
  return (E: number) => intercept + slope * E;
}

function fitBranchBaseline(
  branch: CVDataPoint[],
  method: BaselineMethodInput,
): ((E: number) => number) | null {
  if (method === "none" || branch.length < 4) return null;
  if (method === "linear-edges") {
    const nEdge = Math.max(2, Math.floor(branch.length * 0.1));
    const seg = [...branch.slice(0, nEdge), ...branch.slice(branch.length - nEdge)];
    return linearFit(seg);
  }
  // auto + linear-first-15
  const nFit = Math.max(3, Math.floor(branch.length * 0.15));
  return linearFit(branch.slice(0, nFit));
}

/**
 * Robust residual sigma (1.4826·MAD) of `seg` under fit `f`.
 * Returns NaN when the segment is too small or sigma cannot be computed.
 */
function fitRegionSigma(
  seg: CVDataPoint[],
  f: (E: number) => number,
): number {
  if (seg.length < 3) return NaN;
  const res = seg.map((p) => p.I - f(p.E));
  const sorted = [...res].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const abs = res.map((r) => Math.abs(r - med)).sort((a, b) => a - b);
  const mad = abs[Math.floor(abs.length / 2)];
  return 1.4826 * mad;
}

/**
 * Auto baseline picker — actually evaluates both candidates and picks the one
 * with lower residual sigma on its own fit region. Falls back gracefully.
 */
function autoPickBranchBaseline(branch: CVDataPoint[]): {
  fit: ((E: number) => number) | null;
  method: "linear-first-15" | "linear-edges" | "none";
} {
  if (branch.length < 4) return { fit: null, method: "none" };
  const n15 = Math.max(3, Math.floor(branch.length * 0.15));
  const seg15 = branch.slice(0, n15);
  const nEdge = Math.max(2, Math.floor(branch.length * 0.1));
  const segE = [...branch.slice(0, nEdge), ...branch.slice(branch.length - nEdge)];
  const f15 = linearFit(seg15);
  const fE = linearFit(segE);
  const s15 = f15 ? fitRegionSigma(seg15, f15) : NaN;
  const sE = fE ? fitRegionSigma(segE, fE) : NaN;
  const ok15 = !!f15 && Number.isFinite(s15);
  const okE = !!fE && Number.isFinite(sE);
  if (!ok15 && !okE) return { fit: null, method: "none" };
  if (ok15 && !okE) return { fit: f15!, method: "linear-first-15" };
  if (!ok15 && okE) return { fit: fE!, method: "linear-edges" };
  // Both valid — prefer linear-edges when its residual sigma is comparable
  // or smaller (edges captures sloping baselines that span the window).
  if (sE <= s15 * 1.10) return { fit: fE!, method: "linear-edges" };
  return { fit: f15!, method: "linear-first-15" };
}

/** Resolve a baseline fit for a single branch given the user-selected mode. */
function resolveBranchBaseline(
  branch: CVDataPoint[],
  input: BaselineMethodInput,
): {
  fit: ((E: number) => number) | null;
  method: "linear-first-15" | "linear-edges" | "none";
} {
  if (input === "none" || branch.length < 4) return { fit: null, method: "none" };
  if (input === "auto") return autoPickBranchBaseline(branch);
  const fit = fitBranchBaseline(branch, input);
  return fit
    ? { fit, method: input === "linear-edges" ? "linear-edges" : "linear-first-15" }
    : { fit: null, method: "none" };
}

/** 3-point boxcar smoothing — used only to locate the index of the peak. */
function smooth(branch: CVDataPoint[]): number[] {
  const out = branch.map((p) => p.I);
  for (let i = 1; i < branch.length - 1; i++) {
    out[i] = (branch[i - 1].I + branch[i].I + branch[i + 1].I) / 3;
  }
  return out;
}

/** 1.4826 · MAD of the residuals of `seg` vs `baseline(E)`. */
function noiseFromBranch(
  branch: CVDataPoint[],
  baseline: ((E: number) => number) | null,
): number {
  if (branch.length < 4) return 0;
  const nFit = Math.max(3, Math.floor(branch.length * 0.15));
  const seg = branch.slice(0, nFit);
  const residuals = seg.map((p) => p.I - (baseline ? baseline(p.E) : 0));
  const sorted = [...residuals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const absDev = residuals.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
  const mad = absDev[Math.floor(absDev.length / 2)];
  return 1.4826 * mad;
}

/**
 * Find an extremum on a branch (max for "anodic", min for "cathodic"),
 * ignoring the outer 5 % of points so we don't pick the ramp endpoints.
 */
function findPeak(
  branch: CVDataPoint[],
  baseline: ((E: number) => number) | null,
  kind: "anodic" | "cathodic",
): { Iraw: number; Icorr: number; E: number; idx: number } | null {
  if (branch.length < 5) return null;
  const sm = smooth(branch);
  const edge = Math.max(1, Math.floor(branch.length * 0.05));
  let bestIdx = -1;
  let bestVal = kind === "anodic" ? -Infinity : Infinity;
  for (let i = edge; i < branch.length - edge; i++) {
    const corr = baseline ? sm[i] - baseline(branch[i].E) : sm[i];
    if (kind === "anodic" ? corr > bestVal : corr < bestVal) {
      bestVal = corr;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const Iraw = branch[bestIdx].I;
  const Icorr = baseline ? Iraw - baseline(branch[bestIdx].E) : Iraw;
  return { Iraw, Icorr, E: branch[bestIdx].E, idx: bestIdx };
}

export function computeCVMetrics(
  data: CVDataPoint[],
  input: CVMetricsInput,
): CVMetrics | null {
  if (data.length < 10) return null;

  // Operate on the first cycle when available.
  const cyc1 = data.filter((d) => d.cycle === 1);
  const sample = cyc1.length >= 10 ? cyc1 : data;
  if (sample.length < 10) return null;
  const metricsCycle = cyc1.length >= 10 ? 1 : (sample[0]?.cycle ?? 1);

  const warnings: string[] = [];
  const baselineInput: BaselineMethodInput = input.baselineMethodInput ?? "auto";

  // Prefer the branch tags emitted by the simulator/hardware when present.
  const hasBranches = sample.some(
    (p) => p.branch === "forward" || p.branch === "reverse",
  );
  let fwd: CVDataPoint[];
  let rev: CVDataPoint[];
  let goesPositive: boolean;
  if (hasBranches) {
    fwd = sample.filter((p) => p.branch === "forward");
    rev = sample.filter((p) => p.branch === "reverse");
    if (fwd.length < 2 || rev.length < 2) {
      const fb = findSwitchIdx(sample);
      fwd = sample.slice(0, fb.switchIdx + 1);
      rev = sample.slice(fb.switchIdx);
      goesPositive = fb.goesPositive;
    } else {
      goesPositive = fwd[fwd.length - 1].E > fwd[0].E;
    }
  } else {
    const fb = findSwitchIdx(sample);
    fwd = sample.slice(0, fb.switchIdx + 1);
    rev = sample.slice(fb.switchIdx);
    goesPositive = fb.goesPositive;
  }

  // Per-branch baseline — actually evaluate candidates when "auto".
  const fwdResolved = resolveBranchBaseline(fwd, baselineInput);
  const revResolved = resolveBranchBaseline(rev, baselineInput);
  const fwdBase = fwdResolved.fit;
  const revBase = revResolved.fit;
  let baselineMethod: BaselineMethod;
  if (baselineInput === "none") {
    baselineMethod = "none";
    warnings.push("Baseline disabled");
  } else if (fwdBase && revBase) {
    baselineMethod =
      fwdResolved.method === "linear-edges" && revResolved.method === "linear-edges"
        ? "linear-edges"
        : "per-branch-linear";
  } else if (fwdBase || revBase) {
    baselineMethod = "partial-per-branch-linear";
    warnings.push("Baseline fallback used — only one branch fitted");
  } else {
    baselineMethod = "none";
    warnings.push("Baseline fit failed; using raw currents");
  }

  // Resolved auto method label (or echo of explicit input).
  let baselineResolvedMethod: BaselineResolvedMethod;
  if (baselineInput === "none" || (!fwdBase && !revBase)) {
    baselineResolvedMethod = "none";
  } else if (baselineInput === "linear-first-15") {
    baselineResolvedMethod = "linear-first-15";
  } else if (baselineInput === "linear-edges") {
    baselineResolvedMethod = "linear-edges";
  } else {
    // auto
    const a = fwdResolved.method;
    const b = revResolved.method;
    if (a === b && a !== "none") {
      baselineResolvedMethod = a;
      warnings.push(
        a === "linear-edges"
          ? "Auto baseline selected edge regions."
          : "Auto baseline selected first-15 region.",
      );
    } else if (a !== "none" && b !== "none") {
      baselineResolvedMethod = "mixed";
      warnings.push(
        `Auto baseline picked ${a} (forward) and ${b} (reverse).`,
      );
    } else {
      baselineResolvedMethod = (a !== "none" ? a : b) as BaselineResolvedMethod;
    }
  }

  // If the scan goes positive first, the anodic peak lives on the forward
  // branch and the cathodic peak on the reverse branch (and vice versa).
  const anodicBranch = goesPositive ? fwd : rev;
  const anodicBase = goesPositive ? fwdBase : revBase;
  const cathodicBranch = goesPositive ? rev : fwd;
  const cathodicBase = goesPositive ? revBase : fwdBase;

  const anodic = findPeak(anodicBranch, anodicBase ?? null, "anodic");
  const cathodic = findPeak(cathodicBranch, cathodicBase ?? null, "cathodic");

  // Estimate noise from residuals on each branch and combine.
  const noiseAn = noiseFromBranch(anodicBranch, anodicBase ?? null);
  const noiseCa = noiseFromBranch(cathodicBranch, cathodicBase ?? null);
  const noise_uA = Math.max(noiseAn, noiseCa);
  // SNR must remain finite for clean simulated curves where MAD≈0. Use a
  // fixed fallback noise floor so peak detection and SNR stay coherent.
  const FIXED_PEAK_THRESHOLD_UA = 0.05;
  const effectiveNoise_uA =
    Number.isFinite(noise_uA) && noise_uA > 0
      ? noise_uA
      : FIXED_PEAK_THRESHOLD_UA / 3;
  if (!(Number.isFinite(noise_uA) && noise_uA > 0)) {
    warnings.push(
      "Noise estimate unavailable or zero; SNR uses fixed fallback noise.",
    );
  }
  const peakThreshold_uA = Math.max(
    FIXED_PEAK_THRESHOLD_UA,
    3 * effectiveNoise_uA,
  );
  const hasAnodic = anodic != null && anodic.Icorr > peakThreshold_uA;
  const hasCathodic = cathodic != null && cathodic.Icorr < -peakThreshold_uA;
  const SNR_anodic = anodic ? Math.abs(anodic.Icorr) / effectiveNoise_uA : 0;
  const SNR_cathodic = cathodic ? Math.abs(cathodic.Icorr) / effectiveNoise_uA : 0;

  if (!hasAnodic) warnings.push("no clear anodic peak detected");
  if (!hasCathodic) warnings.push("no clear cathodic peak detected");

  const IpaRaw = anodic ? anodic.Iraw : NaN;
  const IpcRaw = cathodic ? cathodic.Iraw : NaN;
  const IpaCorrected = anodic ? anodic.Icorr : NaN;
  const IpcCorrected = cathodic ? cathodic.Icorr : NaN;
  const Epa = anodic ? anodic.E : NaN;
  const Epc = cathodic ? cathodic.E : NaN;
  const deltaEp = hasAnodic && hasCathodic ? Math.abs(Epa - Epc) * 1000 : NaN;
  const E0prime = hasAnodic && hasCathodic ? (Epa + Epc) / 2 : NaN;
  const IpaIpcRatio =
    hasAnodic && hasCathodic ? Math.abs(IpaCorrected / IpcCorrected) : NaN;

  // Randles-Ševčík — only when current/area/conc/scan are physical and the
  // system is at least quasi-reversible.
  const cBulk = input.cMM * 1e-6;
  const vVs = input.scanRate_mVs / 1000;
  let D_apparent = NaN;
  let D_valid = false;
  let D_peak_source: "anodic" | "cathodic" | "none" = "none";
  if (
    input.n > 0 &&
    input.areaCm2 > 0 &&
    cBulk > 0 &&
    vVs > 0
  ) {
    // Randles–Ševčík describes the peak of the FIRST sweep, which rises from a
    // flat baseline. The second peak sits on the decaying tail of the first
    // one and its baseline has to be extrapolated, which under-reads it by
    // ~5 % even on ideal data (that bias carried straight into D). So use the
    // first-sweep peak when it exists and the couple looks reversible-ish
    // (ratio 0.8–1.25); otherwise fall back to whichever peak exists.
    let ipaUseMicroA: number | null = null;
    const firstIsAnodic = goesPositive;
    const firstDetected = firstIsAnodic ? hasAnodic : hasCathodic;
    const firstPeak = firstIsAnodic ? IpaCorrected : Math.abs(IpcCorrected);
    if (hasAnodic && hasCathodic && firstDetected && firstPeak > 0) {
      const ratio = Math.abs(IpaCorrected / IpcCorrected);
      if (Number.isFinite(ratio) && ratio >= 0.8 && ratio <= 1.25) {
        ipaUseMicroA = firstPeak;
        D_peak_source = firstIsAnodic ? "anodic" : "cathodic";
      }
    }
    if (ipaUseMicroA == null && hasAnodic && IpaCorrected > 0) {
      ipaUseMicroA = IpaCorrected;
      D_peak_source = "anodic";
    }
    if (ipaUseMicroA == null && hasCathodic && Math.abs(IpcCorrected) > 0) {
      ipaUseMicroA = Math.abs(IpcCorrected);
      D_peak_source = "cathodic";
    }
    if (ipaUseMicroA != null) {
      const ipaA = ipaUseMicroA * 1e-6;
      const denom =
        RS_PREFACTOR *
        Math.pow(input.n, 1.5) *
        input.areaCm2 *
        cBulk *
        Math.sqrt(vVs);
      if (denom > 0) {
        D_apparent = Math.pow(ipaA / denom, 2);
        D_valid = true;
      }
    }
  }

  // Reversibility — compare to expected ΔEp for n electrons at 25 °C.
  const expectedDeltaEp = 59.16 / Math.max(1, input.n);
  let reversibility: CVReversibility;
  if (!hasAnodic || !hasCathodic) {
    reversibility = "irreversible";
  } else if (
    Math.abs(deltaEp - expectedDeltaEp) <= 20 &&
    IpaIpcRatio >= 0.9 &&
    IpaIpcRatio <= 1.1
  ) {
    reversibility = "reversible";
  } else if (deltaEp <= expectedDeltaEp + 200 && IpaIpcRatio >= 0.7 && IpaIpcRatio <= 1.3) {
    reversibility = "quasi-reversible";
  } else {
    reversibility = "irreversible";
  }

  // D status: only "valid" for fully reversible systems.
  let D_status: DStatus = "invalid";
  if (D_valid && reversibility === "reversible") {
    D_status = "valid";
  } else if (D_valid && reversibility === "quasi-reversible") {
    D_status = "apparent";
    warnings.push(
      "D apparent assumes reversible diffusion-controlled CV; value is informational for quasi-reversible data.",
    );
  } else if (!D_valid) {
    warnings.push("D apparent unavailable: reversible valid peaks required.");
  } else {
    D_status = "invalid";
    D_apparent = NaN;
    D_valid = false;
    D_peak_source = "none";
    warnings.push("D apparent suppressed — system is irreversible");
  }
  // Backward compat: keep D_valid true only when status is valid.
  D_valid = D_status === "valid";

  // n estimate — only meaningful for clean reversible diffusion-controlled
  // systems near 25 °C.
  let n_electrons = NaN;
  let n_est_valid = false;
  if (
    hasAnodic &&
    hasCathodic &&
    deltaEp > 0 &&
    reversibility === "reversible" &&
    IpaIpcRatio >= 0.9 &&
    IpaIpcRatio <= 1.1
  ) {
    n_electrons = 59.16 / deltaEp;
    n_est_valid = true;
  }

  // Build corrected data covering ALL cycles (same length & order as `data`).
  // Uses the same baseline input for every cycle so the UI/CSV stays
  // consistent across multi-cycle sweeps.
  let correctedData: CVDataPoint[] | undefined;
  let correctedDataCoversAllCycles = false;
  if (baselineInput !== "none") {
    correctedData = new Array<CVDataPoint>(data.length);
    const cycles = new Map<number, number[]>();
    data.forEach((p, i) => {
      const arr = cycles.get(p.cycle) ?? [];
      arr.push(i);
      cycles.set(p.cycle, arr);
    });
    let anyMissing = false;
    for (const [, idxs] of cycles) {
      const pts = idxs.map((i) => data[i]);
      const hasBr = pts.some(
        (p) => p.branch === "forward" || p.branch === "reverse",
      );
      let fwdC: CVDataPoint[];
      let revC: CVDataPoint[];
      if (hasBr) {
        fwdC = pts.filter((p) => p.branch === "forward");
        revC = pts.filter((p) => p.branch === "reverse");
        if (fwdC.length < 2 || revC.length < 2) {
          const fb = findSwitchIdx(pts);
          fwdC = pts.slice(0, fb.switchIdx + 1);
          revC = pts.slice(fb.switchIdx);
        }
      } else {
        const fb = findSwitchIdx(pts);
        fwdC = pts.slice(0, fb.switchIdx + 1);
        revC = pts.slice(fb.switchIdx);
      }
      const fwdR = resolveBranchBaseline(fwdC, baselineInput);
      const revR = resolveBranchBaseline(revC, baselineInput);
      const fwdSet = new Set(fwdC);
      for (let k = 0; k < idxs.length; k++) {
        const i = idxs[k];
        const p = data[i];
        const isFwd = hasBr ? p.branch === "forward" : fwdSet.has(p);
        const base = isFwd ? fwdR.fit : revR.fit;
        if (!base) {
          correctedData[i] = { ...p };
          anyMissing = true;
        } else {
          const bl = base(p.E);
          correctedData[i] = { ...p, baseline: bl, Icorr: p.I - bl };
        }
      }
    }
    correctedDataCoversAllCycles = !anyMissing;
    if (anyMissing) {
      warnings.push("Baseline unavailable for one or more cycles.");
    }
  }
  const correctedDataAvailable =
    !!correctedData && correctedData.some((p) => Number.isFinite(p.Icorr));

  return {
    IpaRaw,
    IpcRaw,
    IpaCorrected,
    IpcCorrected,
    Ipa: IpaCorrected,
    Ipc: IpcCorrected,
    Epa,
    Epc,
    E0prime,
    deltaEp,
    IpaIpcRatio,
    n_electrons,
    n_est_valid,
    D_apparent,
    D_valid,
    D_status,
    D_peak_source,
    reversibility,
    baselineMethod,
    baselineMethodInput: baselineInput,
    baselineResolvedMethod,
    metricsCycle,
    correctedDataAvailable,
    correctedDataCoversAllCycles,
    noise_uA,
    SNR_anodic,
    SNR_cathodic,
    hasAnodic,
    hasCathodic,
    warnings,
    correctedData,
  };
}
