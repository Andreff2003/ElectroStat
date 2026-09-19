import { describe, it, expect } from "vitest";
import {
  sanitizeCVMeasurementNotes,
  newCVMeasurementId,
  hasAnyNotes,
  shortNotesSummary,
  type CVMeasurementNotes,
} from "@/utils/cvMeasurementNotes";
import { buildCVExportText } from "@/utils/csvExport";
import {
  buildCVCalibrationPoint,
  summarizeCalibration,
  type CVCalibrationPoint,
} from "@/utils/cvCalibration";
import { computeCVMetrics } from "@/utils/computeCVMetrics";
import { simulateReversibleDiffusionCV } from "@/utils/cvDiffusionSolver";
import {
  CV_SOLVER_DEFAULT_STEP_V,
  CV_SOLVER_DEFAULT_SPATIAL_NODES,
  CV_SOLVER_DOMAIN_RULE,
} from "@/utils/cvConstants";

const baseCVExport = {
  scanRate: 100,
  eStart: 0.6,
  eVertex1: -0.2,
  eVertex2: 0.6,
  nCycles: 1,
  n: 1,
  cMM: 5,
  areaCm2: 0.0707,
  cvModel: "reversible",
};

describe("CV solver constants are centralised", () => {
  it("solver defaults are exported and match expected values", () => {
    expect(CV_SOLVER_DEFAULT_STEP_V).toBe(0.002);
    expect(CV_SOLVER_DEFAULT_SPATIAL_NODES).toBe(2500);
    expect(CV_SOLVER_DOMAIN_RULE).toContain("sqrt");
  });
});

describe("CV measurement id + notes sanitisation", () => {
  it("newCVMeasurementId has the expected shape", () => {
    const id = newCVMeasurementId(new Date(2026, 5, 17, 14, 35, 12));
    expect(id).toMatch(/^cv_20260617_143512_[a-z0-9]{1,5}$/);
  });

  it("sanitise drops empty/whitespace fields and limits sizes", () => {
    const raw: CVMeasurementNotes = {
      title: "  Hello  ",
      operator: "",
      sampleId: "S-1",
      analyte: "    ",
      temperature_C: 25.3,
      pH: Number.NaN,
      notes: "a".repeat(7000),
      tags: ["one", "  two  ", "", "x".repeat(50), ...Array(20).fill("t")],
    };
    const out = sanitizeCVMeasurementNotes(raw)!;
    expect(out.title).toBe("Hello");
    expect(out.operator).toBeUndefined();
    expect(out.sampleId).toBe("S-1");
    expect(out.analyte).toBeUndefined();
    expect(out.temperature_C).toBe(25.3);
    expect(out.pH).toBeUndefined();
    expect(out.notes!.length).toBe(5000);
    expect(out.tags!.length).toBeLessThanOrEqual(10);
    expect(out.tags![3].length).toBeLessThanOrEqual(40);
  });

  it("returns undefined when nothing useful is provided", () => {
    expect(sanitizeCVMeasurementNotes(undefined)).toBeUndefined();
    expect(sanitizeCVMeasurementNotes({})).toBeUndefined();
    expect(sanitizeCVMeasurementNotes({ title: "   " })).toBeUndefined();
  });

  it("hasAnyNotes / shortNotesSummary helpers", () => {
    expect(hasAnyNotes(undefined)).toBe(false);
    expect(hasAnyNotes({ title: "" })).toBe(false);
    expect(hasAnyNotes({ title: "x" })).toBe(true);
    expect(shortNotesSummary({ sampleId: "S-1", notes: "abc\n\nz" })).toContain("S-1");
    expect(shortNotesSummary(undefined)).toBe("");
  });
});

