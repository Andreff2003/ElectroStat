import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, renderHook, act } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";

// jsdom has no layout: give Recharts' ResponsiveContainer a fixed size so the chart is actually drawn.
vi.mock("recharts", async (importOriginal) => {
  const original = await importOriginal<typeof import("recharts")>();
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => cloneElement(children, { width: 800, height: 400 } as object),
  };
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

import CVPlot from "@/components/CVPlot";
import SWVPlot from "@/components/SWVPlot";
import FETTransferPlot from "@/components/FETTransferPlot";
import FETTimePlot from "@/components/FETTimePlot";
import NyquistPlot from "@/components/NyquistPlot";
import SignalQuality from "@/components/SignalQuality";
import { formatRtia, outOfRangeNoteText, OUT_OF_RANGE_COLOR } from "@/components/OutOfRange";
import { cvLegendModel, cvModelE0 } from "@/utils/cvLabels";
import { computeCVMetrics } from "@/utils/computeCVMetrics";
import { markSuspectPoints, usableForAnalysis, isFlagged, splitForPlot, lowSignalNote } from "@/utils/eisLowSignal";
import { buildEISExportText } from "@/utils/csvExport";
import { parseImportedCsv } from "@/utils/csvImport";
import { linKKTest } from "@/utils/linKK";
import { fitRandlesAuto } from "@/utils/randlesFit";
import type { CVDataPoint } from "@/hooks/useSimulatedCVData";
import type { EISDataPoint } from "@/hooks/useSimulatedData";
import type { SWVDataPoint } from "@/types/swv";
import { useSimulatedEIS } from "@/hooks/useSimulatedData";
import { EIS_1_FROM_LOG } from "./fixtures/eis1FromLog";

/**
 * Visual issues seen on live hardware data: the legend over the axis title, model names on a measurement, a
 * "Poor Signal" for fewer peaks than expected, points outside the ADC window drawn like any other, suspect EIS
 * points that no flag caught, the model E°′ line on a measurement, "Calculating..." on an idle card.
 */

// ─── helpers ───────────────────────────────────────────────────────────────

function cvCycles(cycles: number, withOutOfRange = 0): CVDataPoint[] {
  const out: CVDataPoint[] = [];
  let t = 0;
  for (let c = 1; c <= cycles; c++) {
    for (const branch of ["forward", "reverse"] as const) {
      for (let k = 0; k <= 160; k++) {
        const E = branch === "forward" ? -0.2 + 0.005 * k : 0.6 - 0.005 * k;
        const p: CVDataPoint = { E, I: (branch === "forward" ? 1 : -1) * (10 + 40 * Math.exp(-(((E - 0.25) / 0.06) ** 2))), cycle: c, t, branch };
        out.push(p);
        t += 0.1;
      }
    }
  }
  for (let i = 0; i < withOutOfRange; i++) out[20 + i].outOfRange = true;
  return out;
}

const chart = (container: HTMLElement) => container.querySelector(".recharts-wrapper") as HTMLElement;

/** The hollow red markers drawn on the chart. */
const outOfRangeMarkers = (container: HTMLElement) =>
  Array.from((container.querySelector(".recharts-wrapper") ?? container).querySelectorAll("circle")).filter((c) => c.getAttribute("stroke") === OUT_OF_RANGE_COLOR && c.getAttribute("fill") === "none");

// ─── 1. legend and axis title ──────────────────────────────────────────────

describe("CV legend", () => {
  it("is a row under the chart, not inside it, so it cannot cover the title of the x axis", () => {
    const { container } = render(<CVPlot data={cvCycles(3)} metrics={null} />);
    const legend = screen.getByTestId("cv-legend");
    expect(chart(container).contains(legend)).toBe(false);                       // outside the chart
    expect(container.querySelector(".recharts-legend-wrapper")).toBeNull();     // and no Recharts legend left
    expect(legend.compareDocumentPosition(chart(container)) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();   // after it in the layout
    expect(legend.className).toContain("flex-wrap");                              // many entries wrap onto more lines of their own
    expect(within(legend).getAllByRole("listitem")).toHaveLength(6);            // 3 cycles x forward / reverse
    expect(container.textContent).toContain("E / V vs reference");             // the axis title is still there
  });

  it("is absent with a single series, and in the compact dashboard cell", () => {
    const one = cvCycles(1).filter((p) => p.branch === "forward");
    const { rerender } = render(<CVPlot data={one} metrics={null} />);
    expect(screen.queryByTestId("cv-legend")).toBeNull();
    rerender(<CVPlot data={cvCycles(2)} metrics={null} compact />);
    expect(screen.queryByTestId("cv-legend")).toBeNull();
  });
});

// ─── 2. the model name only for simulated traces ───────────────────────────

describe("model name in the legend", () => {
  it("a measurement says 'Cycle 1 · forward', a simulated trace adds the model", () => {
    expect(cvLegendModel("live", "reversible")).toBeUndefined();
    expect(cvLegendModel("multichannel", "reversible")).toBeUndefined();
    expect(cvLegendModel("simulated", "reversible")).toBe("reversible");
    const live = render(<CVPlot data={cvCycles(2)} metrics={null} liveLabelSuffix={cvLegendModel("live", "reversible")} />);
    const entries = within(screen.getByTestId("cv-legend")).getAllByRole("listitem").map((li) => li.textContent);
    expect(entries).toContain("Cycle 1 · forward");
    expect(entries.join(" ")).not.toMatch(/reversible/);
    live.unmount();
    render(<CVPlot data={cvCycles(2)} metrics={null} liveLabelSuffix={cvLegendModel("simulated", "reversible")} />);
    expect(within(screen.getByTestId("cv-legend")).getAllByRole("listitem")[0].textContent).toBe("Cycle 1 · forward · reversible");
  });
});

// ─── 6. the model E°′ line ─────────────────────────────────────────────────

describe("model E°′ line", () => {
  const lines = (c: HTMLElement) => c.querySelectorAll(".recharts-reference-line");
  it("hidden for a measurement, drawn and labelled 'model E°′' for a simulated trace", () => {
    expect(cvModelE0("live", 0.22)).toBeUndefined();
    expect(cvModelE0("simulated", 0.22)).toBe(0.22);
    const live = render(<CVPlot data={cvCycles(1)} metrics={null} e0Prime={cvModelE0("live", 0.22)} />);
    expect(lines(live.container)).toHaveLength(0);
    live.unmount();
    const sim = render(<CVPlot data={cvCycles(1)} metrics={null} e0Prime={cvModelE0("simulated", 0.22)} />);
    expect(lines(sim.container)).toHaveLength(1);
    expect(sim.container.textContent).toContain("model E°′");
  });
});

// ─── 3. the signal-quality card ────────────────────────────────────────────

describe("CV signal quality card", () => {
  const data: CVDataPoint[] = cvCycles(1);
  const metrics = (over: Record<string, unknown> = {}) => ({
    IpaRaw: 50, IpcRaw: NaN, IpaCorrected: 50, IpcCorrected: NaN, Ipa: 50, Ipc: NaN, Epa: 0.25, Epc: NaN, E0prime: NaN,
    deltaEp: NaN, IpaIpcRatio: NaN, n_electrons: NaN, n_est_valid: false, D_apparent: NaN, D_valid: false,
    D_status: "invalid" as const, D_peak_source: "none" as const, reversibility: "irreversible" as const,
    baselineMethod: "per-branch-linear" as const, baselineMethodInput: "auto" as const,
    baselineResolvedMethod: "linear-first-15" as const, metricsCycle: 1, correctedDataAvailable: true,
    correctedDataCoversAllCycles: true, noise_uA: 0.1, SNR_anodic: 21, SNR_cathodic: 0.4,
    hasAnodic: true, hasCathodic: false, warnings: [], ...over,
  });
  const card = (m: ReturnType<typeof metrics>, cvData: CVDataPoint[] = data) =>
    render(<SignalQuality mode="cv" eisData={[]} fetBaseline={[]} fetAnalyte={[]} cvMetrics={m as never} cvNElectrons={1} cvData={cvData} />);

  it("one peak found with an SNR of 21 is a good signal, and the peaks are a neutral line", () => {
    card(metrics());
    expect(screen.getByText("Good Signal")).toBeInTheDocument();
    expect(screen.queryByText(/Poor Signal/)).toBeNull();
    expect(screen.queryByText(/electrode/i)).toBeNull();
    expect(screen.getByText("Peaks")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 found")).toBeInTheDocument();
  });

  it("no peaks at all on a dummy cell with plenty of current is not a poor signal either", () => {
    card(metrics({ hasAnodic: false, SNR_anodic: 0.3, IpaCorrected: NaN }));
    expect(screen.queryByText(/Poor Signal/)).toBeNull();
    expect(screen.getByText("0 of 2 found")).toBeInTheDocument();
  });

  it("the electrode is mentioned only when the current stays at about zero", () => {
    const flat = data.map((p) => ({ ...p, I: 0.01 * Math.sin(p.t) }));
    card(metrics({ hasAnodic: false, noise_uA: 0.01 }), flat);
    expect(screen.getByText("Poor Signal")).toBeInTheDocument();
    expect(screen.getByText(/check the electrode and the connections/i)).toBeInTheDocument();
  });

  it("points outside the ADC window make it poor, and the advice is the RTIA, not the electrode", () => {
    card(metrics(), cvCycles(1, 4));
    expect(screen.getByText("Poor Signal")).toBeInTheDocument();
    expect(screen.getByText(/use a lower RTIA gain/i)).toBeInTheDocument();
    expect(screen.queryByText(/electrode/i)).toBeNull();
  });

  it("a noisy trace is poor, with the noise as the reason", () => {
    card(metrics({ SNR_anodic: 1.5, hasCathodic: false }));
    expect(screen.getByText("Poor Signal")).toBeInTheDocument();
    expect(screen.getByText(/noise is high/i)).toBeInTheDocument();
  });
});

// ─── 7. EIS cards while idle ───────────────────────────────────────────────

describe("EIS signal quality card", () => {
  const sweep = (n: number): EISDataPoint[] =>
    Array.from({ length: n }, (_, i) => {
      const f = Math.pow(10, 5 - (i / Math.max(1, n - 1)) * 4);
      const w = 2 * Math.PI * f;
      const den = 1 + (w * 500 * 1e-6) ** 2;
      const zr = 100 + 500 / den;
      const zi = -(w * 500 * 500 * 1e-6) / den;
      return { zReal: zr, zImag: zi, frequency: f, zMag: Math.hypot(zr, zi), phase: (Math.atan2(zi, zr) * 180) / Math.PI };
    });
  const eisCard = (props: Partial<React.ComponentProps<typeof SignalQuality>>) =>
    render(<SignalQuality mode="eis" eisData={[]} fetBaseline={[]} fetAnalyte={[]} {...props} />);

  it("idle: a dash, never 'Calculating...'", () => {
    eisCard({ eisData: [] });
    expect(screen.queryByText("Calculating...")).toBeNull();
    for (const label of ["Semicircle Fit", "Residual Noise", "Rs (Ω)"]) {
      expect(screen.getByText(label).closest("div.flex.items-center.justify-between")).toHaveTextContent("—");
    }
  });

  it("a sweep in progress shows dashes until it has completed, then the numbers", () => {
    const data = sweep(36);
    const { rerender } = eisCard({ eisData: data, eisComplete: false });
    expect(screen.getByText("Semicircle Fit").closest("div.flex.items-center.justify-between")).toHaveTextContent("—");
    rerender(<SignalQuality mode="eis" eisData={data} fetBaseline={[]} fetAnalyte={[]} eisComplete />);
    expect(screen.getByText("Semicircle Fit").closest("div.flex.items-center.justify-between")).toHaveTextContent("%");
  });

  it("'Calculating...' only while a fit runs", () => {
    eisCard({ eisData: [], fitRunning: true });
    expect(screen.getAllByText("Calculating...").length).toBeGreaterThan(0);
  });
});

// ─── 4. points outside the ADC window ──────────────────────────────────────

describe("points outside the ADC window", () => {
  it("the note says how many, at which RTIA, and what to do", () => {
    expect(formatRtia(10000)).toBe("10 kΩ");
    expect(formatRtia(2500)).toBe("2.5 kΩ");
    expect(formatRtia(200)).toBe("200 Ω");
    expect(formatRtia(undefined)).toBe("the RTIA in use");
    expect(outOfRangeNoteText(0, 10000)).toBe("");
    expect(outOfRangeNoteText(1, 10000)).toBe("1 point outside the ADC window at RTIA 10 kΩ — use a lower RTIA gain");
    expect(outOfRangeNoteText(7, 10000)).toBe("7 points outside the ADC window at RTIA 10 kΩ — use a lower RTIA gain");
  });

  it("CV: a hollow red marker on each flagged point, and the note under the plot", () => {
    const { container } = render(<CVPlot data={cvCycles(1, 5)} metrics={null} rtiaOhms={10000} />);
    expect(outOfRangeMarkers(container)).toHaveLength(5);
    expect(screen.getByTestId("out-of-range-note")).toHaveTextContent("5 points outside the ADC window at RTIA 10 kΩ — use a lower RTIA gain");
  });

  it("CV: nothing extra when no point is flagged, and none in the compact cell", () => {
    const clean = render(<CVPlot data={cvCycles(1)} metrics={null} rtiaOhms={10000} />);
    expect(outOfRangeMarkers(clean.container)).toHaveLength(0);
    expect(screen.queryByTestId("out-of-range-note")).toBeNull();
    clean.unmount();
    const compact = render(<CVPlot data={cvCycles(1, 3)} metrics={null} rtiaOhms={10000} compact />);
    expect(outOfRangeMarkers(compact.container)).toHaveLength(0);
    expect(screen.queryByTestId("out-of-range-note")).toBeNull();
  });

  it("SWV: markers and the note", () => {
    const swv: SWVDataPoint[] = Array.from({ length: 30 }, (_, i) => ({
      E: -0.2 + i * 0.02, IForward: 2, IReverse: 1, INet: 1 + Math.sin(i / 4), time: i * 0.04, index: i, direction: "anodic" as const,
      ...(i === 5 || i === 6 ? { outOfRange: true } : {}),
    }));
    const { container } = render(<SWVPlot data={swv} rtiaOhms={2500} />);
    expect(outOfRangeMarkers(container)).toHaveLength(2);
    expect(screen.getByTestId("out-of-range-note")).toHaveTextContent("2 points outside the ADC window at RTIA 2.5 kΩ — use a lower RTIA gain");
  });

  it("BioFET: the transfer curve and the time response", () => {
    const base = Array.from({ length: 20 }, (_, i) => ({ vg: -0.5 + i * 0.1, id: i, ...(i === 3 ? { outOfRange: true } : {}) }));
    const ana = Array.from({ length: 20 }, (_, i) => ({ vg: -0.5 + i * 0.1, id: i + 1, ...(i === 18 || i === 19 ? { outOfRange: true } : {}) }));
    const t = render(<FETTransferPlot baseline={base} withAnalyte={ana} rtiaOhms={10000} />);
    expect(outOfRangeMarkers(t.container)).toHaveLength(3);
    expect(screen.getByTestId("out-of-range-note")).toHaveTextContent("3 points outside the ADC window at RTIA 10 kΩ");
    t.unmount();
    const time = Array.from({ length: 20 }, (_, i) => ({ time: i, id: 5 + i, ...(i > 15 ? { outOfRange: true } : {}) }));
    const r = render(<FETTimePlot data={time} rtiaOhms={10000} />);
    expect(outOfRangeMarkers(r.container)).toHaveLength(4);
    expect(screen.getByTestId("out-of-range-note")).toHaveTextContent("4 points outside the ADC window");
  });
});

// ─── 5. suspect EIS points ─────────────────────────────────────────────────

const toPoint = ([frequency, zReal, zImag, dftCal, dftMag]: readonly number[]): EISDataPoint => ({
  frequency, zReal, zImag, zMag: Math.hypot(zReal, zImag), phase: (Math.atan2(zImag, zReal) * 180) / Math.PI, dftCal, dftMag,
});
const eis1 = EIS_1_FROM_LOG.map(toPoint);
const flaggedFreqs = (pts: EISDataPoint[]) => markSuspectPoints(pts).filter((p) => p.suspect === true).map((p) => p.frequency);

describe("suspect EIS points", () => {
  it("EIS 1: 1.06 Hz, 0.76 Hz and 0.54 Hz are flagged, and no point from 100 kHz to 1.48 Hz is", () => {
    const flagged = flaggedFreqs(eis1);
    expect(flagged.map((f) => f.toFixed(2))).toEqual(["1.06", "0.76", "0.54"]);
    const marked = markSuspectPoints(eis1);
    expect(marked.filter((p) => p.frequency >= 1.48 && isFlagged(p))).toHaveLength(0);
    expect(marked).toHaveLength(37);
  });

  it("a sweep in either order and a point flagged by the firmware too give the same answer", () => {
    expect(flaggedFreqs([...eis1].reverse()).map((f) => f.toFixed(2)).sort()).toEqual(["0.54", "0.76", "1.06"]);
    const withLow = eis1.map((p, i) => (i === 10 ? { ...p, lowSignal: true } : p));
    expect(flaggedFreqs(withLow).map((f) => f.toFixed(2))).toEqual(["1.06", "0.76", "0.54"]);
  });

  it("the simulated sweeps (noise included) have no suspect point", () => {
    vi.useFakeTimers();
    try {
      for (const n of [36, 61, 121]) {
        const { result } = renderHook(() => useSimulatedEIS(5));
        act(() => { result.current.start(100, n, 0.1, 1e5); });
        act(() => { vi.advanceTimersByTime(5 * (n + 5)); });
        expect(result.current.data).toHaveLength(n);
        expect(markSuspectPoints(result.current.data).filter((p) => p.suspect === true)).toHaveLength(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a clean sweep has none, and the data object is returned as it is", () => {
    const clean = eis1.slice(0, 34);
    expect(markSuspectPoints(clean)).toBe(clean);
  });

  it("one point in the middle of a good sweep whose |Z| is 4x off is flagged", () => {
    const pts = eis1.slice(0, 20).map((p, i) => (i === 10 ? { ...p, zReal: p.zReal * 4, zImag: p.zImag * 4, zMag: p.zMag * 4 } : p));
    expect(flaggedFreqs(pts)).toEqual([pts[10].frequency]);
  });

  it("a point whose phase is 40° off from both neighbours is flagged; 25° is not", () => {
    const rot = (p: EISDataPoint, deg: number): EISDataPoint => {
      const a = Math.atan2(p.zImag, p.zReal) + (deg * Math.PI) / 180;
      return { ...p, zReal: p.zMag * Math.cos(a), zImag: p.zMag * Math.sin(a), phase: (a * 180) / Math.PI };
    };
    const base = eis1.slice(0, 20);
    expect(flaggedFreqs(base.map((p, i) => (i === 8 ? rot(p, 40) : p)))).toEqual([base[8].frequency]);
    expect(flaggedFreqs(base.map((p, i) => (i === 8 ? rot(p, 25) : p)))).toEqual([]);
  });

  it("the plots treat them like low-signal points: hidden, counted, and left out of the scale", () => {
    const s = splitForPlot(eis1, false);
    expect(s.lowCount).toBe(3);
    expect(s.suspectCount).toBe(3);
    expect(s.shown).toHaveLength(34);
    expect(lowSignalNote(s)).toBe("3 flagged points hidden (0 low signal, 3 out of line)");
    const { container } = render(<NyquistPlot data={eis1} />);
    expect(screen.getByTestId("low-signal-note")).toHaveTextContent("3 flagged points hidden (0 low signal, 3 out of line)");
    expect(container).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show low-signal points" }));
    expect(screen.getByTestId("low-signal-note")).toHaveTextContent("3 flagged points shown as hollow grey markers");
  });

  it("the fits and Lin-KK use the usable points only", () => {
    expect(usableForAnalysis(eis1)).toHaveLength(34);
    const withJunk = linKKTest(eis1);
    const clean = linKKTest(usableForAnalysis(eis1));
    expect(clean.residualRmsPct).toBeLessThan(withJunk.residualRmsPct);
    expect(fitRandlesAuto(usableForAnalysis(eis1))).not.toBeNull();
  });

  it("the export has a Suspect column, the analysis leaves them out, and the file loads back with the flags", () => {
    const text = buildEISExportText(eis1, "live", { measurementId: "eis_s" });
    const header = text.split("\n").find((l) => l.startsWith("Measurement ID;Channel"))!;
    expect(header.split(";").slice(-2)).toEqual(["Low signal", "Suspect"]);
    const rows = text.split("\n").filter((l) => l.startsWith("eis_s;"));
    expect(rows).toHaveLength(37);                                                  // every point is exported
    expect(rows.filter((l) => l.split(";")[14] === "Yes")).toHaveLength(3);
    expect(text).toMatch(/analysis_points_used;34/);
    expect(text).toMatch(/analysis_points_excluded_suspect;3/);
    const parsed = parseImportedCsv(text, "eis");
    if ("error" in parsed || parsed.mode !== "eis") throw new Error("not EIS");
    const back = parsed.measurements[0].points;
    expect(back.filter((p) => p.suspect === true).map((p) => p.frequency.toFixed(2))).toEqual(["1.06", "0.76", "0.54"]);
  });
});
