import { toast } from "sonner";
import type { EISDataPoint } from "@/hooks/useSimulatedData";
import type { CVDataPoint } from "@/hooks/useSimulatedCVData";
import { parseImportedCsv } from "@/utils/csvImport";

// 8-color palette for overlays
export const OVERLAY_COLORS = [
  "hsl(160 70% 55%)",
  "hsl(30 90% 60%)",
  "hsl(200 80% 60%)",
  "hsl(280 70% 65%)",
  "hsl(50 90% 55%)",
  "hsl(340 80% 60%)",
  "hsl(120 60% 55%)",
  "hsl(0 75% 60%)",
];

export interface OverlayCurve {
  id: string;
  label: string;
  color: string;
  data: EISDataPoint[];
}

export interface CVOverlayCurve {
  id: string;
  label: string;
  color: string;
  data: CVDataPoint[];
}

export interface SWVOverlayCurve {
  id: string;
  label: string;
  color: string;
  data: import("@/types/swv").SWVDataPoint[];
}

export interface FETOverlayCurve {
  id: string;
  label: string;
  color: string;
  baseline: import("@/hooks/useSimulatedData").FETTransferPoint[];
  withAnalyte: import("@/hooks/useSimulatedData").FETTransferPoint[];
}

/**
 * Open a native file picker for a CSV previously exported by this app and
 * hand the parsed overlay data back through `onOk`. Used by EIS/CV/SWV
 * "Import CSV" buttons. This is visualization-only — no re-analysis, no
 * fitting; the parsed points are drawn verbatim as an overlay curve.
 */
export function importOverlayCsv(
  expected: "eis" | "cv" | "swv" | "fet_transfer" | "fet_time",
  onOk: (r: {
    mode: "eis" | "cv" | "swv" | "fet_transfer" | "fet_time";
    measurements: {
      id: string;
      concentration: number | null;
      points: unknown[];
      baseline?: unknown[];
      analyte?: unknown[];
      markers?: { time: number; label: string }[];
      label: string;
    }[];
    skipped: number;
    fileLabel: string;
  }) => void,
) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,text/csv";
  input.style.display = "none";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const r = parseImportedCsv(text, expected);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      const fileLabel = f.name.replace(/\.[^.]+$/, "");
      const multi = r.measurements.length > 1;
      const measurements = r.measurements.map((m, i) => {
        const suffix = m.concentration != null ? `${m.concentration} nM` : m.id;
        const baseLabel = multi ? `${fileLabel} · ${suffix}` : fileLabel;
        const chLabel = (m as { channelLabel?: string }).channelLabel;
        const label = chLabel ? `${chLabel} — ${baseLabel}` : baseLabel;
        if (r.mode === "fet_transfer") {
          const mm = m as import("@/utils/csvImport").ImportedFETTransferMeasurement;
          return { id: mm.id || `imported_${i}`, concentration: mm.concentration, points: [], baseline: mm.baseline, analyte: mm.analyte, label };
        }
        if (r.mode === "fet_time") {
          const mm = m as import("@/utils/csvImport").ImportedFETTimeMeasurement;
          return { id: mm.id || `imported_${i}`, concentration: mm.concentration, points: mm.points, markers: mm.markers, label };
        }
        const mm = m as { id: string; concentration: number | null; points: unknown[] };
        return { id: mm.id || `imported_${i}`, concentration: mm.concentration, points: mm.points, label };
      });
      onOk({ mode: r.mode, measurements, skipped: r.skipped, fileLabel });
      if (r.skipped > 0) {
        toast.warning(`${r.skipped} linha(s) inválida(s) descartadas.`);
      }
    } catch (err) {
      toast.error(
        `Falha ao ler CSV: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  input.click();
}

export type DashStatus = "idle" | "running" | "complete" | "error";

export function mapStatus(s: string): DashStatus {
  if (s === "running") return "running";
  if (s === "complete") return "complete";
  if (s === "error") return "error";
  return "idle";
}
