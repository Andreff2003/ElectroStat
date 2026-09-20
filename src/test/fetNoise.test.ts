import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import SignalQuality from "@/components/SignalQuality";
import { fetOnStateNoisePct } from "@/utils/fetNoise";
import { fetDrainCurrent, KT_Q_300K } from "@/utils/fetModel";
import type { FETTransferPoint } from "@/hooks/useSimulatedData";

// Deterministic Gaussian noise (mulberry32 + Box-Muller) so the test is stable.
function rng(seed: number) {
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

/** Same curve the simulator uses (vt 0.3, idMax 50 µA, n = 2, 51 points). */
function curve(relNoise: number, absNoise: number, seed: number): FETTransferPoint[] {
  const r = rng(seed);
  const vt = 0.3;
  const K = 50 / (1.5 - vt) ** 2;
  return Array.from({ length: 51 }, (_, i) => {
    const vg = -0.5 + (2 * i) / 50;
    const id = fetDrainCurrent(vg, vt, { K, n: 2, vt_thermal: KT_Q_300K });
    return { vg, id: id + gauss(r) * (absNoise + relNoise * Math.abs(id)) };
  });
}

describe("fetOnStateNoisePct", () => {
  it("is ~0 on a noise-free curve (the quadratic fit removes the deterministic shape)", () => {
    expect(fetOnStateNoisePct(curve(0, 0, 1))!).toBeLessThan(1);
  });

  it("recovers the injected relative noise", () => {
    for (const [rel, lo, hi] of [
      [0.02, 1, 3.5],
      [0.1, 6, 14],
    ] as const) {
      const vals = [1, 2, 3, 4, 5, 6].map((s) => fetOnStateNoisePct(curve(rel, 0.005, s))!);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      expect(mean).toBeGreaterThan(lo);
      expect(mean).toBeLessThan(hi);
    }
  });

  it("ignores the absolute noise floor in the deep-off region (the old criterion read it as 8 %)", () => {
    const vals = [1, 2, 3, 4, 5, 6].map((s) => fetOnStateNoisePct(curve(0, 0.005, s))!);
    expect(Math.max(...vals)).toBeLessThan(1);
  });

  it("returns null when there are too few on-state points", () => {
    expect(fetOnStateNoisePct(curve(0, 0, 1).slice(0, 12))).toBeNull();
    expect(fetOnStateNoisePct([])).toBeNull();
  });
});

describe("SignalQuality BioFET — Baseline Noise and ΔVt", () => {
  const renderFet = (base: FETTransferPoint[], dVt = 0.1) =>
    render(
      createElement(SignalQuality, {
        mode: "fet",
        eisData: [],
        fetBaseline: base,
        fetAnalyte: base,
        fetVtBaseline: 0.3,
        fetVtAnalyte: 0.3 + dVt,
      }),
    );

  it("simulator-like data (2 % + 5 nA noise) grades green instead of acceptable", () => {
    renderFet(curve(0.02, 0.005, 3));
    expect(screen.getByText("Good Signal")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Baseline Noise status: good" })).toBeInTheDocument();
  });

  it("a genuinely noisy baseline (30 %) turns the light red", () => {
    renderFet(curve(0.3, 0.005, 3));
    expect(screen.getByRole("img", { name: "Baseline Noise status: poor" })).toBeInTheDocument();
    expect(screen.getByText("Poor Signal")).toBeInTheDocument();
  });

  it("ΔVt is informational: no colour status, and a blank does not change the light", () => {
    renderFet(curve(0.02, 0.005, 3), 0);
    expect(screen.getByRole("img", { name: "ΔVt: informational" })).toBeInTheDocument();
    expect(screen.getByText("Good Signal")).toBeInTheDocument();
  });
});
