import { fetDrainCurrent, KT_Q_300K } from "@/utils/fetModel";
import type { FETTransferPoint } from "@/hooks/useSimulatedData";

/**
 * Seeded copy of the BioFET simulator's transfer-curve generator
 * (useSimulatedFETTransfer.buildPoints): same softplus model, same 51-point
 * gate sweep from -0.5 to 1.5 V, same Langmuir shift and the same noise model
 * (Gaussian, sigma = abs + rel*|Id|, clamped at 1e-6 uA), but with a
 * deterministic random stream so the numbers quoted in the thesis reproduce.
 */
export const FET_KD_NM = 25;
export const FET_VT0_V = 0.3;
export const FET_DVT_MAX_V = 0.4;
export const FET_ID_MAX_UA = 50;

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) =>
  Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());

export interface FETPairOptions {
  rel?: number;      // relative noise (default 0.02)
  abs?: number;      // absolute noise, uA (default 0.005)
  n?: number;        // ideality factor (default 2)
  leak?: number;     // constant leakage added to every point, uA
  noise?: boolean;   // false = noise-free
}

export const trueShift_mV = (c: number) => (c > 0 ? (1000 * FET_DVT_MAX_V * c) / (c + FET_KD_NM) : 0);

export function fetPair(c: number, seed: number, o: FETPairOptions = {}) {
  const r = rng(seed);
  const rel = o.rel ?? 0.02, abs = o.abs ?? 0.005, n = o.n ?? 2, leak = o.leak ?? 0;
  const K = FET_ID_MAX_UA / (1.5 - FET_VT0_V) ** 2;
  const mk = (vt: number): FETTransferPoint[] =>
    Array.from({ length: 51 }, (_, i) => {
      const vg = -0.5 + (2 * i) / 50;
      const id = fetDrainCurrent(vg, vt, { K, n, vt_thermal: KT_Q_300K }) + leak;
      const v = o.noise === false ? id : Math.max(id + gauss(r) * (abs + rel * Math.abs(id)), 1e-6);
      return { vg: Math.round(vg * 100) / 100, id: v };
    });
  return { baseline: mk(FET_VT0_V), analyte: mk(FET_VT0_V + trueShift_mV(c) / 1000) };
}

export const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
export const sd = (v: number[]) => {
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
};
