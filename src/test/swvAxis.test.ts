import { describe, it, expect } from "vitest";
import { swvCurrentAxis, formatSwvTick, swvOverlayLabel } from "@/utils/swvAxis";

describe("SWV current axis", () => {
  it("draws a nA-level sweep in nA, not as 0.00 µA on every tick", () => {
    // a 10 nM reversible peak is ~0.4 nA, i.e. a visible span of ~0.0004 µA
    const axis = swvCurrentAxis(0.0004);
    expect(axis.unit).toBe("nA");
    expect(axis.factor).toBe(1000);
    const ticks = [0, 0.0001, 0.0002, 0.0003, 0.0004].map((v) => formatSwvTick(v, axis));
    expect(new Set(ticks).size).toBe(ticks.length); // every tick is distinct
    expect(ticks[ticks.length - 1]).toBe("0.40");
  });

  it("keeps µA for currents of a few µA and above", () => {
    const axis = swvCurrentAxis(4);
    expect(axis.unit).toBe("µA");
    expect(axis.factor).toBe(1);
    expect(formatSwvTick(2.5, axis)).toBe("2.50");
  });

  it("switches at the same 0.01 µA cut-off the tooltip uses", () => {
    expect(swvCurrentAxis(0.0099).unit).toBe("nA");
    expect(swvCurrentAxis(0.01).unit).toBe("µA");
  });

  it("never prints a negative zero", () => {
    const axis = swvCurrentAxis(0.0004);
    expect(formatSwvTick(-1e-9, axis)).toBe("0.00");
  });

  it("falls back to a plain µA axis when there is no span", () => {
    expect(swvCurrentAxis(0)).toEqual({ unit: "µA", factor: 1, decimals: 2 });
  });
});

describe("SWV overlay labels", () => {
  it("names the concentration and the model", () => {
    expect(swvOverlayLabel(10, "reversible", 1)).toBe("10 nM · reversible");
    expect(swvOverlayLabel(10, "quasi-reversible", 2)).toBe("10 nM · quasi-reversible");
  });

  it("assumes the default reversible model when none is set", () => {
    expect(swvOverlayLabel(50, undefined, 1)).toBe("50 nM · reversible");
  });

  it("numbers blanks and keeps the model", () => {
    expect(swvOverlayLabel(0, "reversible", 3)).toBe("Blank 3 · reversible");
    expect(swvOverlayLabel(undefined, "quasi-reversible", 1)).toBe("Blank 1 · quasi-reversible");
  });
});
