import { Hint, InfoHint } from "@/components/InfoHint";
import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import SWVMode, { type SWVController } from "@/components/helpstat/SWVMode";
import type { SWVParameters } from "@/types/swv";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import NyquistPlot from "@/components/NyquistPlot";
import BodePlot from "@/components/BodePlot";
import FETTransferPlot from "@/components/FETTransferPlot";
import FETTimePlot from "@/components/FETTimePlot";
import SWVPlot from "@/components/SWVPlot";
import StatusIndicator from "@/components/StatusIndicator";
import ConnectionPanel from "@/components/ConnectionPanel";
import MultiChannelPanel, { type Channel } from "@/components/MultiChannelPanel";
import MultiChannelView from "@/components/MultiChannelView";
import SignalQuality from "@/components/SignalQuality";
import SweepProgress, { type SweepStatus } from "@/components/SweepProgress";
import {
  useSimulatedEIS,
  useSimulatedFETTransfer,
  useSimulatedFETTime,
} from "@/hooks/useSimulatedData";
import { useSimulatedCVData, CV_E0_PRIME } from "@/hooks/useSimulatedCVData";
import { useSWVModeState } from "@/hooks/useSWVModeState";
import CVPlot from "@/components/CVPlot";
import { DashboardCell } from "@/components/DashboardCell";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DummyCellCheck } from "@/components/DummyCellCheck";

import type { CVDataPoint } from "@/hooks/useSimulatedCVData";
import { computeCVMetrics } from "@/utils/computeCVMetrics";
import { analyzeSWV } from "@/utils/swvMetrics";
import {
  exportEISData,
  exportFETTransferData,
  exportFETTimeData,
  exportFETData,
  exportSessionCSV,
  exportCalibrationCSV as exportCalibrationTSV,
  exportCVData,
  exportCVCalibrationCSV,
} from "@/utils/csvExport";
import { useWebSocketData, useChannelReconnect } from "@/hooks/useWebSocketData";
import ParametersPanel, {
  DEFAULT_EIS_PARAMS,
  DEFAULT_FET_PARAMS,
  DEFAULT_CV_PARAMS,
  computeEISPointCount,
  type EISParams,
  type FETParams,
  type CVParams,
} from "@/components/ParametersPanel";
import CalibrationPanel, {
  type CalibrationPoint,
  computeEISParams,
  computeFETVt,
} from "@/components/CalibrationPanel";
import { computeFETVtDetailed } from "@/utils/fetVt";
import {
  computeFETTransferMetrics,
  inferFETResponseSign,
  applyFETResponseMode,
  type FETResponseMode,
} from "@/utils/fetMetrics";
import CVCalibrationPanel from "@/components/CVCalibrationPanel";
import MeasurementNotesPanel from "@/components/MeasurementNotesPanel";
import {
  buildCVCalibrationPoint,
  randlesSevcikIpUA,
  responseFor,
  type CVCalibrationPoint,
  type CVResponseMode,
} from "@/utils/cvCalibration";
import {
  createMeasurementId,
  sanitizeMeasurementNotes,
  shortNotesSummary,
  hasAnyNotes,
  type MeasurementNotes,
} from "@/utils/measurementNotes";


import CNLSFitResults from "@/components/CNLSFitResults";
import {
  fitRandles,
  fitRandlesAuto,
  splitRegionsAuto,
  extractWarburgSlope,
  kramersKronigTest,
  type RandlesFitResult,
  type WarburgResult,
  type KKResult,
} from "@/utils/randlesFit";
import { linKKTest, type LinKKResult } from "@/utils/linKK";
import { fitEIS, type CircuitModel, type EISFitResult } from "@/utils/eisFit";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  loadSession,
  saveSessionDebounced,
  clearSession,
  newId,
  type StoredMeasurement,
  type StoredEISMeasurement,
  type StoredFETMeasurement,
  type StoredCVMeasurement,
  type StoredSWVMeasurement,
} from "@/utils/sessionStore";
import { logActivity, clearActivityLog } from "@/utils/activityLog";
import type { EISDataPoint } from "@/hooks/useSimulatedData";
import { type DemoPhase, PHASE_ORDER, PHASE_LABEL } from "@/components/helpstat/demoPhases";
import DashboardHeader from "@/components/helpstat/DashboardHeader";
import {
  OVERLAY_COLORS,
  importOverlayCsv,
  mapStatus,
  type OverlayCurve,
  type CVOverlayCurve,
  type SWVOverlayCurve,
  type FETOverlayCurve,
  type DashStatus,
} from "@/components/helpstat/indexPageHelpers";