describe("buildCVExportText — solver + logbook metadata", () => {
  const pts = simulateReversibleDiffusionCV({
    eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6,
    scanRate_mVs: 100, nCycles: 1, n: 1, areaCm2: 0.0707, cMM: 5,
  });
  const m = computeCVMetrics(pts, {
    scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707,
  });

  it("contains solver traceability metadata", () => {
    const text = buildCVExportText(pts, m, baseCVExport, "simulated", "raw");
    for (const key of [
      "simulation_model",
      "solver_type",
      "solver_step_V",
      "solver_spatial_nodes",
      "solver_D_cm2_s",
      "solver_temperature_K",
      "solver_E0prime_V",
      "solver_domain_rule",
    ]) {
      expect(text).toContain(key);
    }
    expect(text).toContain("reversible-diffusion");
    expect(text).toContain("implicit-diffusion-nernst");
    expect(text).toContain("L = 6*sqrt(D*tMax)");
  });

  it("embeds logbook fields and survives multiline notes", () => {
    const notes: CVMeasurementNotes = {
      title: "Aptamer batch A3",
      sampleId: "S-014",
      electrodeId: "SPE-A3",
      operator: "RM",
      notes: "PBS pH 7.4\nelectrode cleaned with DI water\n10 min incubation",
      tags: ["aptamer", "trial-1"],
      analyte: "Thrombin",
      electrolyte: "PBS pH 7.4",
      temperature_C: 25,
      pH: 7.4,
    };
    const text = buildCVExportText(
      pts, m,
      {
        ...baseCVExport,
        notes,
        measurementId: "cv_20260617_143512_abcd",
        measurementTimestamp: Date.parse("2026-06-17T12:35:12Z"),
      },
      "simulated", "raw",
    );
    expect(text).toContain("Aptamer batch A3");
    expect(text).toContain("S-014");
    expect(text).toContain("SPE-A3");
    expect(text).toContain("aptamer|trial-1");
    expect(text).toContain("Thrombin");
    expect(text).toContain("PBS pH 7.4 | electrode cleaned with DI water | 10 min incubation");
    expect(text).toContain("cv_20260617_143512_abcd");
    // Multi-line notes must NOT introduce stray rows in the CSV body.
    const notesLine = text.split("\n").find((l) => l.startsWith("notes;"));
    expect(notesLine).toBeDefined();
    expect(notesLine!.split("\n").length).toBe(1);
  });

  it("works when no notes are provided (retrocompat)", () => {
    const text = buildCVExportText(pts, m, baseCVExport, "simulated", "raw");
    expect(text).toContain("notes;N/A");
    expect(text).toContain("sample_id;N/A");
  });
});

describe("CV calibration — measurement traceability", () => {
  it("buildCVCalibrationPoint preserves measurementId / sample / electrode", () => {
    const m = computeCVMetrics(
      simulateReversibleDiffusionCV({
        eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6,
        scanRate_mVs: 100, nCycles: 1, n: 1, areaCm2: 0.0707, cMM: 5,
      }),
      { scanRate_mVs: 100, n: 1, cMM: 5, areaCm2: 0.0707 },
    );
    const pt = buildCVCalibrationPoint(5, m, "reversible", {
      measurementId: "cv_xyz",
      sampleId: "S-1",
      electrodeId: "E-1",
      notes: "trial",
      timestamp: 1234567890,
    });
    expect(pt.measurementId).toBe("cv_xyz");
    expect(pt.sampleId).toBe("S-1");
    expect(pt.electrodeId).toBe("E-1");
    expect(pt.notes).toBe("trial");
    expect(pt.timestamp).toBe(1234567890);
  });

  it("retrocompat — calibration summary still works without traceability fields", () => {
    const pts: CVCalibrationPoint[] = [0, 1, 2, 5].map((c) =>
      buildCVCalibrationPoint(
        c,
        computeCVMetrics(
          simulateReversibleDiffusionCV({
            eStart: 0.6, eVertex1: -0.2, eVertex2: 0.6,
            scanRate_mVs: 100, nCycles: 1, n: 1, areaCm2: 0.0707, cMM: c,
          }),
          { scanRate_mVs: 100, n: 1, cMM: c, areaCm2: 0.0707 },
        ),
        "reversible",
      ),
    );
    const summary = summarizeCalibration(pts, "mean");
    expect(summary.fit).not.toBeNull();
    expect(summary.fit!.slope).toBeGreaterThan(0);
    expect(summary.fit!.r2).toBeGreaterThan(0.98);
  });
});