const Index = () => {
  const [mode, setMode] = useState<"eis" | "fet" | "cv" | "swv" | "dashboard">("eis");
  const [dataSource, setDataSource] = useState<"simulated" | "live" | "multichannel">("simulated");
  const [multiChannelLayout, setMultiChannelLayout] = useState<"combined" | "separate">("combined");
  const [channels, setChannels] = useState<Channel[]>([
    { id: 1, label: "Sensor 1", url: "ws://127.0.0.1:81", enabled: true, color: OVERLAY_COLORS[0], autoReconnect: true },
    { id: 2, label: "Sensor 2", url: "ws://127.0.0.1:82", enabled: false, color: OVERLAY_COLORS[1], autoReconnect: true },
    { id: 3, label: "Sensor 3", url: "ws://127.0.0.1:83", enabled: false, color: OVERLAY_COLORS[2], autoReconnect: true },
  ]);
  const [hasAttemptedConnection, setHasAttemptedConnection] = useState(false);
  const [eisParams, setEisParams] = useState<EISParams>(DEFAULT_EIS_PARAMS);
  const [fetParams, setFetParams] = useState<FETParams>(DEFAULT_FET_PARAMS);
  const [cvParams, setCvParams] = useState<CVParams>(DEFAULT_CV_PARAMS);
  const [swvParams, setSwvParams] = useState<SWVParameters>({
    startE: -0.2, endE: 0.6, step_mV: 2, amplitude_mV: 25, frequency_Hz: 25,
    quietTime_s: 2, direction: "anodic", concentration_nM: 10, area_cm2: 0.0707,
    nElectrons: 1, temperature_K: 298.15, baselineMethod: "auto",
    // `swvModel` is what the solver actually reads; the old `model:
    // "empirical_peak"` selected nothing and mislabelled stored sessions.
    smoothing: "none", swvModel: "reversible",
    diffusionCoeff: 7.26e-6, formalPotential: 0.22, k0: 0.01, alpha: 0.5,
  });
  const [swvCtrl, setSwvCtrl] = useState<SWVController | null>(null);

  // Concentration & Calibration state (per mode)
  const [concentration, setConcentration] = useState<number>(0);
  const [eisCalibration, setEisCalibration] = useState<CalibrationPoint[]>([]);
  const [fetCalibration, setFetCalibration] = useState<CalibrationPoint[]>([]);
  const [cvCalibration, setCvCalibration] = useState<CVCalibrationPoint[]>([]);
  const [cvResponseMode, setCvResponseMode] = useState<CVResponseMode>("mean");
  const [fetResponseMode, setFetResponseMode] = useState<FETResponseMode>("auto");

  // Randles equivalent-circuit fit + Warburg slope (computed on sweep complete)
  const [randlesFit, setRandlesFit] = useState<RandlesFitResult | null>(null);
  const [warburg, setWarburg] = useState<WarburgResult | null>(null);
  const [kk, setKk] = useState<KKResult | null>(null);
  const [linKK, setLinKK] = useState<LinKKResult | null>(null);
  const [geometricFallback, setGeometricFallback] = useState(false);

  // Manual semicircle/Warburg separator (set after sweep completes)
  const [separatorZReal, setSeparatorZReal] = useState<number | null>(null);
  const [eisFitted, setEisFitted] = useState(false);

  // Scientific CNLS fit (Randles or Randles + CPE)
  const [circuitModel, setCircuitModel] = useState<CircuitModel>("randles");
  const [cnlsFit, setCnlsFit] = useState<EISFitResult | null>(null);


  // Overlay mode (Nyquist)
  const [overlayMode, setOverlayMode] = useState(false);
  const [eisOverlays, setEisOverlays] = useState<OverlayCurve[]>([]);

  // Overlay mode (CV)
  const [cvOverlayMode, setCvOverlayMode] = useState(false);
  const [cvOverlays, setCvOverlays] = useState<CVOverlayCurve[]>([]);

  // Overlay mode (BioFET)
  const [fetOverlayMode, setFetOverlayMode] = useState(false);
  const [fetOverlays, setFetOverlays] = useState<FETOverlayCurve[]>([]);
  const [fetTimeOverlays, setFetTimeOverlays] = useState<import("@/components/FETTimePlot").FETTimeOverlay[]>([]);
  // Overlay curves for SWV live in the parent so they survive mode switches
  // (SWVMode is conditionally mounted).
  const [swvOverlays, setSwvOverlays] = useState<SWVOverlayCurve[]>([]);

  // Guided demo state (declared early so completion handlers can read it).
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoStep, setDemoStep] = useState(0);
  const [demoPhase, setDemoPhase] = useState<DemoPhase>("idle");
  const demoCancelledRef = useRef(false);

  const [cvPlotMode, setCvPlotMode] = useState<"raw" | "corrected">("raw");
  const [cvBaselineMethod, setCvBaselineMethod] = useState<
    "auto" | "none" | "linear-first-15" | "linear-edges"
  >("auto");
  const [cvShowBaseline, setCvShowBaseline] = useState(false);

  // Live CV state — separate from the simulated hook so the live ESP32 path
  // does not depend on cv.isRunning (which is tied to the simulator).
  const [isLiveCVRunning, setIsLiveCVRunning] = useState(false);

  // ──────────────────────────────────────────────────────────────
  // CV Logbook / Notes — pure metadata. Never sent to hardware,
  // never influences solver / baseline / metrics.
  // ──────────────────────────────────────────────────────────────
  const [cvNotes, setCvNotes] = useState<MeasurementNotes>({});
  const [cvPreviousNotes, setCvPreviousNotes] = useState<MeasurementNotes | null>(null);
  // IDs/timestamps minted on the client to avoid SSR/CSR hydration mismatches.
  const [cvMeasurementId, setCvMeasurementId] = useState<string>("");
  const [cvMeasurementTimestamp, setCvMeasurementTimestamp] = useState<number>(0);

  // EIS Logbook
  const [eisNotes, setEisNotes] = useState<MeasurementNotes>({});
  const [eisPreviousNotes, setEisPreviousNotes] = useState<MeasurementNotes | null>(null);
  const [eisMeasurementId, setEisMeasurementId] = useState<string>("");
  const [eisMeasurementTimestamp, setEisMeasurementTimestamp] = useState<number>(0);

  // BioFET Logbook
  const [fetNotes, setFetNotes] = useState<MeasurementNotes>({});
  const [fetPreviousNotes, setFetPreviousNotes] = useState<MeasurementNotes | null>(null);
  const [fetMeasurementId, setFetMeasurementId] = useState<string>("");
  const [fetMeasurementTimestamp, setFetMeasurementTimestamp] = useState<number>(0);

  useEffect(() => {
    const now = Date.now();
    setCvMeasurementId((v) => v || createMeasurementId("cv"));
    setCvMeasurementTimestamp((v) => v || now);
    setEisMeasurementId((v) => v || createMeasurementId("eis"));
    setEisMeasurementTimestamp((v) => v || now);
    setFetMeasurementId((v) => v || createMeasurementId("fet"));
    setFetMeasurementTimestamp((v) => v || now);
  }, []);

  // BioFET sample-addition markers
  const [fetMarkers, setFetMarkers] = useState<{ time: number; label: string }[]>([]);

  // Persisted session of all completed measurements
  const [sessionMeasurements, setSessionMeasurements] = useState<StoredMeasurement[]>([]);

  // Sweep status tracks completion separately from "is running"
  const [eisStatus, setEisStatus] = useState<SweepStatus>("idle");
  const [fetStatus, setFetStatus] = useState<SweepStatus>("idle");

  // Frozen snapshots for Signal Quality after sweep completes / stops
  const [frozenEis, setFrozenEis] = useState<ReturnType<typeof useWebSocketData>["eisData"] | null>(null);
  const [frozenFetBaseline, setFrozenFetBaseline] = useState<ReturnType<typeof useWebSocketData>["fetBaseline"] | null>(null);
  const [frozenFetAnalyte, setFrozenFetAnalyte] = useState<ReturnType<typeof useWebSocketData>["fetAnalyte"] | null>(null);

  // Simulated data hooks
  const eis = useSimulatedEIS(150);
  const fetTransfer = useSimulatedFETTransfer(fetParams.intervalMs);
  const fetTime = useSimulatedFETTime(fetParams.intervalMs);
  const cv = useSimulatedCVData(40);
  // SWV state lives here (always mounted) so it survives mode switches,
  // exactly like the CV/EIS/FET simulation state above.
  const swvState = useSWVModeState();

  // Live WebSocket data hook
  const ws = useWebSocketData();

  // Multi-channel: three fully independent WebSocket hooks (index matches channels[i])
  const ws1 = useWebSocketData();
  const ws2 = useWebSocketData();
  const ws3 = useWebSocketData();
  const wsChannels = [ws1, ws2, ws3];
  const isMulti = dataSource === "multichannel";
  // Per-channel "user wants this connected" intent, drives auto-reconnect.
  const [wantConnected, setWantConnected] = useState<boolean[]>([false, false, false]);
  const exportSource: "simulated" | "live" = dataSource === "simulated" ? "simulated" : "live";
  /** Broadcast a command to every enabled + connected channel. */
  const broadcastCommand = (command: string, payload?: Record<string, unknown>) => {
    channels.forEach((c, i) => {
      if (c.enabled && wsChannels[i].status === "connected") {
        wsChannels[i].sendCommand(command, payload);
      }
    });
  };
  const anyChannelConnected = channels.some((c, i) => c.enabled && wsChannels[i].status === "connected");
  const connectedCount = channels.filter(
    (c, i) => c.enabled && wsChannels[i].status === "connected",
  ).length;
  const enabledCount = channels.filter((c) => c.enabled).length;
  const staleChannels = channels.filter(
    (c, i) => c.enabled && wsChannels[i].status !== "connected",
  );
  const liveNotReady =
    (dataSource === "live" && ws.status !== "connected") || (isMulti && !anyChannelConnected);
  // Auto-reconnect: one hook instance per channel, only while the user wants
  // that channel connected (manual Disconnect clears the intent).
  useChannelReconnect(
    isMulti && channels[0].enabled && channels[0].autoReconnect && wantConnected[0],
    channels[0].url, ws1.status, ws1.connect,
  );
  useChannelReconnect(
    isMulti && channels[1].enabled && channels[1].autoReconnect && wantConnected[1],
    channels[1].url, ws2.status, ws2.connect,
  );
  useChannelReconnect(
    isMulti && channels[2].enabled && channels[2].autoReconnect && wantConnected[2],
    channels[2].url, ws3.status, ws3.connect,
  );

  const clearAllChannels = () => {
    channels.forEach((c, i) => {
      if (!c.enabled) return;
      wsChannels[i].clearEIS();
      wsChannels[i].clearFET();
      wsChannels[i].clearCV();
      wsChannels[i].clearSWV();
    });
  };

  // Last URL used to connect — lets the "connection lost" banner retry.
  const [lastWsUrl, setLastWsUrl] = useState("");
  const exportSessionButtonRef = useRef<HTMLButtonElement | null>(null);

  // Restore session on mount. Calibration curves are NOT rebuilt from
  // stored measurements here — adding a point to calibration is now a
  // deliberate "+ Add" click in every mode (EIS/BioFET/CV/SWV alike), so
  // silently reconstructing "every measurement that could be a calibration
  // point" on reload would undo that curation and disagree with how CV/SWV
  // already behave (their calibration has never survived a reload either).
  // The raw measurements themselves are untouched — full data is still in
  // sessionMeasurements and the Session CSV export.
  useEffect(() => {
    const stored = loadSession();
    if (stored.length === 0) return;
    setSessionMeasurements(stored);
    toast.success(`Restored ${stored.length} measurement(s) from previous session`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist whenever session changes (debounced — the raw point arrays are
  // expensive to stringify on every keystroke-level state change).
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const autosaveFirstRunRef = useRef(true);
  useEffect(() => {
    if (autosaveFirstRunRef.current) {
      autosaveFirstRunRef.current = false;
      return;
    }
    setAutosaveStatus("saving");
    saveSessionDebounced(sessionMeasurements, (status, err) => {
      setAutosaveStatus(status);
      if (status === "error") {
        toast.error(
          "Could not save the session locally — browser storage is full. Export your data to CSV to avoid losing it.",
        );
        console.warn("[session] autosave failed", err);
      }
    });
  }, [sessionMeasurements]);

  // Log WebSocket connection status transitions
  const lastWsStatusRef = useRef(ws.status);
  useEffect(() => {
    if (lastWsStatusRef.current === ws.status) return;
    if (ws.status === "connected") {
      logActivity("connection", "WebSocket connection established");
    } else if (ws.status === "disconnected" && lastWsStatusRef.current === "connected") {
      logActivity("connection", "WebSocket disconnected");
    } else if (ws.status === "error") {
      logActivity("connection", `WebSocket error${ws.errorMessage ? ": " + ws.errorMessage : ""}`);
    }
    lastWsStatusRef.current = ws.status;
  }, [ws.status, ws.errorMessage]);

  // Log concentration entry (debounced via ref so we don't spam on every keystroke commit)
  const lastLoggedConcentrationRef = useRef<number | null>(null);
  const handleChangeConcentration = (v: number) => {
    setConcentration(v);
    if (lastLoggedConcentrationRef.current !== v) {
      lastLoggedConcentrationRef.current = v;
      logActivity("calibration", `Concentration set to ${v} nM (${mode.toUpperCase()})`);
    }
  };

  // Pick the right data based on source
  const eisData = dataSource === "simulated" ? eis.data : ws.eisData;
  const fetBaselineData = dataSource === "simulated" ? fetTransfer.baseline : ws.fetBaseline;
  const fetAnalyteData = dataSource === "simulated" ? fetTransfer.withAnalyte : ws.fetAnalyte;
  const fetTimeDataArr = dataSource === "simulated" ? fetTime.data : ws.fetTimeData;

  // Expected counts based on configured parameters
  const expectedEisPoints = computeEISPointCount(eisParams);
  const expectedFetTransferPoints = useMemo(
    () => Math.max(1, Math.round((fetParams.vgMax - fetParams.vgMin) / (fetParams.vgStep / 1000)) + 1),
    [fetParams.vgMin, fetParams.vgMax, fetParams.vgStep]
  );
  const expectedFetTimePoints = useMemo(
    () => Math.max(1, Math.floor(fetParams.timeDuration_s / fetParams.timeStep_s) + 1),
    [fetParams.timeDuration_s, fetParams.timeStep_s]
  );
  const expectedFetTotal =
    expectedFetTransferPoints * 2 + expectedFetTimePoints;
  const fetReceivedTotal =
    fetBaselineData.length + fetAnalyteData.length + fetTimeDataArr.length;

  // Avoid double-firing the auto-stop
  const eisAutoStopFiredRef = useRef(false);
  const fetAutoStopFiredRef = useRef(false);
  // Same idea, but for Multi-Channel CV/SWV, which complete via per-channel
  // status ("done") rather than a point count.
  const cvMultiSavedRef = useRef(false);
  const swvMultiSavedRef = useRef(false);

  // Inactivity timers for completion when expected point count is wrong
  const eisInactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetInactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEisInactivity = () => {
    if (eisInactivityRef.current) {
      clearTimeout(eisInactivityRef.current);
      eisInactivityRef.current = null;
    }
  };
  const clearFetInactivity = () => {
    if (fetInactivityRef.current) {
      clearTimeout(fetInactivityRef.current);
      fetInactivityRef.current = null;
    }
  };

  // Shared EIS completion logic — used by both count-based and inactivity-based triggers.
  // NOTE: fitting is NOT run here. The user drags the separator then clicks "Fit Randles Circuit".
  const completeEISSweep = (finalData: typeof eisData) => {
    if (eisAutoStopFiredRef.current) return;
    eisAutoStopFiredRef.current = true;
    clearEisInactivity();
    if (isMulti) {
      broadcastCommand("stop");
      saveChannelMeasurements("eis");
      setEisStatus("complete");
      toast.success("Multi-Channel EIS sweep complete — all channels saved.");
      return;
    }
    if (dataSource === "simulated") {
      eis.stop();
    } else {
      ws.sendCommand("stop");
    }
    setFrozenEis(finalData);
    setEisStatus("complete");
    toast.success(`Sweep complete — ${finalData.length} points collected. Auto-fit ready; drag the separator and click Fit to refine.`);

    // Auto-detect semicircle/Warburg split & seed the default separator with
    // it. splitRegionsAuto always returns a usable separator position now
    // (falling back to the lowest-frequency point when no Warburg tail is
    // visible), so a second, separate fallback here is no longer needed —
    // the old one searched the whole sweep for the minimum |Im(Z)|, which
    // almost always sits at the very first (highest-frequency) point, i.e.
    // Z' ≈ Rs, making the separator look stuck there regardless of what the
    // auto-fit actually found.
    let defaultSep: number | null = null;
    let autoSemiCircle: typeof finalData = finalData;
    if (finalData.length > 0) {
      const split = splitRegionsAuto(finalData);
      autoSemiCircle = split.semicircle.length >= 5 ? split.semicircle : finalData;
      defaultSep = split.separatorZReal;
    }
    setSeparatorZReal(defaultSep);
    setEisFitted(false);

    // Automatic Randles CNLS fit (same math as manual CNLS panel).
    const autoFit = finalData.length >= 5 ? fitRandlesAuto(finalData) : null;
    const autoWb  = extractWarburgSlope(
      defaultSep != null ? finalData.filter(d => d.frequency < autoSemiCircle.reduce(
        (min, d) => Math.min(min, d.frequency), Infinity)) : [],
    );
    // KK on semicircle region only — Warburg tail causes false KK failures.
    const autoKk  = kramersKronigTest(autoSemiCircle);
    // Lin-KK runs on the FULL spectrum — it is KK-compliant by construction
    // and provides a rigorous data-consistency check independent of the
    // chosen equivalent circuit.
    const autoLinKK = linKKTest(finalData);
    // Also populate the CNLS Fit panel automatically, using the same
    // auto-detected region and the currently selected circuit model — it
    // used to be left null here, so the detailed fit panel always showed
    // "click Fit" even though a valid auto-fit had already run, making
    // automatic detection look broken. Re-fitting manually still works and
    // simply replaces this result.
    const autoCnls = autoSemiCircle.length >= 4
      ? fitEIS(autoSemiCircle, circuitModel, finalData)
      : null;
    setRandlesFit(autoFit);
    setWarburg(autoWb);
    setKk(autoKk);
    setLinKK(autoLinKK);
    setCnlsFit(autoCnls);
    setGeometricFallback(autoFit == null || autoFit.fitErrorPct === -1);
    setEisFitted(autoCnls != null);
    if (autoFit?.separatorUncertain) {
      toast.warning(autoFit.separatorWarning ?? "Automatic separator uncertain — adjust manually.");
    }

    const params = computeEISParams(finalData);
    logActivity(
      "measurement",
      `EIS completed — concentration=${concentration} nM, points=${finalData.length} · auto-fit saved; manual re-fit available`,
    );

    const rctForCalib = params?.rct ?? 0;
    const rsForCalib = params?.rs ?? 0;
    try {
      // Auto-capture into the overlay comparison view (same logic as the
      // manual "+ Capture" button) so it is already there when Overlay
      // Mode is switched on later.
      if (finalData.length > 0 && demoRunning) {
        setEisOverlays((prev) => {
          const label =
            dataSource === "live" && ws.lastFilename
              ? ws.lastFilename.replace(/\.xlsx$/i, "").replace(/\.xls$/i, "")
              : concentration > 0
                ? `${concentration} nM`
                : `Measurement ${prev.length + 1}`;
          const color = OVERLAY_COLORS[prev.length % OVERLAY_COLORS.length];
          const next = [
            ...prev,
            { id: newId(), label, color, data: finalData.slice() },
          ];
          return next.length > 8 ? next.slice(next.length - 8) : next;
        });
      }
      const cleanEisNotes = sanitizeMeasurementNotes(eisNotes);
      const autoConverged = autoFit != null && autoFit.fitErrorPct !== -1;
      const autoFitErrorPct = autoConverged
        ? autoFit!.chiSquared != null
          ? Math.sqrt(Math.max(autoFit!.chiSquared, 0)) * 100
          : autoFit!.fitErrorPct
        : undefined;
      const stored: StoredEISMeasurement = {
        id: newId(),
        mode: "eis",
        timestamp: Date.now(),
        concentration,
        measurementId: eisMeasurementId,
        measurementTimestamp: eisMeasurementTimestamp,
        notes: cleanEisNotes,
        params: {
          freqMin: eisParams.freqMin,
          freqMax: eisParams.freqMax,
          points: computeEISPointCount(eisParams),
          amplitude: eisParams.amplitude,
          pointDensityMode: eisParams.pointDensityMode,
          pointsPerDecade: eisParams.pointsPerDecade,
          dcBias: eisParams.dcBias,
        },
        data: finalData.slice(),
        extracted: autoConverged
          ? {
              Rs: autoFit!.Rs,
              Rct: autoFit!.Rct,
              Cdl: autoFit!.Cdl,
              Aw: autoWb?.Aw ?? autoFit!.Aw,
              warburgAw: autoWb?.Aw,
              warburgSlope: autoWb?.slope,
              warburgR2: autoWb?.r2Imag,
              warburgIntercept: autoWb?.interceptImag,
              warburgMethod: autoWb?.method ?? "regression_1_sqrt_omega_with_intercept",
              fitErrorPct: autoFitErrorPct,
              f0: autoFit!.f0,
              kkResidualPct: autoKk?.residualPct,
              kkPassed: autoKk?.passed,
              kkMethod: autoKk?.method ?? "approximate_residual",
              fitConverged: true,
              geometricFallback: false,
              warnFlags: [
                ...(autoFit!.warnFlags ?? []),
                ...(autoWb?.warnings ?? (autoWb?.warburgWarning ? [autoWb.warburgWarning] : [])),
              ],
              fitModel: "randles",
              fitSource: "auto_cnls_randles",
              weightedSsrPerDof: autoFit!.chiSquared,
              rmseWeightedPercent: autoFitErrorPct,
              fitRangeMinHz: autoFit!.fitFreqRange?.min,
              fitRangeMaxHz: autoFit!.fitFreqRange?.max,
              covarianceMethod: "log_space",
              linKKPassed: autoLinKK?.passed,
              linKKRmsResidualPct: autoLinKK?.residualRmsPct,
              linKKMaxResidualPct: autoLinKK?.maxResidualPct,
              linKKTauCount: autoLinKK?.tauCount,
              linKKNegativeRkCount: autoLinKK?.negativeRkCount,
              linKKNegativeRkPct: autoLinKK?.negativeRkPct,
              approxKkInformationalOnly: true,
            }
          : {
              Rs: rsForCalib,
              Rct: rctForCalib,
              fitConverged: false,
              geometricFallback: true,
              fitSource: "geometric_fallback",
              linKKPassed: autoLinKK?.passed,
              linKKRmsResidualPct: autoLinKK?.residualRmsPct,
              linKKMaxResidualPct: autoLinKK?.maxResidualPct,
              linKKTauCount: autoLinKK?.tauCount,
              linKKNegativeRkCount: autoLinKK?.negativeRkCount,
              linKKNegativeRkPct: autoLinKK?.negativeRkPct,
              approxKkInformationalOnly: true,
            },
      };

      if (hasAnyNotes(cleanEisNotes)) setEisPreviousNotes(cleanEisNotes!);
      setSessionMeasurements((prev) => [...prev, stored]);
    } catch (err) {
      console.warn("Session store failed", err);
    }
  };

  // Run the Randles fit on the user-selected semicircle region.
  const handleFitRandles = () => {
    if (separatorZReal == null) return;
    const finalData = frozenEis ?? eisData;
    // Filter by frequency — NOT by zReal.
    // The Warburg tail can fold back to lower zReal values, so zReal-based
    // filtering includes Warburg points in the semicircle region.
    // The separator zReal value corresponds to a specific frequency point;
    // find that frequency and split there.
    const sepPoint = finalData.reduce((best, d) =>
      Math.abs(d.zReal - separatorZReal) < Math.abs(best.zReal - separatorZReal) ? d : best,
      finalData[0]
    );
    const sepFreq = sepPoint.frequency;
    const semi = finalData.filter(d => d.frequency >= sepFreq);
    const warb = finalData.filter(d => d.frequency <  sepFreq);
    if (semi.length < 5) {
      toast.error(`Semicircle region has only ${semi.length} pts — need at least 5. Move the separator right.`);
      return;
    }
    const fit = fitRandles(semi, finalData);
    const wb = extractWarburgSlope(warb);
    // KK test on semicircle region only — the Warburg tail causes false failures
    // because the discrete Hilbert transform is unreliable at low frequencies.
    const kkRes = kramersKronigTest(semi.length >= 5 ? semi : finalData);
    const linKKRes = linKKTest(finalData);
    const cnls = fitEIS(semi, circuitModel, finalData);
    setRandlesFit(fit);
    setWarburg(wb);
    setKk(kkRes);
    setLinKK(linKKRes);
    setCnlsFit(cnls);
    const fitConverged = fit != null && fit.fitErrorPct !== -1;
    setGeometricFallback(!fitConverged);
    setEisFitted(true);

    const rctForCalib = cnls?.params.Rct ?? fit?.Rct ?? 0;
    const wssrStr = cnls ? cnls.chiSquared.toExponential(2) : "n/a";
    logActivity(
      "measurement",
      `CNLS fit (${circuitModel}) — Rct=${rctForCalib.toFixed(1)} Ω, wSSR/dof=${wssrStr}, semi=${semi.length} pts`,
    );

    // ── Update the existing session measurement (same measurementId) so the
    // session export reflects the FINAL fit instead of the initial geometric
    // estimate. Never create a duplicate.
    setSessionMeasurements((prev) => {
      const idx = prev.findIndex(
        (m) => m.mode === "eis" && (m as StoredEISMeasurement).measurementId === eisMeasurementId,
      );
      if (idx < 0) return prev;
      const target = prev[idx] as StoredEISMeasurement;
      const fitErrorPct = cnls ? Math.sqrt(Math.max(cnls.chiSquared, 0)) * 100 : fit?.fitErrorPct;
      // f0 model-aware: Randles vs Randles-CPE.
      let f0: number | undefined = fit?.f0;
      if (cnls) {
        const Rct = cnls.params.Rct;
        if (circuitModel === "randles-cpe") {
          const Q = cnls.params.Q;
          const nCpe = cnls.params.n;
          if (Rct && Q && nCpe && nCpe > 0) f0 = Math.pow(Rct * Q, -1 / nCpe) / (2 * Math.PI);
        } else {
          const Cdl = cnls.params.Cdl;
          if (Rct && Cdl) f0 = 1 / (2 * Math.PI * Rct * Cdl);
        }
      }
      const fitSource: NonNullable<StoredEISMeasurement["extracted"]["fitSource"]> =
        cnls
          ? circuitModel === "randles-cpe"
            ? "manual_cnls_randles_cpe"
            : "manual_cnls_randles"
          : fit
            ? "manual_randles"
            : "geometric";
      const updated: StoredEISMeasurement = {
        ...target,
        extracted: {
          ...target.extracted,
          Rs: cnls?.params.Rs ?? fit?.Rs ?? target.extracted.Rs,
          Rct: cnls?.params.Rct ?? fit?.Rct ?? target.extracted.Rct,
          Cdl: cnls?.params.Cdl ?? fit?.Cdl ?? target.extracted.Cdl,
          Q: cnls?.params.Q,
          n: cnls?.params.n,
          Aw: wb?.Aw ?? fit?.Aw ?? target.extracted.Aw,
          warburgAw: wb?.Aw,
          warburgSlope: wb?.slope,
          warburgR2: wb?.r2Imag,
          warburgIntercept: wb?.interceptImag,
          warburgMethod: wb?.method ?? "regression_1_sqrt_omega_with_intercept",
          fitErrorPct,
          f0,
          kkResidualPct: kkRes?.residualPct,
          kkPassed: kkRes?.passed,
          kkMethod: kkRes?.method ?? "approximate_residual",
          fitConverged: cnls ? cnls.converged : (fit ? fit.fitErrorPct !== -1 : false),
          geometricFallback: !cnls && !(fit && fit.fitErrorPct !== -1),
          warnFlags: [
            ...(cnls?.warnings ?? []),
            ...(fit?.warnFlags ?? []),
            ...(wb?.warnings ?? (wb?.warburgWarning ? [wb.warburgWarning] : [])),
          ],
          fitModel: cnls ? circuitModel : undefined,
          fitSource,
          weightedSsrPerDof: cnls?.chiSquared,
          rmseWeightedPercent: cnls ? Math.sqrt(Math.max(cnls.chiSquared, 0)) * 100 : undefined,
          fitRangeMinHz: cnls?.fitFreqRange?.min,
          fitRangeMaxHz: cnls?.fitFreqRange?.max,
          covarianceWarning: cnls?.covarianceWarning,
          covarianceMethod: cnls?.covarianceMethod ?? "log_space",
          extrapolationPresent: cnls?.extrapolationPresent,
          linKKPassed: linKKRes?.passed,
          linKKRmsResidualPct: linKKRes?.residualRmsPct,
          linKKMaxResidualPct: linKKRes?.maxResidualPct,
          linKKTauCount: linKKRes?.tauCount,
          linKKNegativeRkCount: linKKRes?.negativeRkCount,
          linKKNegativeRkPct: linKKRes?.negativeRkPct,
          approxKkInformationalOnly: true,
        },
      };

      const next = prev.slice();
      next[idx] = updated;
      return next;
    });

    toast.success(`Fit complete — Rct = ${rctForCalib.toFixed(1)} Ω · wSSR/dof = ${wssrStr}`);
  };

  // Explicit "+ Add to calibration" handler (EIS) — reads the last fit
  // result from state rather than re-fitting, so it only ever appends the
  // point the user is currently looking at.
  const handleAddEisCalibrationPoint = () => {
    const rctForCalib = cnlsFit?.params.Rct ?? randlesFit?.Rct ?? 0;
    if (!(rctForCalib > 0)) {
      toast.error("No EIS fit yet — fit a circuit first.");
      return;
    }
    const baseline = eisCalibration.find((p) => p.concentration === 0);
    const deltaRct =
      concentration === 0 ? 0 : rctForCalib - (baseline?.raw ?? rctForCalib);
    // Replicates allowed — never replace points at the same concentration.
    // Multiple measurements at the same concentration (including blanks)
    // are required for LOD/LOQ statistics and repeatability assessment.
    setEisCalibration((prev) => [
      ...prev,
      {
        concentration,
        signal: deltaRct,
        raw: rctForCalib,
        timestamp: Date.now(),
        measurementId: eisMeasurementId,
        sampleId: eisNotes.sampleId,
        electrodeId: eisNotes.electrodeId,
        notesShort: shortNotesSummary(eisNotes)?.slice(0, 80),
      },
    ]);
    logActivity(
      "calibration",
      `EIS calibration point added — C=${concentration} nM, ΔRct=${deltaRct.toFixed(1)} Ω`,
    );
    toast.success(`Added EIS point at ${concentration} nM`);
  };

  // Shared FET completion logic
  const completeFETSweep = (
    finalBaseline: typeof fetBaselineData,
    finalAnalyte: typeof fetAnalyteData,
    finalTime: typeof fetTimeDataArr,
  ) => {
    if (fetAutoStopFiredRef.current) return;
    fetAutoStopFiredRef.current = true;
    clearFetInactivity();
    if (isMulti) {
      broadcastCommand("stop");
      saveChannelMeasurements("fet");
    } else if (dataSource === "simulated") {
      fetTransfer.stop();
      fetTime.stop();
    } else {
      ws.sendCommand("stop");
    }
    setFrozenFetBaseline(finalBaseline);
    setFrozenFetAnalyte(finalAnalyte);
    // Auto-capture the transfer curve into the overlay comparison view
    // (same shape as the manual "+ Capture" button). Guarded once per
    // sweep by fetAutoStopFiredRef above.
    if ((finalBaseline.length > 0 || finalAnalyte.length > 0) && demoRunning) {
      setFetOverlays((prev) => {
        const label =
          concentration > 0 ? `${concentration} nM` : `Measurement ${prev.length + 1}`;
        const color = OVERLAY_COLORS[prev.length % OVERLAY_COLORS.length];
        const next = [
          ...prev,
          {
            id: newId(),
            label,
            color,
            baseline: finalBaseline.slice(),
            withAnalyte: finalAnalyte.slice(),
          },
        ];
        return next.length > 8 ? next.slice(next.length - 8) : next;
      });
    }
    if (finalTime.length > 0 && demoRunning) {
      setFetTimeOverlays((prev) => {
        const label =
          concentration > 0 ? `${concentration} nM` : `Measurement ${prev.length + 1}`;
        const color = OVERLAY_COLORS[prev.length % OVERLAY_COLORS.length];
        const next = [
          ...prev,
          { id: newId(), label, color, data: finalTime.slice() },
        ];
        return next.length > 8 ? next.slice(next.length - 8) : next;
      });
    }
    setFetStatus("complete");
    const total = finalBaseline.length + finalAnalyte.length + finalTime.length;
    toast.success(`Sweep complete — ${total} points collected`);
    // Vt + ΔVt + Ion/Ioff + SS + stability from THIS measurement, via the
    // centralised helper so UI/session/CSV/calibration all agree.
    const priorSigned = fetCalibration
      .filter((p) => p.concentration > 0 && typeof p.deltaVt_mV_signed === "number")
      .map((p) => p.deltaVt_mV_signed as number);
    const inferredSign = inferFETResponseSign(priorSigned);
    const metrics = computeFETTransferMetrics(finalBaseline, finalAnalyte, {
      responseMode: fetResponseMode,
      responseSign: inferredSign,
    });
    const vt = metrics.vtAnalyte;
    const vtBaseline = metrics.vtBaseline;
    const deltaVt_mV = metrics.deltaVt_mV;
    const deltaVt_mV_signed = metrics.deltaVt_mV_signed;
    const calibrationSignal_mV_used = metrics.calibrationSignal_mV_used;
    logActivity(
      "measurement",
      `BioFET completed — concentration=${concentration} nM, Vt=${
        vt != null ? vt.toFixed(3) : "n/a"
      } V, ΔVt=${deltaVt_mV != null ? deltaVt_mV.toFixed(1) + " mV" : "n/a"} (${metrics.vtMethod}; mode=${fetResponseMode})`,
    );
    // Falls back to "Cortisol" when the logbook's Analyte field is blank
    // (same default as the on-screen labels), so exported/stored data never
    // has an empty analyte column.
    const cleanFetNotes = sanitizeMeasurementNotes({ ...fetNotes, analyte: fetAnalyteName });
    const storedFet: StoredFETMeasurement = {
      id: newId(),
      mode: "fet",
      timestamp: Date.now(),
      concentration,
      measurementId: fetMeasurementId,
      measurementTimestamp: fetMeasurementTimestamp,
      notes: cleanFetNotes,
      params: {
        vgMin: fetParams.vgMin,
        vgMax: fetParams.vgMax,
        vgStep: fetParams.vgStep,
        intervalMs: fetParams.intervalMs,
      },
      baseline: finalBaseline.slice(),
      analyte: finalAnalyte.slice(),
      timeData: finalTime.slice(),
      markers: fetMarkers.slice(),
      extracted: {
        Vt: vt ?? undefined,
        vtBaseline: vtBaseline ?? undefined,
        vtAnalyte: vt ?? undefined,
        deltaVt_mV: deltaVt_mV ?? undefined,
        deltaVt_mV_signed: deltaVt_mV_signed ?? undefined,
        calibrationSignal_mV_used: calibrationSignal_mV_used ?? undefined,
        vtMethod: metrics.vtMethod,
        vtFitR2: metrics.vtFitR2 ?? undefined,
        vtRegionPoints: metrics.vtRegionPoints,
        vtIoffUsed: metrics.vtIoffUsed,
        vtWarning: metrics.vtWarning,
        vtBaselineMethod: metrics.vtBaselineMethod,
        vtBaselineFitR2: metrics.vtBaselineFitR2 ?? undefined,
        vtBaselineRegionPoints: metrics.vtBaselineRegionPoints,
        vtBaselineIoffUsed: metrics.vtBaselineIoffUsed,
        vtBaselineWarning: metrics.vtBaselineWarning,
        vtAnalyteMethod: metrics.vtAnalyteMethod,
        vtAnalyteFitR2: metrics.vtAnalyteFitR2 ?? undefined,
        vtAnalyteRegionPoints: metrics.vtAnalyteRegionPoints,
        vtAnalyteIoffUsed: metrics.vtAnalyteIoffUsed,
        vtAnalyteWarning: metrics.vtAnalyteWarning,
        ion_uA: metrics.ion_uA,
        ioff_uA: metrics.ioff_uA,
        ionIoffRatio: metrics.ionIoffRatio,
        subthresholdSlope_mV_dec: metrics.subthresholdSlope_mV_dec,
        baselineStabilityNoisePct: metrics.baselineStabilityNoisePct,
        responseMode: fetResponseMode,
        responseSign: metrics.responseSign,
      },
    };
    if (hasAnyNotes(cleanFetNotes)) setFetPreviousNotes(cleanFetNotes!);
    setSessionMeasurements((prev) => [...prev, storedFet]);
  };

  // Explicit "+ Add to calibration" handler (BioFET) — recomputes Vt/ΔVt
  // from the last completed sweep's data rather than depending on the
  // sweep-completion callback, so it only appends the point currently shown.
  const handleAddFetCalibrationPoint = () => {
    const baselineData = frozenFetBaseline ?? fetBaselineData;
    const analyteData = frozenFetAnalyte ?? fetAnalyteData;
    const priorSigned = fetCalibration
      .filter((p) => p.concentration > 0 && typeof p.deltaVt_mV_signed === "number")
      .map((p) => p.deltaVt_mV_signed as number);
    const inferredSign = inferFETResponseSign(priorSigned);
    const metrics = computeFETTransferMetrics(baselineData, analyteData, {
      responseMode: fetResponseMode,
      responseSign: inferredSign,
    });
    const vt = metrics.vtAnalyte;
    const vtBaseline = metrics.vtBaseline;
    const deltaVt_mV = metrics.deltaVt_mV;
    if (vt == null || vtBaseline == null || deltaVt_mV == null) {
      toast.warning("ΔVt unavailable — run a BioFET sweep first.");
      return;
    }
    setFetCalibration((prev) => [
      ...prev,
      {
        concentration,
        // For Langmuir fit consumption: use calibrationSignal_mV_used when
        // present (sign already aligned), else fall back to signed ΔVt.
        signal: metrics.calibrationSignal_mV_used ?? deltaVt_mV,
        raw: vt,
        timestamp: Date.now(),
        measurementId: fetMeasurementId,
        sampleId: fetNotes.sampleId,
        electrodeId: fetNotes.electrodeId,
        notesShort: shortNotesSummary(fetNotes)?.slice(0, 80),
        deltaVt_mV_signed: metrics.deltaVt_mV_signed ?? undefined,
        calibrationSignal_mV_used: metrics.calibrationSignal_mV_used ?? undefined,
        responseMode: fetResponseMode,
        responseSign: metrics.responseSign,
        vtBaseline: vtBaseline ?? undefined,
        vtAnalyte: vt ?? undefined,
        vtMethod: metrics.vtMethod,
        vtFitR2: metrics.vtFitR2 ?? null,
        vtRegionPoints: metrics.vtRegionPoints,
        vtWarning: metrics.vtWarning,
      },
    ]);
    logActivity(
      "calibration",
      `BioFET calibration point added — C=${concentration} nM, ΔVt=${deltaVt_mV.toFixed(1)} mV`,
    );
    toast.success(`Added BioFET point at ${concentration} nM`);
  };

  const handleStartEIS = (concentrationOverride?: number) => {
    const conc = concentrationOverride ?? concentration;
    eisAutoStopFiredRef.current = false;
    setFrozenEis(null);
    setRandlesFit(null);
    setWarburg(null);
    setKk(null);
    setCnlsFit(null);
    setGeometricFallback(false);
    setSeparatorZReal(null);
    setEisFitted(false);
    setEisStatus("running");
    setEisMeasurementId(createMeasurementId("eis"));
    setEisMeasurementTimestamp(Date.now());
    const actualPoints = computeEISPointCount(eisParams);
    logActivity(
      "measurement",
      `EIS measurement started — concentration=${conc} nM, source=${dataSource}, points=${actualPoints} (${eisParams.pointDensityMode}), dcBias=${eisParams.dcBias} V`,
    );
    if (isMulti) {
      clearAllChannels();
      broadcastCommand("start_eis", {
        freqMin: eisParams.freqMin,
        freqMax: eisParams.freqMax,
        pointDensityMode: eisParams.pointDensityMode,
        pointsPerDecade: eisParams.pointsPerDecade,
        points: actualPoints,
        amplitude: eisParams.amplitude,
        dcBias: eisParams.dcBias,
        concentration: conc,
      });
    } else if (dataSource === "simulated") {
      eis.start(conc, actualPoints, eisParams.freqMin, eisParams.freqMax);
    } else {
      ws.clearEIS();
      ws.sendCommand("start_eis", {
        freqMin: eisParams.freqMin,
        freqMax: eisParams.freqMax,
        pointDensityMode: eisParams.pointDensityMode,
        pointsPerDecade: eisParams.pointsPerDecade,
        points: actualPoints,
        amplitude: eisParams.amplitude,
        dcBias: eisParams.dcBias,
        concentration: conc,
      });
    }
  };

  const handleResetEIS = () => {
    eisAutoStopFiredRef.current = false;
    clearEisInactivity();
    setFrozenEis(null);
    setEisStatus("idle");
    setRandlesFit(null);
    setWarburg(null);
    setKk(null);
    setCnlsFit(null);
    setGeometricFallback(false);
    setSeparatorZReal(null);
    setEisFitted(false);
    if (isMulti) {
      clearAllChannels();
      broadcastCommand("stop");
      return;
    }
    if (dataSource === "simulated") {
      eis.reset();
    } else {
      ws.clearEIS();
      ws.sendCommand("stop");
    }
  };

  const handleStartFET = (concentrationOverride?: number) => {
    const conc = concentrationOverride ?? concentration;
    fetAutoStopFiredRef.current = false;
    setFrozenFetBaseline(null);
    setFrozenFetAnalyte(null);
    setFetMarkers([]);
    setFetStatus("running");
    setFetMeasurementId(createMeasurementId("fet"));
    setFetMeasurementTimestamp(Date.now());
    logActivity(
      "measurement",
      `BioFET measurement started — concentration=${conc} nM, source=${dataSource}`,
    );
    // Analyte/device overrides — shared by every path (simulated, live,
    // multi-channel) so changing Kd/Vt/Id/etc. in the parameters panel
    // actually reaches the bridge/hardware, not just the in-browser
    // simulator. Field names match bridge.py's start_fet reader exactly.
    const overrides = {
      kd_nM: fetParams.kd_nM,
      vtBaseline_V: fetParams.vtBaseline_V,
      deltaVtMax_V: fetParams.deltaVtMax_V,
      idMax_uA: fetParams.idMax_uA,
      idealityFactor: fetParams.idealityFactor,
      bindingRate_perS: fetParams.bindingRate_perS,
      readoutBias_V: fetParams.readoutBias_V,
      timeDuration_s: fetParams.timeDuration_s,
      timeStep_s: fetParams.timeStep_s,
      injectionTime_s: fetParams.injectionTime_s,
    };
    if (isMulti) {
      clearAllChannels();
      broadcastCommand("start_fet", {
        vgMin: fetParams.vgMin,
        vgMax: fetParams.vgMax,
        vgStep: fetParams.vgStep / 1000,
        intervalMs: fetParams.intervalMs,
        concentration: conc,
        rtiaOhms: fetParams.rtiaOhms,
        ...overrides,
      });
      return;
    }
    if (dataSource === "simulated") {
      fetTransfer.start(
        conc,
        fetParams.vgMin,
        fetParams.vgMax,
        expectedFetTransferPoints,
        overrides,
      );
      fetTime.start(conc, overrides);
    } else {
      ws.clearFET();
      ws.sendCommand("start_fet", {
        vgMin: fetParams.vgMin,
        vgMax: fetParams.vgMax,
        vgStep: fetParams.vgStep / 1000, // mV → V
        intervalMs: fetParams.intervalMs,
        concentration: conc,
        rtiaOhms: fetParams.rtiaOhms,
        ...overrides,
      });
    }
  };

  const handleResetFET = () => {
    fetAutoStopFiredRef.current = false;
    clearFetInactivity();
    setFrozenFetBaseline(null);
    setFrozenFetAnalyte(null);
    setFetStatus("idle");
    setFetMarkers([]);
    if (isMulti) {
      clearAllChannels();
      broadcastCommand("stop");
      return;
    }
    if (dataSource === "simulated") {
      fetTransfer.reset();
      fetTime.reset();
    } else {
      ws.clearFET();
      ws.sendCommand("stop");
    }
  };

  /**
   * Multi-Channel persistence: save each enabled+populated channel's sweep as
   * its own session measurement, tagged with the channel that produced it so
   * exports stay traceable per sensor. Raw data only — no math is changed.
   */
  const saveChannelMeasurements = (technique: "eis" | "fet" | "cv" | "swv") => {
    if (!isMulti) return;
    const now = Date.now();
    const stored: StoredMeasurement[] = [];
    channels.forEach((c, i) => {
      if (!c.enabled) return;
      const chan = wsChannels[i];
      const tag = { channelId: c.id, channelLabel: c.label };
      if (technique === "eis" && chan.eisData.length > 0) {
        const m: StoredEISMeasurement = {
          id: newId(), mode: "eis", timestamp: now, concentration,
          measurementId: `${eisMeasurementId}_ch${c.id}`,
          measurementTimestamp: eisMeasurementTimestamp || now,
          ...tag,
          params: {
            freqMin: eisParams.freqMin, freqMax: eisParams.freqMax,
            points: computeEISPointCount(eisParams), amplitude: eisParams.amplitude,
            pointDensityMode: eisParams.pointDensityMode,
            pointsPerDecade: eisParams.pointsPerDecade, dcBias: eisParams.dcBias,
          },
          data: chan.eisData.slice(),
          extracted: {},
        };
        stored.push(m);
      }
      if (technique === "fet" && (chan.fetBaseline.length > 0 || chan.fetAnalyte.length > 0 || chan.fetTimeData.length > 0)) {
        const m: StoredFETMeasurement = {
          id: newId(), mode: "fet", timestamp: now, concentration,
          measurementId: `${fetMeasurementId}_ch${c.id}`,
          measurementTimestamp: fetMeasurementTimestamp || now,
          ...tag,
          params: {
            vgMin: fetParams.vgMin, vgMax: fetParams.vgMax,
            vgStep: fetParams.vgStep, intervalMs: fetParams.intervalMs,
          },
          baseline: chan.fetBaseline.slice(),
          analyte: chan.fetAnalyte.slice(),
          timeData: chan.fetTimeData.slice(),
          markers: [],
          extracted: {},
        };
        stored.push(m);
      }
      if (technique === "cv" && chan.cvData.length > 0) {
        const m: StoredCVMeasurement = {
          id: newId(), mode: "cv", timestamp: now, concentration: cvParams.cMM,
          measurementId: `${cvMeasurementId}_ch${c.id}`,
          measurementTimestamp: cvMeasurementTimestamp || now,
          ...tag,
          params: { ...cvParams },
          data: chan.cvData.slice(),
          metrics: computeCVMetrics(chan.cvData, {
            scanRate_mVs: cvParams.scanRate, n: cvParams.n, cMM: cvParams.cMM,
            areaCm2: cvParams.areaCm2, baselineMethodInput: cvBaselineMethod,
          }) ?? null,
        };
        stored.push(m);
      }
      if (technique === "swv" && chan.swvData.length > 0) {
        const { corrected, metrics } = analyzeSWV(chan.swvData, swvParams.baselineMethod ?? "auto");
        const m: StoredSWVMeasurement = {
          id: newId(), mode: "swv", timestamp: now, source: "live",
          concentration: swvParams.concentration_nM,
          measurementId: `swv_${now}_ch${c.id}`,
          measurementTimestamp: now,
          ...tag,
          params: { ...swvParams },
          data: chan.swvData.slice(),
          correctedData: corrected,
          extracted: metrics,
        };
        stored.push(m);
      }
    });
    if (stored.length === 0) return;
    setSessionMeasurements((prev) => [...prev, ...stored]);
    logActivity(
      "measurement",
      `Multi-Channel ${technique.toUpperCase()} saved — ${stored.length} channel measurement(s)`,
    );
  };

  // Manual stop (mid-sweep)
  const handleStopEIS = () => {
    if (eisStatus !== "running") return;
    eisAutoStopFiredRef.current = true;
    clearEisInactivity();
    if (isMulti) {
      broadcastCommand("stop");
      saveChannelMeasurements("eis");
    } else if (dataSource === "simulated") {
      eis.stop();
    } else {
      ws.sendCommand("stop");
    }
    setFrozenEis(eisData);
    setEisStatus("stopped");
    toast(`Stopped at ${eisData.length} / ${expectedEisPoints} points`);
  };

  const handleStopFET = () => {
    if (fetStatus !== "running") return;
    fetAutoStopFiredRef.current = true;
    clearFetInactivity();
    if (isMulti) {
      broadcastCommand("stop");
      saveChannelMeasurements("fet");
    } else if (dataSource === "simulated") {
      fetTransfer.stop();
      fetTime.stop();
    } else {
      ws.sendCommand("stop");
    }
    setFrozenFetBaseline(fetBaselineData);
    setFrozenFetAnalyte(fetAnalyteData);
    setFetStatus("stopped");
    toast(`Stopped at ${fetReceivedTotal} / ${expectedFetTotal} points`);
  };

  // Auto-completion detection — EIS
  useEffect(() => {
    if (eisStatus !== "running") return;
    if (eisAutoStopFiredRef.current) return;
    if (eisData.length >= expectedEisPoints && expectedEisPoints > 0) {
      completeEISSweep(eisData);
    }
  }, [eisData, eisStatus, expectedEisPoints, dataSource, eis, ws]);

  // Inactivity-based completion — EIS (fires after 2s of no new points, once >=10 collected)
  useEffect(() => {
    if (eisStatus !== "running") {
      clearEisInactivity();
      return;
    }
    if (eisData.length < 10) return;
    if (eisAutoStopFiredRef.current) return;
    clearEisInactivity();
    const snapshot = eisData;
    eisInactivityRef.current = setTimeout(() => {
      completeEISSweep(snapshot);
    }, 2000);
    return () => clearEisInactivity();
  }, [eisData, eisStatus]);

  // Auto-completion detection — EIS (Multi-Channel: every enabled channel
  // must reach the expected point count on its own WebSocket).
  useEffect(() => {
    if (!isMulti || eisStatus !== "running") return;
    if (eisAutoStopFiredRef.current) return;
    const active = channels.filter((c) => c.enabled);
    if (active.length === 0 || expectedEisPoints <= 0) return;
    const allDone = channels.every(
      (c, i) => !c.enabled || wsChannels[i].eisData.length >= expectedEisPoints,
    );
    if (allDone) completeEISSweep(eisData);
  }, [channels, ws1.eisData, ws2.eisData, ws3.eisData, isMulti, eisStatus, expectedEisPoints]);

  // Auto-completion detection — BioFET (all 3 phases done)
  useEffect(() => {
    if (fetStatus !== "running") return;
    if (fetAutoStopFiredRef.current) return;
    const baselineDone = fetBaselineData.length >= expectedFetTransferPoints;
    const analyteDone = fetAnalyteData.length >= expectedFetTransferPoints;
    const timeDone = fetTimeDataArr.length >= expectedFetTimePoints;
    if (baselineDone && analyteDone && timeDone) {
      completeFETSweep(fetBaselineData, fetAnalyteData, fetTimeDataArr);
    }
  }, [
    fetBaselineData,
    fetAnalyteData,
    fetTimeDataArr,
    fetStatus,
    expectedFetTransferPoints,
    expectedFetTimePoints,
    fetReceivedTotal,
    dataSource,
    fetTransfer,
    fetTime,
    ws,
  ]);

  // Inactivity-based completion — BioFET (2s after fetTimeDataArr stops growing, once >=5)
  useEffect(() => {
    if (fetStatus !== "running") {
      clearFetInactivity();
      return;
    }
    if (fetTimeDataArr.length < 5) return;
    if (fetAutoStopFiredRef.current) return;
    clearFetInactivity();
    const b = fetBaselineData;
    const a = fetAnalyteData;
    const t = fetTimeDataArr;
    fetInactivityRef.current = setTimeout(() => {
      completeFETSweep(b, a, t);
    }, 2000);
    return () => clearFetInactivity();
  }, [fetBaselineData, fetAnalyteData, fetTimeDataArr, fetStatus]);

  // Auto-completion detection — BioFET (Multi-Channel: every enabled channel
  // must finish all 3 phases on its own WebSocket).
  useEffect(() => {
    if (!isMulti || fetStatus !== "running") return;
    if (fetAutoStopFiredRef.current) return;
    const active = channels.filter((c) => c.enabled);
    if (active.length === 0) return;
    const allDone = channels.every((c, i) => {
      if (!c.enabled) return true;
      const chan = wsChannels[i];
      return (
        chan.fetBaseline.length >= expectedFetTransferPoints &&
        chan.fetAnalyte.length >= expectedFetTransferPoints &&
        chan.fetTimeData.length >= expectedFetTimePoints
      );
    });
    if (allDone) completeFETSweep(fetBaselineData, fetAnalyteData, fetTimeDataArr);
  }, [
    channels,
    ws1.fetBaseline, ws1.fetAnalyte, ws1.fetTimeData,
    ws2.fetBaseline, ws2.fetAnalyte, ws2.fetTimeData,
    ws3.fetBaseline, ws3.fetAnalyte, ws3.fetTimeData,
    isMulti, fetStatus, expectedFetTransferPoints, expectedFetTimePoints,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearEisInactivity();
      clearFetInactivity();
    };
  }, []);

  // Live CV — react to cv_done / cv_error from ESP32.
  useEffect(() => {
    if (dataSource !== "live") return;
    if (ws.cvStatus === "done" || ws.cvStatus === "error" || ws.cvStatus === "idle") {
      setIsLiveCVRunning(false);
      if (ws.cvStatus === "error" && ws.cvError) {
        toast.error(`CV error: ${ws.cvError}`);
      }
    }
    if (ws.cvStatus === "running") setIsLiveCVRunning(true);
  }, [ws.cvStatus, ws.cvError, dataSource]);

  // ─── CV auto-save: persist the completed sweep as a StoredCVMeasurement
  // exactly once per measurementId. Mirrors EIS/FET completion flow.
  const cvSavedIdRef = useRef<string | null>(null);
  const cvWasRunningRef = useRef(false);
  useEffect(() => {
    const isCVRunning = dataSource === "simulated" ? cv.isRunning : isLiveCVRunning;
    const cvDataLive = dataSource === "simulated" ? cv.data : ws.cvData;
    // Detect transition true → false with sufficient data.
    const justFinished = cvWasRunningRef.current && !isCVRunning;
    cvWasRunningRef.current = isCVRunning;
    if (!justFinished) return;
    if (!cvMeasurementId) return;
    if (cvSavedIdRef.current === cvMeasurementId) return;
    if (cvDataLive.length < 3) return;
    // Auto-capture into the overlay comparison view (same logic as the
    // manual "+ Capture" button) — demo only. Guarded by cvSavedIdRef below,
    // so it fires exactly once per completed sweep.
    if (demoRunning) {
      setCvOverlays((prev) => {
        const label =
          cvParams.cMM > 0 ? `${cvParams.cMM} mM` : `Blank ${prev.length + 1}`;
        const color = OVERLAY_COLORS[prev.length % OVERLAY_COLORS.length];
        const next = [
          ...prev,
          { id: newId(), label, color, data: cvDataLive.slice() },
        ];
        return next.length > 8 ? next.slice(next.length - 8) : next;
      });
    }
    const metrics = computeCVMetrics(cvDataLive, {
      scanRate_mVs: cvParams.scanRate,
      n: cvParams.n,
      cMM: cvParams.cMM,
      areaCm2: cvParams.areaCm2,
      baselineMethodInput: cvBaselineMethod,
    });
    const cleanNotes = sanitizeMeasurementNotes(cvNotes);
    const storedCv: StoredCVMeasurement = {
      id: newId(),
      mode: "cv",
      timestamp: Date.now(),
      concentration: cvParams.cMM,
      measurementId: cvMeasurementId,
      measurementTimestamp: cvMeasurementTimestamp,
      notes: cleanNotes,
      params: { ...cvParams },
      data: cvDataLive.slice(),
      metrics: metrics ?? null,
    };
    cvSavedIdRef.current = cvMeasurementId;
    if (hasAnyNotes(cleanNotes)) setCvPreviousNotes(cleanNotes!);
    setSessionMeasurements((prev) => [...prev, storedCv]);
    logActivity(
      "measurement",
      `CV measurement saved — id=${cvMeasurementId}, pts=${cvDataLive.length}, C=${cvParams.cMM} mM`,
    );
  }, [
    dataSource, cv.isRunning, cv.data, isLiveCVRunning, ws.cvData,
    cvMeasurementId, cvMeasurementTimestamp, cvParams, cvBaselineMethod, cvNotes,
    demoRunning,
  ]);

  // CV auto-save — Multi-Channel. CV has no point-count target (scan range
  // varies), so completion is "every enabled channel's bridge reported done"
  // rather than a count, mirroring the single-channel cv_status watcher above.
  useEffect(() => {
    if (!isMulti) return;
    const active = channels.filter((c) => c.enabled);
    if (active.length === 0) {
      cvMultiSavedRef.current = false;
      return;
    }
    const allDone = channels.every((c, i) => !c.enabled || wsChannels[i].cvStatus === "done");
    if (!allDone) {
      cvMultiSavedRef.current = false;
      return;
    }
    if (cvMultiSavedRef.current) return;
    cvMultiSavedRef.current = true;
    saveChannelMeasurements("cv");
    toast.success("Multi-Channel CV sweep complete — all channels saved.");
  }, [channels, ws1.cvStatus, ws2.cvStatus, ws3.cvStatus, isMulti]);

  // SWV auto-save — Multi-Channel. Same "all channels done" status watcher.
  useEffect(() => {
    if (!isMulti) return;
    const active = channels.filter((c) => c.enabled);
    if (active.length === 0) {
      swvMultiSavedRef.current = false;
      return;
    }
    const allDone = channels.every((c, i) => !c.enabled || wsChannels[i].swvStatus === "done");
    if (!allDone) {
      swvMultiSavedRef.current = false;
      return;
    }
    if (swvMultiSavedRef.current) return;
    swvMultiSavedRef.current = true;
    saveChannelMeasurements("swv");
    toast.success("Multi-Channel SWV sweep complete — all channels saved.");
  }, [channels, ws1.swvStatus, ws2.swvStatus, ws3.swvStatus, isMulti]);

  // "Running" now means status === running, not just connected/animating
  const isEISRunning = eisStatus === "running";
  const isFETRunning = fetStatus === "running";

  // ──────────────────────────────────────────────────────────────
  // CV start / calibration helpers — shared by the toolbar buttons
  // and the guided demo so both go through identical code paths.
  // ──────────────────────────────────────────────────────────────
  const handleStartCV = (cMMOverride?: number) => {
    setCvMeasurementId(createMeasurementId("cv"));
    setCvMeasurementTimestamp(Date.now());
    const params = cMMOverride != null ? { ...cvParams, cMM: cMMOverride } : cvParams;
    if (cMMOverride != null) setCvParams(params);
    if (isMulti) {
      clearAllChannels();
      broadcastCommand("start_cv", { ...params });
      return;
    }
    if (dataSource === "simulated") {
      cv.start(params);
    } else {
      ws.clearCV();
      setIsLiveCVRunning(true);
      ws.sendCommand("start_cv", { ...params });
    }
  };

  const handleAddCvCalibrationPoint = () => {
    const cvDataNow = dataSource === "simulated" ? cv.data : ws.cvData;
    const metrics = computeCVMetrics(cvDataNow, {
      scanRate_mVs: cvParams.scanRate,
      n: cvParams.n,
      cMM: cvParams.cMM,
      areaCm2: cvParams.areaCm2,
      baselineMethodInput: cvBaselineMethod,
    });
    if (!metrics) {
      toast.error("No CV metrics yet — run a CV sweep first.");
      return;
    }
    const cleanNotes = sanitizeMeasurementNotes(cvNotes);
    const pt = buildCVCalibrationPoint(cvParams.cMM, metrics, cvParams.cvModel, {
      measurementId: cvMeasurementId,
      sampleId: cleanNotes?.sampleId,
      electrodeId: cleanNotes?.electrodeId,
      notes: shortNotesSummary(cleanNotes),
      timestamp: cvMeasurementTimestamp,
    });
    // Always append — replicates (including blank replicates) are
    // required for LOD estimation.
    setCvCalibration((prev) => [...prev, pt]);
    if (hasAnyNotes(cleanNotes)) setCvPreviousNotes(cleanNotes!);
    logActivity(
      "calibration",
      `CV calibration point added — C=${cvParams.cMM} mM, response=${
        responseFor(pt, cvResponseMode)?.toFixed(2) ?? "n/a"
      } µA`,
    );
    toast.success(`Added CV point at ${cvParams.cMM} mM`);
  };

  // ──────────────────────────────────────────────────────────────
  // GUIDED DEMO — runs a full simulated session across all 4 modes.
  // ──────────────────────────────────────────────────────────────
  // (demoRunning / demoStep / demoCancelledRef are declared near the top so
  // completion handlers defined earlier can read them.)

  // Status mirrors so the polling loop never reads a stale closure.
  const eisStatusRef = useRef(eisStatus);
  const fetStatusRef = useRef(fetStatus);
  const cvRunningRef = useRef(false);
  const cvPointsRef = useRef(0);
  const swvCtrlRef = useRef<SWVController | null>(swvCtrl);
  useEffect(() => { eisStatusRef.current = eisStatus; }, [eisStatus]);
  useEffect(() => { fetStatusRef.current = fetStatus; }, [fetStatus]);
  useEffect(() => {
    cvRunningRef.current = dataSource === "simulated" ? cv.isRunning : isLiveCVRunning;
    cvPointsRef.current = (dataSource === "simulated" ? cv.data : ws.cvData).length;
  }, [dataSource, cv.isRunning, cv.data, isLiveCVRunning, ws.cvData]);
  useEffect(() => { swvCtrlRef.current = swvCtrl; }, [swvCtrl]);

  // Handlers captured fresh every render — the async demo steps must never
  // call a stale closure (state read inside them would be out of date).
  const latestRef = useRef({
    handleStartEIS, handleStartFET, handleStartCV,
    handleFitRandles, handleAddCvCalibrationPoint,
    handleAddEisCalibrationPoint, handleAddFetCalibrationPoint,
  });
  latestRef.current = {
    handleStartEIS, handleStartFET, handleStartCV,
    handleFitRandles, handleAddCvCalibrationPoint,
    handleAddEisCalibrationPoint, handleAddFetCalibrationPoint,
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // "Start All" — one-shot parallel start of whatever is currently idle.
  const isCVRunningNow = dataSource === "simulated" ? cv.isRunning : isLiveCVRunning;
  const isAnyTechniqueRunning =
    eisStatus === "running" || isCVRunningNow ||
    (swvCtrl?.isRunning ?? false) || fetStatus === "running";

  async function handleStartAll() {
    const steps: { label: string; run: () => void | Promise<void> }[] = [
      { label: "EIS", run: () => { if (eisStatus !== "running") handleStartEIS(); } },
      { label: "CV", run: () => { if (!isCVRunningNow) handleStartCV(); } },
      { label: "SWV", run: () => { if (!swvCtrl?.isRunning) swvCtrl?.start(); } },
      { label: "BioFET", run: () => { if (fetStatus !== "running") handleStartFET(); } },
    ];

    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        console.error(`[Start All] ${step.label} failed:`, err);
        toast.error(
          `Start All: ${step.label} failed to start — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await sleep(150);
    }
  }




  const waitForStatus = (check: () => boolean, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        if (demoCancelledRef.current) return reject(new Error("cancelled"));
        if (check()) return resolve();
        if (Date.now() - startedAt > timeoutMs) return reject(new Error("timeout"));
        requestAnimationFrame(poll);
      };
      poll();
    });

  const runEisStep = async (conc: number) => {
    setMode("eis");
    setConcentration(conc);
    await sleep(60); // let the concentration state land before completion reads it
    latestRef.current.handleStartEIS(conc);
    // Wait for the NEW sweep to actually start before waiting for it to
    // finish — a stale "complete" from the previous step would otherwise
    // resolve this instantly.
    await waitForStatus(() => eisStatusRef.current === "running", 8000);
    await waitForStatus(() => eisStatusRef.current === "complete", 20000);
    await sleep(300);
    latestRef.current.handleFitRandles();
    await sleep(200);
    latestRef.current.handleAddEisCalibrationPoint();
    await sleep(300);
  };

  const runCvStep = async (conc_mM: number) => {
    setMode("cv");
    latestRef.current.handleStartCV(conc_mM);
    // Wait for the sweep to actually start before waiting for it to finish,
    // otherwise stale "not running" state resolves the wait immediately.
    await waitForStatus(() => cvRunningRef.current, 8000);
    await waitForStatus(
      () => !cvRunningRef.current && cvPointsRef.current > 3,
      60000,
    );
    await sleep(300);
    latestRef.current.handleAddCvCalibrationPoint();
    await sleep(200);
  };

  const runSwvStep = async (conc_nM: number) => {
    setMode("swv");
    setSwvParams((prev) => ({ ...prev, concentration_nM: conc_nM }));
    // SWV Mode mounts lazily — wait until it hands us its controller.
    await waitForStatus(() => !!swvCtrlRef.current, 10000);
    await sleep(150);
    swvCtrlRef.current?.start();
    await waitForStatus(() => !!swvCtrlRef.current?.isRunning, 8000);
    await waitForStatus(
      () => !!swvCtrlRef.current && !swvCtrlRef.current.isRunning && swvCtrlRef.current.hasData,
      90000,
    );
    await sleep(300);
    swvCtrlRef.current?.addCalibration();
    await sleep(200);
  };

  const runFetStep = async (conc: number) => {
    setMode("fet");
    setConcentration(conc);
    await sleep(60);
    latestRef.current.handleStartFET(conc);
    await waitForStatus(() => fetStatusRef.current === "running", 8000);
    await waitForStatus(() => fetStatusRef.current === "complete", 30000);
    await sleep(300);
    latestRef.current.handleAddFetCalibrationPoint();
    await sleep(200);
  };

  const eisPhaseSteps = [
    { label: "EIS @ 0 nM", run: () => runEisStep(0) },
    { label: "EIS @ 10 nM", run: () => runEisStep(10) },
    { label: "EIS @ 100 nM", run: () => runEisStep(100) },
  ];
  const cvPhaseSteps = [
    { label: "CV @ 1 mM", run: () => runCvStep(1) },
    { label: "CV @ 5 mM", run: () => runCvStep(5) },
    { label: "CV @ 10 mM", run: () => runCvStep(10) },
  ];
  const swvPhaseSteps = [
    { label: "SWV scan @ 0 nM", run: () => runSwvStep(0) },
    { label: "SWV scan @ 10 nM", run: () => runSwvStep(10) },
    { label: "SWV scan @ 50 nM", run: () => runSwvStep(50) },
  ];
  const fetPhaseSteps = [
    { label: "BioFET run @ 0 nM", run: () => runFetStep(0) },
    { label: "BioFET run @ 10 nM", run: () => runFetStep(10) },
    { label: "BioFET run @ 100 nM", run: () => runFetStep(100) },
  ];
  const PHASE_STEPS: Record<
    "eis" | "cv" | "swv" | "fet",
    { label: string; run: () => Promise<void> }[]
  > = { eis: eisPhaseSteps, cv: cvPhaseSteps, swv: swvPhaseSteps, fet: fetPhaseSteps };

  const cancelDemo = () => {
    demoCancelledRef.current = true;
    toast.info("Demo cancelled — stopping after the current step.");
  };

  const runDemoPhase = async (phase: "eis" | "cv" | "swv" | "fet") => {
    if (demoRunning) return;
    setDemoRunning(true);
    demoCancelledRef.current = false;
    try {
      for (const [i, step] of PHASE_STEPS[phase].entries()) {
        if (demoCancelledRef.current) {
          toast.info("Demo stopped.");
          setDemoPhase("idle");
          return;
        }
        setDemoStep(i + 1);
        toast.info(`Demo: running ${step.label}…`);
        await step.run();
      }
      // Each phase's steps were just auto-captured into that mode's overlay
      // comparison view (see the demoRunning branch in each sweep-complete
      // handler) — switch the corresponding overlay toggle on so it's
      // visible immediately instead of requiring a manual click.
      if (phase === "eis") setOverlayMode(true);
      else if (phase === "cv") setCvOverlayMode(true);
      else if (phase === "fet") setFetOverlayMode(true);
      const idx = PHASE_ORDER.indexOf(phase);
      const next: DemoPhase = idx + 1 < PHASE_ORDER.length ? PHASE_ORDER[idx + 1] : "done";
      setDemoPhase(next);
      if (next === "done") {
        toast.success(
          "Demo complete! Explore the results, calibration curves, and export options.",
        );
      } else {
        toast.success(
          `${PHASE_LABEL[phase]} demo done — review the results, then click "Continue to ${PHASE_LABEL[next]} Mode" when ready.`,
        );
      }
    } catch (err) {
      if (demoCancelledRef.current) toast.info("Demo stopped.");
      else toast.error(`Demo step failed during the ${PHASE_LABEL[phase]} phase.`);
      console.warn("[Demo]", err);
      setDemoPhase("idle");
    } finally {
      setDemoRunning(false);
      setDemoStep(0);
    }

  };


  // Data shown in Signal Quality (frozen after stop/complete)
  const sqEisData = frozenEis ?? eisData;
  const sqFetBaseline = frozenFetBaseline ?? fetBaselineData;
  const sqFetAnalyte = frozenFetAnalyte ?? fetAnalyteData;

  // Live computed parameters for the calibration panel
  const liveEisParams = useMemo(() => computeEISParams(sqEisData), [sqEisData]);
  const liveFetVt = useMemo(() => computeFETVt(sqFetAnalyte), [sqFetAnalyte]);
  const liveFetVtBaseline = useMemo(() => computeFETVt(sqFetBaseline), [sqFetBaseline]);

  // Add a sample-addition marker at the current time on the FET time trace.
  // If clicked BEFORE the sweep starts (no data yet and not running), prompt
  // the user for the intended injection time and wire it into fetParams so
  // the simulated binding onset uses it. Otherwise just place a visual
  // marker — past simulated behaviour cannot be changed retroactively.
  const handleAddFetMarker = () => {
    const isPreStart = !fetTime.isRunning && fetTimeDataArr.length === 0;
    if (isPreStart) {
      const raw = window.prompt(
        "Injection time (s) — used as simulated binding onset when the sweep starts:",
        String(fetParams.injectionTime_s),
      );
      if (raw == null) return;
      const t = parseFloat(raw);
      if (!Number.isFinite(t) || t < 0) {
        toast.error("Invalid injection time");
        return;
      }
      setFetParams((p) => ({ ...p, injectionTime_s: t }));
      const label = `Injection planned — t = ${t.toFixed(1)} s`;
      setFetMarkers((prev) => [...prev, { time: t, label }]);
      logActivity("sample", `Injection time preset to t=${t.toFixed(1)} s (concentration=${concentration} nM)`);
      toast.success(label);
      return;
    }
    const last = fetTimeDataArr[fetTimeDataArr.length - 1];
    const t = last ? last.time : 0;
    const label = `Sample added — t = ${t.toFixed(1)} s`;
    setFetMarkers((prev) => [...prev, { time: t, label }]);
    logActivity("sample", `Sample added at t=${t.toFixed(1)} s (concentration=${concentration} nM)`);
    toast.success(label);
    toast("Marker placed — note: simulated binding onset is fixed at sweep start settings.");
  };

  // Clear the entire stored session
  const handleClearSession = () => {
    clearSession();
    clearActivityLog();
    logActivity("system", "Session cleared by user");
    setSessionMeasurements([]);
    setEisCalibration([]);
    setFetCalibration([]);
    setEisOverlays([]);
    setCvCalibration([]);
      setCvOverlays([]);
    toast("Session cleared");
  };

  // Export calibration table as TSV
  const exportCalibrationCSV = () => {
    if (mode === "cv" || mode === "swv" || mode === "dashboard") return;
    const list = mode === "eis" ? eisCalibration : fetCalibration;
    if (list.length === 0) return;
    exportCalibrationTSV(mode, list, exportSource);
  };

  const handleChangeSource = (source: "simulated" | "live" | "multichannel") => {
    // Reset everything when switching
    eis.reset();
    fetTransfer.reset();
    fetTime.reset();
    cv.reset();
    ws.clearCV();
    setIsLiveCVRunning(false);
    ws.clearEIS();
    ws.clearFET();
    setEisStatus("idle");
    setFetStatus("idle");
    setFrozenEis(null);
    setFrozenFetBaseline(null);
    setFrozenFetAnalyte(null);
    eisAutoStopFiredRef.current = false;
    fetAutoStopFiredRef.current = false;
    if (source === "simulated" && ws.status === "connected") {
      ws.disconnect();
    }
    if (source !== "multichannel") {
      wsChannels.forEach((c) => { if (c.status === "connected") c.disconnect(); });
    }
    if (source === "multichannel" && ws.status === "connected") {
      ws.disconnect();
    }
    setDataSource(source);
  };

  const sourceLabel = dataSource === "simulated" ? "Simulated Data" : (
    ws.status === "connected" ? "Live — Connected" : "Live — Not Connected"
  );

  // BioFET display label — sourced from the logbook's "Analyte" field (the
  // single place this is recorded) so charts/labels never disagree with what
  // gets exported. "Cortisol" is only the fallback shown before the user
  // types anything, matching the worked example the app ships with.
  const fetAnalyteName = fetNotes.analyte || "Cortisol";

  // ── Start / stop for the currently visible technique (used by shortcuts) ──
  const startCurrentMode = () => {
    if (mode === "eis") handleStartEIS();
    else if (mode === "fet") handleStartFET();
    else if (mode === "cv") handleStartCV();
    else if (mode === "swv") swvCtrl?.start();
  };
  const stopCurrentMode = () => {
    if (mode === "eis") handleStopEIS();
    else if (mode === "fet") handleStopFET();
    else if (mode === "cv") {
      if (dataSource === "simulated") cv.stop();
      else { setIsLiveCVRunning(false); ws.sendCommand("stop"); }
    } else if (mode === "swv") swvCtrl?.stop();
  };
  const currentModeRunning =
    mode === "eis" ? isEISRunning
      : mode === "fet" ? isFETRunning
        : mode === "cv" ? isCVRunningNow
          : mode === "swv" ? (swvCtrl?.isRunning ?? false)
            : false;

  // Dynamic tab title while a sweep is recording.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const base = "ElectroStat — EIS, CV, SWV & BioFET Biosensor Dashboard";
    document.title = isAnyTechniqueRunning
      ? `● Recording ${mode.toUpperCase()} — ElectroStat`
      : base;
    return () => { document.title = base; };
  }, [isAnyTechniqueRunning, mode]);

  // Keyboard shortcuts: Space = start/stop current technique, E = export session.
  const shortcutRef = useRef({ startCurrentMode, stopCurrentMode, currentModeRunning });
  shortcutRef.current = { startCurrentMode, stopCurrentMode, currentModeRunning };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        const s = shortcutRef.current;
        if (s.currentModeRunning) s.stopCurrentMode(); else s.startCurrentMode();
      } else if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        exportSessionButtonRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Warn when the live link drops in the middle of a running sweep.
  const liveDropped =
    dataSource === "live" && isAnyTechniqueRunning && ws.status !== "connected";

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      {liveDropped && (
        <div
          role="alert"
          className="mb-4 flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs font-mono text-foreground sm:flex-row sm:items-center sm:justify-between"
        >
          <span>
            ⚠ Connection lost during the {mode.toUpperCase()} sweep — incoming data has stopped.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-xs"
            disabled={!lastWsUrl || ws.status === "connecting"}
            onClick={() => ws.connect(lastWsUrl)}
          >
            ↻ Reconnect
          </Button>
        </div>
      )}
      {/* Header */}
      <DashboardHeader
        sourceLabel={sourceLabel}
        autosaveStatus={autosaveStatus}
        exportSessionButtonRef={exportSessionButtonRef}
        onExportSession={() =>
          exportSessionCSV(sessionMeasurements, {
            source: exportSource,
            calibration: [
              ...eisCalibration.map((p) => ({ ...p, mode: "eis" as const })),
              ...fetCalibration.map((p) => ({ ...p, mode: "fet" as const })),
            ],
          })
        }
        sessionMeasurementsCount={sessionMeasurements.length}
        onClearSession={handleClearSession}
        dataSource={dataSource}
        wsStatus={ws.status}
        demoPhase={demoPhase}
        demoRunning={demoRunning}
        demoStep={demoStep}
        onStartDemo={() => runDemoPhase("eis")}
        onContinueDemo={() => {
          if (demoPhase === "eis" || demoPhase === "cv" || demoPhase === "swv" || demoPhase === "fet") {
            runDemoPhase(demoPhase);
          }
        }}
        onCancelDemo={cancelDemo}
        onResetDemo={() => setDemoPhase("idle")}
      />

      {/* Connection Panel */}
      <div className="mb-4 space-y-2">
        <ConnectionPanel
          dataSource={dataSource}
          onChangeSource={handleChangeSource}
          connectionStatus={ws.status}
          errorMessage={ws.errorMessage}
          onConnect={(url) => { setHasAttemptedConnection(true); setLastWsUrl(url); ws.connect(url); }}
          onDisconnect={ws.disconnect}
          multiConnectedCount={connectedCount}
          multiEnabledCount={enabledCount}
        />
        {isMulti && (
          <MultiChannelPanel
            channels={channels}
            statuses={wsChannels.map((c) => c.status)}
            errors={wsChannels.map((c) => c.errorMessage)}
            onToggleEnabled={(i, enabled) =>
              setChannels((prev) => prev.map((c, idx) => (idx === i ? { ...c, enabled } : c)))
            }
            onChangeUrl={(i, url) =>
              setChannels((prev) => prev.map((c, idx) => (idx === i ? { ...c, url } : c)))
            }
            onRename={(i, label) =>
              setChannels((prev) => prev.map((c, idx) => (idx === i ? { ...c, label } : c)))
            }
            onToggleAutoReconnect={(i, autoReconnect) =>
              setChannels((prev) => prev.map((c, idx) => (idx === i ? { ...c, autoReconnect } : c)))
            }
            onConnect={(i) => {
              setWantConnected((prev) => prev.map((v, idx) => (idx === i ? true : v)));
              wsChannels[i].connect(channels[i].url);
            }}
            onDisconnect={(i) => {
              setWantConnected((prev) => prev.map((v, idx) => (idx === i ? false : v)));
              wsChannels[i].disconnect();
            }}
            layout={multiChannelLayout}
            onChangeLayout={setMultiChannelLayout}
            showLayoutToggle={
              channels.filter((c, i) => c.enabled && wsChannels[i].status === "connected").length >= 2
            }
          />
        )}
        {isMulti && staleChannels.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs space-y-1">
            <p className="text-amber-400 font-medium">
              ⚠ {staleChannels.length} enabled channel{staleChannels.length > 1 ? "s are" : " is"} not connected
              {" "}({staleChannels.map((c) => c.label).join(", ")})
            </p>
            <p className="text-muted-foreground">
              Data from {staleChannels.length > 1 ? "these sensors" : "this sensor"} will be missing from the
              plots and exports. Connect {staleChannels.length > 1 ? "them" : "it"} or disable the channel to
              silence this warning.
            </p>
          </div>
        )}
        {dataSource === "live" && hasAttemptedConnection &&
          (ws.status === "error" || ws.status === "disconnected") && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs space-y-1">
            <p className="text-destructive font-medium">
              ⚠ {ws.status === "error" ? "Connection failed" : "Disconnected"}
              {ws.errorMessage ? ` — ${ws.errorMessage}` : ""}
            </p>
            <ul className="text-muted-foreground list-disc list-inside space-y-0.5">
              <li>Is bridge.py running on your computer?</li>
              <li>Are you connected to the ESP32's WiFi (or is the IP correct)?</li>
              <li>Does the address match what bridge.py printed on startup (usually ws://127.0.0.1:81)?</li>
              <li>Try clicking Connect again after checking the above.</li>
            </ul>
          </div>
        )}
      </div>

      {/* Measurement Parameters */}
      <div className={mode === "dashboard" ? "hidden" : "mb-4"}>
        <ParametersPanel
          mode={mode === "dashboard" ? "eis" : mode}
          eisParams={eisParams}
          fetParams={fetParams}
          cvParams={cvParams}
          swvParams={swvParams}
          onChangeEIS={setEisParams}
          onChangeFET={setFetParams}
          onChangeCV={setCvParams}
          onChangeSWV={setSwvParams}
          disabled={
            mode === "eis" ? isEISRunning :
            mode === "fet" ? isFETRunning :
            mode === "swv" ? (swvCtrl?.isRunning ?? false) :
            (dataSource === "simulated" ? cv.isRunning : isLiveCVRunning)
          }
        />
      </div>

      {/* Mode selection */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button
            variant={mode === "eis" ? "default" : "secondary"}
            size="sm"
            onClick={() => setMode("eis")}
            className="font-mono text-xs"
          >
            EIS Mode
          </Button>
          <Button
            variant={mode === "fet" ? "default" : "secondary"}
            size="sm"
            onClick={() => setMode("fet")}
            className="font-mono text-xs"
          >
            BioFET Mode
          </Button>
          <Button
            variant={mode === "cv" ? "default" : "secondary"}
            size="sm"
            onClick={() => setMode("cv")}
            className="font-mono text-xs"
          >
            CV Mode
          </Button>
          <Button
            variant={mode === "swv" ? "default" : "secondary"}
            size="sm"
            onClick={() => setMode("swv")}
            className="font-mono text-xs"
          >
            SWV Mode
          </Button>
          <Button
            variant={mode === "dashboard" ? "default" : "secondary"}
            size="sm"
            onClick={() => setMode("dashboard")}
            className="font-mono text-xs"
          >
            Dashboard
          </Button>
        </div>

        {mode === "dashboard" && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleStartAll}
            disabled={isAnyTechniqueRunning}
            className="font-mono text-xs ml-auto"
          >
            {isAnyTechniqueRunning ? "● Running…" : "▶ Start All"}
          </Button>
        )}




        {/* Controls */}
        <div className="flex flex-wrap gap-2">
          {mode === "eis" && (
            <>
              <Button size="sm" onClick={() => handleStartEIS()} disabled={isEISRunning || demoRunning || liveNotReady} className="font-mono text-xs">▶ Start EIS</Button>
              <Button size="sm" variant="destructive" onClick={handleStopEIS} disabled={!isEISRunning || demoRunning} className="font-mono text-xs">■ Stop</Button>
              <Button size="sm" variant="secondary" onClick={handleResetEIS} disabled={demoRunning} className="font-mono text-xs">↺ Reset</Button>
              <Button size="sm" variant="outline" onClick={() => exportEISData(eisData, exportSource, {
                notes: sanitizeMeasurementNotes(eisNotes),
                measurementId: eisMeasurementId,
                measurementTimestamp: eisMeasurementTimestamp,
                cnlsFit,
                randlesFit,
                linKK,
                warburg,
                fitRangeMinHz: cnlsFit?.fitFreqRange?.min ?? randlesFit?.fitFreqRange?.min,
                fitRangeMaxHz: cnlsFit?.fitFreqRange?.max ?? randlesFit?.fitFreqRange?.max,
                fitSource: cnlsFit ? (circuitModel === "randles-cpe" ? "manual_cnls_randles_cpe" : "manual_cnls_randles") : randlesFit?.auto ? "auto_cnls_randles" : randlesFit ? "manual_randles" : "geometric",
              })} disabled={eisData.length === 0} className="font-mono text-xs">⬇ Export CSV</Button>
            </>
          )}
          {mode === "fet" && (
            <>
              <Button size="sm" onClick={() => handleStartFET()} disabled={isFETRunning || demoRunning || liveNotReady} className="font-mono text-xs">▶ Start FET</Button>
              <Button size="sm" variant="destructive" onClick={handleStopFET} disabled={!isFETRunning || demoRunning} className="font-mono text-xs">■ Stop</Button>
              <Button size="sm" variant="secondary" onClick={handleResetFET} disabled={demoRunning} className="font-mono text-xs">↺ Reset</Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const meta = {
                    notes: sanitizeMeasurementNotes({ ...fetNotes, analyte: fetAnalyteName }),
                    measurementId: fetMeasurementId,
                    measurementTimestamp: fetMeasurementTimestamp,
                  };
                  const priorSigned = fetCalibration
                    .filter((p) => p.concentration > 0 && typeof p.deltaVt_mV_signed === "number")
                    .map((p) => p.deltaVt_mV_signed as number);
                  const sign = inferFETResponseSign(priorSigned);
                  const m = computeFETTransferMetrics(fetBaselineData, fetAnalyteData, {
                    responseMode: fetResponseMode,
                    responseSign: sign,
                  });
                  exportFETData({
                    baseline: fetBaselineData,
                    analyte: fetAnalyteData,
                    timeData: fetTimeDataArr,
                    markers: fetMarkers,
                    source: exportSource,
                    meta,
                    concentration,
                    params: {
                      vgMin: fetParams.vgMin,
                      vgMax: fetParams.vgMax,
                      vgStep: fetParams.vgStep,
                      intervalMs: fetParams.intervalMs,
                      kd_nM: fetParams.kd_nM,
                      vtBaseline_V: fetParams.vtBaseline_V,
                      deltaVtMax_V: fetParams.deltaVtMax_V,
                      idMax_uA: fetParams.idMax_uA,
                      idealityFactor: fetParams.idealityFactor,
                      bindingRate_perS: fetParams.bindingRate_perS,
                      readoutBias_V: fetParams.readoutBias_V,
                      timeDuration_s: fetParams.timeDuration_s,
                      timeStep_s: fetParams.timeStep_s,
                      injectionTime_s: fetParams.injectionTime_s,
                    },
                    metrics: m,
                    responseMode: fetResponseMode,
                    responseSign: m.responseSign,
                  });
                }}
                disabled={fetBaselineData.length === 0 && fetTimeDataArr.length === 0}
                className="font-mono text-xs"
              >⬇ Export CSV</Button>
            </>
          )}
          {mode === "cv" && (
            <>
              <Button
                size="sm"
                onClick={() => handleStartCV()}
                disabled={
                  (dataSource === "simulated" ? cv.isRunning : isLiveCVRunning) ||
                  demoRunning ||
                  liveNotReady
                }
                className="font-mono text-xs"
              >▶ Start CV</Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  if (isMulti) { cvMultiSavedRef.current = true; saveChannelMeasurements("cv"); broadcastCommand("stop"); return; }
                  if (dataSource === "simulated") cv.stop();
                  else { setIsLiveCVRunning(false); ws.sendCommand("stop"); }
                }}
                disabled={isMulti ? !anyChannelConnected : ((dataSource === "simulated" ? !cv.isRunning : !isLiveCVRunning) || demoRunning)}
                className="font-mono text-xs"
              >■ Stop</Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (isMulti) { clearAllChannels(); broadcastCommand("stop"); return; }
                  cv.reset(); ws.clearCV(); setIsLiveCVRunning(false);
                }}
                disabled={demoRunning}
                className="font-mono text-xs"
              >↺ Reset</Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const data = dataSource === "simulated" ? cv.data : ws.cvData;
                  const metrics = computeCVMetrics(data, {
                    scanRate_mVs: cvParams.scanRate,
                    n: cvParams.n,
                    cMM: cvParams.cMM,
                    areaCm2: cvParams.areaCm2,
                    baselineMethodInput: cvBaselineMethod,
                  });
                  const cleanNotes = sanitizeMeasurementNotes(cvNotes);
                  exportCVData(
                    data,
                    metrics,
                    {
                      ...cvParams,
                      notes: cleanNotes,
                      measurementId: cvMeasurementId,
                      measurementTimestamp: cvMeasurementTimestamp,
                    },
                    exportSource,
                    cvPlotMode,
                  );
                }}
                disabled={(dataSource === "simulated" ? cv.data.length : ws.cvData.length) === 0}
                className="font-mono text-xs"
              >⬇ Export CSV</Button>
            </>
          )}
          {mode === "swv" && (
            <>
              <Button size="sm" onClick={() => { if (isMulti) { clearAllChannels(); broadcastCommand("start_swv", { ...swvParams }); return; } swvCtrl?.start(); }} disabled={isMulti ? !anyChannelConnected : (!swvCtrl || swvCtrl.isRunning || demoRunning)} className="font-mono text-xs">▶ Start SWV</Button>
              <Button size="sm" variant="destructive" onClick={() => { if (isMulti) { swvMultiSavedRef.current = true; saveChannelMeasurements("swv"); broadcastCommand("stop"); return; } swvCtrl?.stop(); }} disabled={!swvCtrl?.isRunning || demoRunning} className="font-mono text-xs">■ Stop</Button>
              <Button size="sm" variant="secondary" onClick={() => { if (isMulti) { clearAllChannels(); broadcastCommand("stop"); return; } swvCtrl?.reset(); }} disabled={demoRunning} className="font-mono text-xs">↺ Reset</Button>
              <Button size="sm" variant="outline" onClick={() => swvCtrl?.exportCsv()} disabled={!swvCtrl?.hasData} className="font-mono text-xs">⬇ Export CSV</Button>
            </>
          )}
        </div>
      </div>

      {isMulti && (
        <div className="mb-4">
          <MultiChannelView
            mode={mode}
            channels={channels}
            wsChannels={wsChannels}
            layout={multiChannelLayout}
            e0Prime={cvParams.formalPotential ?? CV_E0_PRIME}
          />
        </div>
      )}

      {/* EIS MODE */}
      {mode === "eis" && !isMulti && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <Tabs defaultValue="nyquist" className="w-full">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <TabsList className="bg-secondary">
              <TabsTrigger value="nyquist" className="font-mono text-xs">Nyquist Plot</TabsTrigger>
              <TabsTrigger value="bode" className="font-mono text-xs">Bode Plot</TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={overlayMode ? "default" : "outline"}
                onClick={() => setOverlayMode((v) => !v)}
                className="font-mono text-xs"
              >
                Overlay {overlayMode ? "ON" : "OFF"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (eisData.length === 0) return;
                  setEisOverlays((prev) => {
                    const label =
                      concentration > 0 ? `${concentration} nM` : `Measurement ${prev.length + 1}`;
                    const color = OVERLAY_COLORS[prev.length % OVERLAY_COLORS.length];
                    const next = [
                      ...prev,
                      { id: newId(), label, color, data: eisData.slice() },
                    ];
                    return next.length > 8 ? next.slice(next.length - 8) : next;
                  });
                }}
                disabled={eisData.length === 0}
                className="font-mono text-xs"
              >＋ Capture</Button>
              <Hint text="Import a previously exported ElectroStat EIS CSV as an overlay">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    importOverlayCsv("eis", ({ measurements }) => {
                      setEisOverlays((prev) => {
                        let next = prev.slice();
                        for (const m of measurements) {
                          const color = OVERLAY_COLORS[next.length % OVERLAY_COLORS.length];
                          next = [
                            ...next,
                            { id: newId(), label: m.label, color, data: m.points as EISDataPoint[] },
                          ];
                        }
                        return next.length > 8 ? next.slice(next.length - 8) : next;
                      });
                    })
                  }
                  className="font-mono text-xs"
                >⇪ Import CSV</Button>
              </Hint>

              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEisOverlays([])}
                disabled={eisOverlays.length === 0}
                className="font-mono text-xs"
              >
                Clear All ({eisOverlays.length})
              </Button>
              <StatusIndicator
                isRunning={isEISRunning && eisData.length > 0}
                label={isEISRunning && eisData.length > 0 ? "Sweeping..." : "Idle"}
                dataPoints={eisData.length}
              />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-3">
            <TabsContent value="nyquist" className="mt-0 h-[440px] md:h-[540px] overflow-visible">
              <NyquistPlot
                data={eisData}
                fittedCurve={cnlsFit?.fittedCurve ?? randlesFit?.fittedCurve}
                overlays={overlayMode ? eisOverlays : []}
                showSeparator={eisStatus === "complete" && separatorZReal != null}
                separatorZReal={separatorZReal}
                onSeparatorChange={(v) => setSeparatorZReal(v)}
              />
            </TabsContent>
            <TabsContent value="bode" className="mt-0 h-[400px] md:h-[500px]">
              <BodePlot data={eisData} overlays={overlayMode ? eisOverlays : []} />
            </TabsContent>
          </div>

          {eisStatus === "complete" && separatorZReal != null && (
            <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs font-mono text-muted-foreground">
                {eisFitted
                  ? "Fit applied. Adjust separator or model and click Re-fit."
                  : "Sweep complete. Choose a circuit, adjust the separator, then click Fit."}
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={circuitModel}
                  onValueChange={(v) => setCircuitModel(v as CircuitModel)}
                >
                  <SelectTrigger className="h-8 w-[210px] font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="randles" className="font-mono text-xs">
                      Randles (Rs + Rct ∥ Cdl)
                    </SelectItem>
                    <SelectItem value="randles-cpe" className="font-mono text-xs">
                      Randles + CPE
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={handleFitRandles}
                  className="font-mono text-xs"
                >
                  {eisFitted ? "↻ Re-fit" : "▶ Fit Circuit"}
                </Button>
              </div>
            </div>
          )}

          <SweepProgress
            status={eisStatus}
            current={eisData.length}
            expected={expectedEisPoints}
          />

          {dataSource === "live" && ws.lastFilename && (
            <div className="mt-2 text-[11px] font-mono text-muted-foreground flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-graph-primary animate-pulse" />
              Receiving: <span className="text-foreground">{ws.lastFilename}</span>
              <span className="text-muted-foreground">— {eisData.length} / {expectedEisPoints} pts</span>
            </div>
          )}

          {eisData.length > 0 && (
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
              {(() => {
                // Prefer CNLS fit result over auto Randles fit
                const rs = cnlsFit?.params?.Rs ?? randlesFit?.Rs ?? eisData[0]?.zReal ?? null;
                const rct = cnlsFit?.params?.Rct ?? randlesFit?.Rct ?? null;
                const fLo = eisData[0]?.frequency;
                const fHi = eisData[eisData.length - 1]?.frequency;
                return [
                  { label: "Rs (Solution)", value: rs != null ? `${rs.toFixed(1)} Ω` : "—" },
                  { label: "Rct (Charge Transfer)", value: rct != null ? `${rct.toFixed(1)} Ω` : "—" },
                  {
                    label: "Freq Range",
                    value:
                      fLo != null && fHi != null
                        ? `${fLo.toFixed(1)} – ${fHi.toFixed(1)} Hz`
                        : "—",
                  },
                  { label: "Points", value: `${eisData.length}` },
                ];
              })().map((item) => (
                <div key={item.label} className="bg-secondary rounded-md p-2">
                  <div className="text-[10px] text-muted-foreground font-mono uppercase">{item.label}</div>
                  <div className="text-sm font-mono text-foreground">{item.value}</div>
                </div>
              ))}
            </div>
          )}
        </Tabs>
        <div className="space-y-4">
          <SignalQuality mode="eis" eisData={sqEisData} fetBaseline={sqFetBaseline} fetAnalyte={sqFetAnalyte} cnlsChiSquared={cnlsFit?.chiSquared ?? null} separatorZReal={separatorZReal} separatorFreq={(() => { if (separatorZReal == null || sqEisData.length === 0) return null; const c = sqEisData.reduce((b, d) => Math.abs(d.zReal - separatorZReal) < Math.abs(b.zReal - separatorZReal) ? d : b, sqEisData[0]); return c.frequency; })()} linKKResidualPct={linKK?.residualRmsPct ?? null} linKKPassed={linKK?.passed ?? null} />
          <CNLSFitResults fit={cnlsFit} model={circuitModel} randlesFit={randlesFit} warburg={warburg} kk={kk} linKK={linKK} />
          <MeasurementNotesPanel
            mode="eis"
            value={eisNotes}
            onChange={setEisNotes}
            onClear={() => {
              setEisPreviousNotes(hasAnyNotes(eisNotes) ? eisNotes : eisPreviousNotes);
              setEisNotes({});
            }}
            onCopyFromPrevious={
              eisPreviousNotes ? () => setEisNotes({ ...eisPreviousNotes }) : undefined
            }
            hasPrevious={!!eisPreviousNotes}
            measurementId={eisMeasurementId}
            measurementTimestamp={eisMeasurementTimestamp}
          />
          <CalibrationPanel
            mode="eis"
            concentration={concentration}
            onChangeConcentration={handleChangeConcentration}
            points={eisCalibration}
            onClear={() => setEisCalibration([])}
            onExport={exportCalibrationCSV}
            currentRs={randlesFit?.Rs ?? liveEisParams?.rs}
            currentRct={randlesFit?.Rct ?? liveEisParams?.rct}
            geometricFallback={geometricFallback && eisStatus === "complete"}
            analyteName={eisNotes.analyte}
            onAddCurrent={handleAddEisCalibrationPoint}
            canAdd={(cnlsFit != null || randlesFit != null) && !isEISRunning}
          />
          <DummyCellCheck
            measured={
              cnlsFit && circuitModel !== "randles-cpe" && cnlsFit.params.Cdl != null
                ? { Rs: cnlsFit.params.Rs, Rct: cnlsFit.params.Rct, Cdl: cnlsFit.params.Cdl }
                : randlesFit
                  ? { Rs: randlesFit.Rs, Rct: randlesFit.Rct, Cdl: randlesFit.Cdl }
                  : null
            }
          />
        </div>
        </div>
      )}

      {/* BIOFET MODE */}
      {mode === "fet" && !isMulti && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-4">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-mono text-muted-foreground">Transfer Curve — Id vs Vg</h2>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={fetOverlayMode ? "default" : "outline"}
                  onClick={() => setFetOverlayMode((v) => !v)}
                  className="font-mono text-xs"
                >
                  Overlay {fetOverlayMode ? "ON" : "OFF"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (fetBaselineData.length === 0) return;
                    setFetOverlays((prev) => {
                      const label =
                        concentration > 0 ? `${concentration} nM` : `Measurement ${prev.length + 1}`;
                      const color = OVERLAY_COLORS[prev.length % OVERLAY_COLORS.length];
                      const next = [
                        ...prev,
                        {
                          id: newId(),
                          label,
                          color,
                          baseline: fetBaselineData.slice(),
                          withAnalyte: fetAnalyteData.slice(),
                        },
                      ];
                      return next.length > 8 ? next.slice(next.length - 8) : next;
                    });
                  }}
                  disabled={fetBaselineData.length === 0}
                  className="font-mono text-xs"
                >＋ Capture</Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    importOverlayCsv("fet_transfer", ({ measurements, fileLabel }) => {
                      setFetOverlays((prev) => {
                        const next = [...prev, ...measurements.map((m, i) => ({
                          id: newId(),
                          label: m.label ?? `${fileLabel} #${i + 1}`,
                          color: OVERLAY_COLORS[(prev.length + i) % OVERLAY_COLORS.length],
                          baseline: (m.baseline ?? []) as import("@/hooks/useSimulatedData").FETTransferPoint[],
                          withAnalyte: (m.analyte ?? []) as import("@/hooks/useSimulatedData").FETTransferPoint[],
                        }))];
                        return next.length > 8 ? next.slice(next.length - 8) : next;
                      });
                    })
                  }
                  className="font-mono text-xs"
                >⇪ Import CSV</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setFetOverlays([])}
                  disabled={fetOverlays.length === 0}
                  className="font-mono text-xs"
                >Clear All ({fetOverlays.length})</Button>

                <StatusIndicator
                  isRunning={isFETRunning && fetBaselineData.length > 0}
                  label={isFETRunning && fetBaselineData.length > 0 ? "Sweeping Vg..." : "Idle"}
                  dataPoints={fetBaselineData.length}
                />
              </div>
            </div>
            {fetOverlayMode && fetOverlays.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 text-[10px] font-mono">
                {fetOverlays.map((ov) => (
                  <span
                    key={ov.id}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5"
                  >
                    <span style={{ background: ov.color, width: 8, height: 8, borderRadius: 999 }} />
                    {ov.label}
                    <Hint text="Remove overlay">
                      <button
                        type="button"
                        aria-label={`Remove overlay: ${ov.label}`}
                        className="ml-1 text-muted-foreground hover:text-foreground"
                        onClick={() => setFetOverlays((prev) => prev.filter((p) => p.id !== ov.id))}
                      >×</button>
                    </Hint>
                  </span>
                ))}
              </div>
            )}
            <div className="rounded-lg border border-border bg-card p-3 h-[300px] md:h-[350px] overflow-visible">
              <FETTransferPlot
                baseline={fetBaselineData}
                withAnalyte={fetAnalyteData}
                overlays={fetOverlayMode ? fetOverlays : []}
                analyteName={fetAnalyteName}
              />
            </div>
          </div>


          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-mono text-muted-foreground">Time Response — Id vs Time</h2>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  onClick={handleAddFetMarker}
                  disabled={false}
                  className="font-mono text-xs"
                >
                  ＋ Add Sample
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    importOverlayCsv("fet_time", ({ measurements, fileLabel }) => {
                      setFetTimeOverlays((prev) => {
                        const next = [...prev, ...measurements.map((m, i) => ({
                          id: newId(),
                          label: m.label ?? `${fileLabel} #${i + 1}`,
                          color: OVERLAY_COLORS[(prev.length + i) % OVERLAY_COLORS.length],
                          data: (m.points ?? []) as import("@/hooks/useSimulatedData").FETTimePoint[],
                        }))];
                        return next.length > 8 ? next.slice(next.length - 8) : next;
                      });
                    })
                  }
                  className="font-mono text-xs"
                >⇪ Import CSV</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setFetTimeOverlays([])}
                  disabled={fetTimeOverlays.length === 0}
                  className="font-mono text-xs"
                >Clear All ({fetTimeOverlays.length})</Button>
                <StatusIndicator
                  isRunning={isFETRunning && fetTimeDataArr.length > 0}
                  label={isFETRunning && fetTimeDataArr.length > 0 ? "Recording..." : "Idle"}
                  dataPoints={fetTimeDataArr.length}
                />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3 h-[300px] md:h-[350px]">
              <FETTimePlot data={fetTimeDataArr} markers={fetMarkers} overlays={fetOverlayMode ? fetTimeOverlays : []} analyteName={fetAnalyteName} />

            </div>
            {fetMarkers.length > 0 && (
              <div className="mt-1 text-[11px] font-mono text-muted-foreground">
                Markers: {fetMarkers.map((m) => `t=${m.time.toFixed(1)}s`).join(" · ")}
              </div>
            )}
          </div>

          <SweepProgress
            status={fetStatus}
            current={fetReceivedTotal}
            expected={expectedFetTotal}
            phases={[
              { label: "Baseline", current: fetBaselineData.length, expected: expectedFetTransferPoints },
              { label: "Analyte", current: fetAnalyteData.length, expected: expectedFetTransferPoints },
              { label: "Time response", current: fetTimeDataArr.length, expected: expectedFetTimePoints },
            ]}
          />

          {fetBaselineData.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {(() => {
                const vtBase = computeFETVt(fetBaselineData);
                const vtShift =
                  liveFetVt != null && vtBase != null ? liveFetVt - vtBase : null;
                const baselineId =
                  fetBaselineData.length > 0
                    ? Math.min(...fetBaselineData.map((p) => p.id))
                    : null;
                const signalDrop =
                  fetAnalyteData.length > 0
                    ? Math.max(...fetAnalyteData.map((p) => p.id)) -
                      Math.min(...fetAnalyteData.map((p) => p.id))
                    : null;
                return [
                  { label: "Vth (Baseline)", value: vtBase != null ? `${vtBase.toFixed(3)} V` : "—" },
                  {
                    label: "Vth Shift",
                    value:
                      vtShift != null
                        ? `${vtShift >= 0 ? "+" : ""}${vtShift.toFixed(3)} V`
                        : "—",
                  },
                  { label: "Baseline Id", value: baselineId != null ? `${baselineId.toFixed(1)} µA` : "—" },
                  { label: "Signal Drop", value: signalDrop != null ? `${signalDrop.toFixed(1)} µA` : "—" },
                ];
              })().map((item) => (
                <div key={item.label} className="bg-secondary rounded-md p-2">
                  <div className="text-[10px] text-muted-foreground font-mono uppercase">{item.label}</div>
                  <div className="text-sm font-mono text-foreground">{item.value}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-4">
          <SignalQuality mode="fet" eisData={sqEisData} fetBaseline={sqFetBaseline} fetAnalyte={sqFetAnalyte} fetVtBaseline={liveFetVtBaseline} fetVtAnalyte={liveFetVt} />
          <MeasurementNotesPanel
            mode="fet"
            value={fetNotes}
            onChange={setFetNotes}
            onClear={() => {
              setFetPreviousNotes(hasAnyNotes(fetNotes) ? fetNotes : fetPreviousNotes);
              setFetNotes({});
            }}
            onCopyFromPrevious={
              fetPreviousNotes ? () => setFetNotes({ ...fetPreviousNotes }) : undefined
            }
            hasPrevious={!!fetPreviousNotes}
            measurementId={fetMeasurementId}
            measurementTimestamp={fetMeasurementTimestamp}
          />
          <CalibrationPanel
            mode="fet"
            concentration={concentration}
            onChangeConcentration={handleChangeConcentration}
            points={fetCalibration}
            onClear={() => setFetCalibration([])}
            onExport={exportCalibrationCSV}
            currentVt={liveFetVt ?? undefined}
            currentVtBaseline={liveFetVtBaseline ?? null}
            currentVtAnalyte={liveFetVt ?? null}
            currentDeltaVt_mV={
              liveFetVt != null && liveFetVtBaseline != null
                ? (liveFetVt - liveFetVtBaseline) * 1000
                : null
            }
            currentDeltaVtSigned_mV={
              liveFetVt != null && liveFetVtBaseline != null
                ? (liveFetVt - liveFetVtBaseline) * 1000
                : null
            }
            responseMode={fetResponseMode}
            onResponseModeChange={setFetResponseMode}
            analyteName={fetAnalyteName}
            onAddCurrent={handleAddFetCalibrationPoint}
            canAdd={(fetBaselineData.length > 0 || fetAnalyteData.length > 0) && !isFETRunning}
          />
        </div>
        </div>
      )}

      {/* CV MODE */}
      {mode === "cv" && !isMulti && (() => {
        const cvDataLive = dataSource === "simulated" ? cv.data : ws.cvData;
        const cvMetrics = computeCVMetrics(cvDataLive, {
          scanRate_mVs: cvParams.scanRate,
          n: cvParams.n,
          cMM: cvParams.cMM,
          areaCm2: cvParams.areaCm2,
          baselineMethodInput: cvBaselineMethod,
        });
        const isCVRunning = dataSource === "simulated" ? cv.isRunning : isLiveCVRunning;
        const canAddCalibration = !!cvMetrics && cvDataLive.length > 0 && !isCVRunning;
        const correctedAvailable =
          !!cvMetrics?.correctedData &&
          cvMetrics.correctedData.length === cvDataLive.length &&
          cvMetrics.correctedData.some((p) => Number.isFinite(p.Icorr));
        const baselineAvailable =
          !!cvMetrics?.correctedData &&
          cvMetrics.correctedData.some((p) => Number.isFinite(p.baseline));
        return (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-mono text-muted-foreground">Cyclic Voltammogram — I vs E</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={cvOverlayMode ? "default" : "outline"}
                    onClick={() => setCvOverlayMode((v) => !v)}
                    className="font-mono text-xs"
                  >
                    Overlay {cvOverlayMode ? "ON" : "OFF"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (cvDataLive.length === 0) return;
                      const label =
                        cvParams.cMM > 0 ? `${cvParams.cMM} mM` : `Blank ${cvOverlays.length + 1}`;
                      const color = OVERLAY_COLORS[cvOverlays.length % OVERLAY_COLORS.length];
                      setCvOverlays((prev) => {
                        const next = [...prev, { id: newId(), label, color, data: cvDataLive.slice() }];
                        return next.length > 8 ? next.slice(next.length - 8) : next;
                      });
                    }}
                    disabled={cvDataLive.length === 0}
                    className="font-mono text-xs"
                  >＋ Capture</Button>
                  <Hint text="Import a previously exported ElectroStat CV CSV as an overlay">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        importOverlayCsv("cv", ({ measurements }) => {
                          setCvOverlays((prev) => {
                            let next = prev.slice();
                            for (const m of measurements) {
                              const color = OVERLAY_COLORS[next.length % OVERLAY_COLORS.length];
                              next = [
                                ...next,
                                { id: newId(), label: m.label, color, data: m.points as CVDataPoint[] },
                              ];
                            }
                            return next.length > 8 ? next.slice(next.length - 8) : next;
                          });
                        })
                      }
  
                      className="font-mono text-xs"
                    >⇪ Import CSV</Button>
                  </Hint>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCvOverlays([])}
                    disabled={cvOverlays.length === 0}
                    className="font-mono text-xs"
                  >Clear All ({cvOverlays.length})</Button>
                  <Button
                    size="sm"
                    variant={cvPlotMode === "corrected" ? "default" : "outline"}
                    onClick={() => setCvPlotMode((m) => m === "raw" ? "corrected" : "raw")}
                    disabled={cvPlotMode === "raw" && !correctedAvailable}
                    className="font-mono text-xs"
                    title={
                      correctedAvailable
                        ? "Toggle raw (measured) vs baseline-subtracted current"
                        : "Corrected view unavailable — fit a baseline first"
                    }
                  >
                    {cvPlotMode === "corrected" ? "Corrected" : "Raw"}
                  </Button>
                  <Button
                    size="sm"
                    variant={cvShowBaseline ? "default" : "outline"}
                    onClick={() => setCvShowBaseline((v) => !v)}
                    disabled={!baselineAvailable}
                    className="font-mono text-xs"
                    title={
                      baselineAvailable
                        ? "Overlay baseline (raw) or zero reference (corrected)"
                        : "Baseline not available"
                    }
                  >
                    Baseline {cvShowBaseline ? "ON" : "OFF"}
                  </Button>
                  <Hint text="Baseline subtraction method">
                    <select
                      value={cvBaselineMethod}
                      onChange={(e) =>
                        setCvBaselineMethod(
                          e.target.value as typeof cvBaselineMethod,
                        )
                      }
                      className="h-7 rounded-md border border-input bg-background px-2 font-mono text-[11px]"
                    >
                      <option value="auto">Baseline: Auto</option>
                      <option value="none">Baseline: None</option>
                      <option value="linear-first-15">Baseline: Linear first 15%</option>
                      <option value="linear-edges">Baseline: Linear edges</option>
                    </select>
                  </Hint>
                  <StatusIndicator
                    isRunning={isCVRunning && cvDataLive.length > 0}
                    label={isCVRunning ? "Sweeping..." : "Idle"}
                    dataPoints={cvDataLive.length}
                  />
                </div>
              </div>
              {dataSource === "live" && ws.cvError && (
                <div className="text-[11px] font-mono text-destructive border border-destructive/40 bg-destructive/10 rounded-md p-2">
                  CV hardware error: {ws.cvError}
                </div>
              )}
              {cvOverlays.length > 0 && (
                <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                  {cvOverlays.map((ov) => (
                    <span key={ov.id} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5">
                      <span style={{ background: ov.color, width: 8, height: 8, borderRadius: 999 }} />
                      {ov.label}
                      <Hint text="Remove overlay">
                        <button
                          type="button"
                          aria-label={`Remove overlay: ${ov.label}`}
                          className="ml-1 text-muted-foreground hover:text-foreground"
                          onClick={() => setCvOverlays((prev) => prev.filter((p) => p.id !== ov.id))}
                        >×</button>
                      </Hint>
                    </span>
                  ))}
                </div>
              )}
              <div className="rounded-lg border border-border bg-card p-3 h-[440px] md:h-[540px]">
                <CVPlot
                  data={cvDataLive}
                  metrics={cvMetrics}
                  e0Prime={cvParams.formalPotential ?? CV_E0_PRIME}
                  plotMode={cvPlotMode}
                  overlays={cvOverlayMode ? cvOverlays : []}
                  showBaseline={cvShowBaseline}
                />
              </div>
              {cvMetrics && (
                <>
                  <div className="text-[11px] font-mono text-muted-foreground border border-border bg-secondary/40 rounded-md p-2">
                    {cvParams.cvModel === "reversible" ? (
                      <>
                        <span className="text-foreground">Reversible diffusion model</span>
                        {" — "}solves 1D semi-infinite diffusion (finite-domain
                        approximation, L = 6·√(D·tMax)) with a Nernst surface
                        boundary. ΔEp, |Ipa/Ipc| and ip ∝ C·√v emerge from the
                        physics. Reversibility / D_status decisions use the
                        baseline-corrected peak currents — raw extrema can
                        deviate because they include baseline/tail contributions.
                      </>
                    ) : (
                      <>
                        <span className="text-foreground">Quasi-reversible model</span>
                        {" — "}Butler–Volmer + Cottrell convolution. Educational
                        approximation; D apparent from Randles–Ševčík may be biased
                        and n estimate is only valid for reversible systems at 25 °C.
                      </>
                    )}
                  </div>
                  {cvParams.cvModel === "quasi-reversible" && (
                    <div className="text-[11px] font-mono text-yellow-500 border border-yellow-500/40 bg-yellow-500/10 rounded-md p-2">
                      ⚠ Quasi-reversible model — D apparent from
                      Randles–Ševčík may be biased.
                    </div>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {[
                      { label: "Ipa raw", value: Number.isFinite(cvMetrics.IpaRaw) ? `${cvMetrics.IpaRaw.toFixed(2)} µA` : "—", t: "Anodic peak current — uncorrected" },
                      { label: "Ipc raw", value: Number.isFinite(cvMetrics.IpcRaw) ? `${cvMetrics.IpcRaw.toFixed(2)} µA` : "—", t: "Cathodic peak current — uncorrected" },
                      { label: "Ipa corr", value: Number.isFinite(cvMetrics.IpaCorrected) ? `${cvMetrics.IpaCorrected.toFixed(2)} µA` : "—", t: "Baseline-corrected anodic peak" },
                      { label: "Ipc corr", value: Number.isFinite(cvMetrics.IpcCorrected) ? `${cvMetrics.IpcCorrected.toFixed(2)} µA` : "—", t: "Baseline-corrected cathodic peak" },
                      { label: "Epa", value: Number.isFinite(cvMetrics.Epa) ? `${cvMetrics.Epa.toFixed(3)} V` : "—", t: "Anodic peak potential — where oxidation current peaks." },
                      { label: "Epc", value: Number.isFinite(cvMetrics.Epc) ? `${cvMetrics.Epc.toFixed(3)} V` : "—", t: "Cathodic peak potential — where reduction current peaks." },
                      { label: "ΔEp", value: Number.isFinite(cvMetrics.deltaEp) ? `${cvMetrics.deltaEp.toFixed(0)} mV` : "—", t: `Expected ≈ ${(59.16 / Math.max(1, cvParams.n)).toFixed(0)} mV for n=${cvParams.n} at 25 °C` },
                      { label: "E°'", value: Number.isFinite(cvMetrics.E0prime) ? `${cvMetrics.E0prime.toFixed(3)} V` : "—", t: "Formal potential, ≈ midpoint between Epa and Epc." },
                      { label: "|Ipa/Ipc|", value: Number.isFinite(cvMetrics.IpaIpcRatio) ? cvMetrics.IpaIpcRatio.toFixed(2) : "—", t: "Peak current ratio. Near 1.0 = reversible couple." },
                      { label: "n est.", value: cvMetrics.n_est_valid ? cvMetrics.n_electrons.toFixed(2) : "—", t: "Valid only for reversible diffusion-controlled systems at 25 °C." },
                      {
                        label: `D apparent (${cvMetrics.D_status})`,
                        value: Number.isFinite(cvMetrics.D_apparent)
                          ? `${cvMetrics.D_apparent.toExponential(2)} cm²/s`
                          : "—",
                        t: "Valid = reversible system. Apparent = quasi-reversible estimate. Invalid = not applicable here.",
                      },
                      { label: "SNR (min)", value: `${Math.min(cvMetrics.SNR_anodic, cvMetrics.SNR_cathodic).toFixed(1)}`, t: "Weakest peak's signal-to-noise ratio. Higher is more reliable." },
                      { label: "Noise", value: `${cvMetrics.noise_uA.toFixed(3)} µA`, t: "Estimated baseline noise level, robust to outliers." },
                      { label: "Reversibility", value: cvMetrics.reversibility, t: "Classified from ΔEp and |Ipa/Ipc| against reversible-system thresholds." },
                      {
                        label: "Baseline",
                        value:
                          cvMetrics.baselineMethodInput === "auto"
                            ? `Auto → ${cvMetrics.baselineResolvedMethod}`
                            : cvMetrics.baselineResolvedMethod,
                        t: `Input: ${cvMetrics.baselineMethodInput} · Method: ${cvMetrics.baselineMethod}`,
                      },
                      {
                        label: "Metrics cycle",
                        value: `${cvMetrics.metricsCycle}${
                          cvParams.nCycles > 1 ? ` / ${cvParams.nCycles}` : ""
                        }`,
                        t: "Main metrics are calculated from this cycle. Corrected view spans all cycles when available.",
                      },
                    ].map((it) => (
                      <div key={it.label} className="bg-secondary rounded-md p-2">
                        <div className="text-[10px] text-muted-foreground font-mono uppercase">
                          {it.label}
                          {it.t ? <InfoHint text={it.t} /> : null}
                        </div>
                        <div className="text-sm font-mono text-foreground">{it.value}</div>
                      </div>
                    ))}
                  </div>
                  {cvMetrics.warnings.length > 0 && (
                    <div className="text-[11px] font-mono text-muted-foreground border border-border rounded-md p-2 bg-secondary/40">
                      ⚠ {cvMetrics.warnings.join(" · ")}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="space-y-4">
              <SignalQuality
                mode="cv"
                eisData={[]}
                fetBaseline={[]}
                fetAnalyte={[]}
                cvMetrics={cvMetrics}
                cvNElectrons={cvParams.n}
                cvData={cvDataLive}
              />
              <MeasurementNotesPanel
                mode="cv"
                value={cvNotes}
                onChange={setCvNotes}
                onClear={() => {
                  setCvPreviousNotes(hasAnyNotes(cvNotes) ? cvNotes : cvPreviousNotes);
                  setCvNotes({});
                }}
                onCopyFromPrevious={
                  cvPreviousNotes
                    ? () => setCvNotes({ ...cvPreviousNotes })
                    : undefined
                }
                hasPrevious={!!cvPreviousNotes}
                measurementId={cvMeasurementId}
                measurementTimestamp={cvMeasurementTimestamp}
              />
              <CVCalibrationPanel
                points={cvCalibration}
                concentration_mM={cvParams.cMM}
                onChangeConcentration={(v) =>
                  setCvParams((prev) => ({ ...prev, cMM: v }))
                }
                responseMode={cvResponseMode}
                onChangeResponseMode={setCvResponseMode}
                onAddCurrent={handleAddCvCalibrationPoint}
                onClear={() => {
                  setCvCalibration([]);
                  toast("CV calibration cleared");
                }}
                onExport={() =>
                  exportCVCalibrationCSV(cvCalibration, {
                    source: exportSource,
                    responseMode: cvResponseMode,
                    n: cvParams.n,
                    areaCm2: cvParams.areaCm2,
                    scanRate_mVs: cvParams.scanRate,
                  })
                }
                canAdd={canAddCalibration}
                currentMeasuredUA={(() => {
                  if (!cvMetrics) return null;
                  const tmp = buildCVCalibrationPoint(
                    cvParams.cMM,
                    cvMetrics,
                    cvParams.cvModel,
                  );
                  return responseFor(tmp, cvResponseMode);
                })()}
                currentExpectedUA={randlesSevcikIpUA({
                  n: cvParams.n,
                  areaCm2: cvParams.areaCm2,
                  cMM: cvParams.cMM,
                  scanRate_mVs: cvParams.scanRate,
                })}
                cvModel={cvParams.cvModel}
                n={cvParams.n}
                areaCm2={cvParams.areaCm2}
                scanRate_mVs={cvParams.scanRate}
              />
            </div>
          </div>
        );
      })()}

      {(mode === "swv" || mode === "dashboard") && (
        <div className={mode === "dashboard" || isMulti ? "hidden" : undefined}>
        <SWVMode
          dataSource={exportSource}
          ws={ws}
          externalParams={swvParams}
          onChangeParams={setSwvParams}
          onController={setSwvCtrl}
          onSessionUpdate={setSessionMeasurements}
          overlays={swvOverlays}
          setOverlays={setSwvOverlays}
          demoRunning={demoRunning}
          state={swvState}
        />
        </div>
      )}

      {mode === "dashboard" && !isMulti && (() => {
        const cvDataLive = dataSource === "simulated" ? cv.data : ws.cvData;
        const isCVRunning = dataSource === "simulated" ? cv.isRunning : isLiveCVRunning;
        const cvStatus: DashStatus = isCVRunning ? "running" : cvDataLive.length > 0 ? "complete" : "idle";
        const swvStatus: DashStatus = swvCtrl?.isRunning ? "running" : swvCtrl?.hasData ? "complete" : "idle";
        return (
          <DashboardErrorBoundary>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

            <DashboardCell title="EIS — Nyquist" status={mapStatus(eisStatus)} onOpen={() => setMode("eis")}>
              <NyquistPlot data={eisData} overlays={[]} compact />
            </DashboardCell>
            <DashboardCell title="EIS — Bode" status={mapStatus(eisStatus)} onOpen={() => setMode("eis")}>
              <BodePlot data={eisData} overlays={[]} compact />
            </DashboardCell>
            <DashboardCell title="CV — I vs E" status={cvStatus} onOpen={() => setMode("cv")}>
              <CVPlot
                data={cvDataLive}
                metrics={null}
                e0Prime={cvParams.formalPotential ?? CV_E0_PRIME}
                overlays={[]}
                compact
              />
            </DashboardCell>
            <DashboardCell title="SWV — I vs E" status={swvStatus} onOpen={() => setMode("swv")}>
              <SWVPlot data={swvCtrl?.data ?? []} overlays={[]} compact />
            </DashboardCell>
            <DashboardCell title="BioFET — Id vs Vg" status={mapStatus(fetStatus)} onOpen={() => setMode("fet")}>
              <FETTransferPlot baseline={fetBaselineData} withAnalyte={fetAnalyteData} overlays={[]} compact analyteName={fetAnalyteName} />
            </DashboardCell>
            <DashboardCell title="BioFET — Id vs Time" status={mapStatus(fetStatus)} onOpen={() => setMode("fet")}>
              <FETTimePlot data={fetTimeDataArr} markers={fetMarkers} overlays={[]} compact analyteName={fetAnalyteName} />
            </DashboardCell>
          </div>
          </DashboardErrorBoundary>

        );
      })()}

      <footer className="mt-8 text-center text-[10px] text-muted-foreground font-mono">
        ElectroStat Biosensor v0.2 — {dataSource === "simulated" ? "Simulated Mode" : "Live Mode"} — ESP32-S3 WebSocket
      </footer>
    </div>
  );
};

export default Index;
