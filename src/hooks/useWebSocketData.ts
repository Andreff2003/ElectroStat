import { useState, useEffect, useRef, useCallback } from "react";
import type { EISDataPoint, FETTransferPoint, FETTimePoint } from "./useSimulatedData";
import type { CVDataPoint } from "./useSimulatedCVData";
import { parseCVWebSocketMessage } from "./useSimulatedCVData";
import type { SWVDataPoint } from "@/types/swv";
import type { DeviceRunInfo } from "@/utils/instrumentSettings";

/**
 * ============================================================
 * WEBSOCKET LIVE DATA HOOK
 * ============================================================
 * Connects to your ESP32-S3 WebSocket server and receives
 * real-time sensor data for EIS and BioFET measurements.
 *
 * EXPECTED JSON MESSAGES FROM ESP32:
 *
 * For EIS data (zImag is true Im(Z) — NEGATIVE for capacitive behaviour):
 *   { "type": "eis", "zReal": 150.3, "zImag": -200.1, "frequency": 1000, "zMag": 250.2, "phase": -53.1 }
 *
 * For FET transfer curve:
 *   { "type": "fet_transfer", "vg": 0.5, "id": 12.3, "curve": "baseline" }
 *   { "type": "fet_transfer", "vg": 0.5, "id": 10.1, "curve": "analyte" }
 *
 * For FET time response:
 *   { "type": "fet_time", "time": 5.2, "id": 24.8 }
 *
 * Control commands (sent TO ESP32):
 *   { "command": "start_eis" }
 *   { "command": "start_fet" }
 *   { "command": "stop" }
 * ============================================================
 */

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * Sweep state as reported by the device (through the bridge). "stopped" is a
 * sweep that ended because the app asked it to stop: the points already
 * received are valid, and the device reports "idle" right after.
 */
export type SweepDeviceStatus = "idle" | "running" | "done" | "stopped" | "error";

const isSweepDeviceStatus = (s: unknown): s is SweepDeviceStatus =>
  s === "idle" || s === "running" || s === "done" || s === "stopped" || s === "error";

/**
 * "idle" after "done" or "stopped" must not erase the end of the sweep: the
 * firmware sends "stopped" and "idle" back to back, and the app may only get to
 * render once. The next "running", or clearEIS()/clearFET(), resets it.
 */
const nextSweepStatus = (prev: SweepDeviceStatus, incoming: SweepDeviceStatus): SweepDeviceStatus =>
  incoming === "idle" && (prev === "done" || prev === "stopped") ? prev : incoming;

/**
 * Sweeps and the messages of the sweep before.
 *
 * The device does not number its sweeps, so the app does: every start command it sends opens a
 * new sweep (a new sweep id, the live data of that technique cleared). The messages that arrive
 * before the device reports the new sweep as "running" were sent for the sweep before (its last
 * points, its "stopped" and "idle", the "idle" that bridge.py sends on a stop) and are ignored,
 * so they cannot mix into the new sweep or end it. The device always sends "running" before the
 * first point of a sweep. An error is never ignored (a start can fail), and if no "running"
 * arrives within START_ACK_TIMEOUT_MS of the technique the app stops waiting and takes what comes: a safety
 * net for a device that never answers, long enough for the sweep before to end first (an EIS finishes the
 * low-frequency point in progress, 20 to 40 s below 1 Hz, before it reports "stopped"; the others calibrate
 * before they report "running").
 */
export type SweepTechnique = "eis" | "fet" | "cv" | "swv";
export const START_ACK_TIMEOUT_MS: Record<SweepTechnique, number> = {
  eis: 180_000,
  cv: 30_000,
  swv: 30_000,
  fet: 30_000,
};

interface SweepGate {
  id: number;
  awaitingRunning: boolean;
  sentAt: number;
}
const newGates = (): Record<SweepTechnique, SweepGate> => ({
  eis: { id: 0, awaitingRunning: false, sentAt: 0 },
  fet: { id: 0, awaitingRunning: false, sentAt: 0 },
  cv: { id: 0, awaitingRunning: false, sentAt: 0 },
  swv: { id: 0, awaitingRunning: false, sentAt: 0 },
});

/** The technique a start command begins ("start_cv" is "cv"), or null for any other command. */
export function techniqueOfStartCommand(command: string): SweepTechnique | null {
  const m = /^start_(eis|fet|cv|swv)$/.exec(command);
  return m ? (m[1] as SweepTechnique) : null;
}

interface UseWebSocketDataReturn {
  // Connection
  status: ConnectionStatus;
  connect: (url: string) => void;
  disconnect: () => void;
  errorMessage: string;

  // EIS data
  eisData: EISDataPoint[];
  clearEIS: () => void;
  lastFilename: string;
  /**
   * Device-reported EIS sweep state, from {"type":"eis_status"} and
   * {"type":"eis_done"}. "done" means the sweep ended on the device side, so
   * the app can freeze the points received so far. Reset to "idle" by clearEIS().
   */
  eisStatus: SweepDeviceStatus;

  // FET data
  fetBaseline: FETTransferPoint[];
  fetAnalyte: FETTransferPoint[];
  fetTimeData: FETTimePoint[];
  clearFET: () => void;
  /** Same as eisStatus, from fet_status / fet_done. Reset to "idle" by clearFET(). */
  fetStatus: SweepDeviceStatus;

  // CV data
  cvData: CVDataPoint[];
  clearCV: () => void;
  cvStatus: "idle" | "running" | "done" | "error";
  cvError: string | null;

  // SWV data
  swvData: SWVDataPoint[];
  clearSWV: () => void;
  swvStatus: "idle" | "running" | "done" | "error";
  swvError: string | null;

  /**
   * What the device reported about the sweep in progress or the last one, per technique: the
   * fields of its "running" status (the calibration of a CV, SWV or BioFET sweep, the RCAL value,
   * the amplitude after the clamp of an EIS sweep) and of its done message (out-of-range count,
   * EIS points sent, skipped and flagged). Empty until it says so, and cleared at every start.
   */
  eisDeviceInfo: DeviceRunInfo;
  fetDeviceInfo: DeviceRunInfo;
  cvDeviceInfo: DeviceRunInfo;
  swvDeviceInfo: DeviceRunInfo;
  /**
   * The id of the sweep of each technique, new at every start command sent (0 before the
   * first). Data and status of the sweep before are never mixed into the current one.
   */
  eisSweepId: number;
  fetSweepId: number;
  cvSweepId: number;
  swvSweepId: number;

  // Send commands to ESP32
  sendCommand: (command: string, payload?: Record<string, unknown>) => void;
}

export function useWebSocketData(): UseWebSocketDataReturn {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [errorMessage, setErrorMessage] = useState("");

  const [eisData, setEisData] = useState<EISDataPoint[]>([]);
  const [lastFilename, setLastFilename] = useState("");
  const [eisStatus, setEisStatus] = useState<SweepDeviceStatus>("idle");
  const [fetStatus, setFetStatus] = useState<SweepDeviceStatus>("idle");
  const [fetBaseline, setFetBaseline] = useState<FETTransferPoint[]>([]);
  const [fetAnalyte, setFetAnalyte] = useState<FETTransferPoint[]>([]);
  const [fetTimeData, setFetTimeData] = useState<FETTimePoint[]>([]);
  const [cvData, setCvData] = useState<CVDataPoint[]>([]);
  const [cvStatus, setCvStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [cvError, setCvError] = useState<string | null>(null);
  const [swvData, setSwvData] = useState<SWVDataPoint[]>([]);
  const [swvStatus, setSwvStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [swvError, setSwvError] = useState<string | null>(null);
  const swvIndexRef = useRef(0);
  const [deviceInfo, setDeviceInfo] = useState<Record<SweepTechnique, DeviceRunInfo>>({ eis: {}, fet: {}, cv: {}, swv: {} });
  /** Keep the fields of a "running" status or of a done message of a technique (without type and status). */
  const keepDeviceInfo = (technique: SweepTechnique, part: "running" | "done", msg: Record<string, unknown>) => {
    const { type: _type, status: _status, ...fields } = msg;
    setDeviceInfo((prev) => ({ ...prev, [technique]: { ...prev[technique], [part]: fields } }));
  };
  const [sweepIds, setSweepIds] = useState<Record<SweepTechnique, number>>({ eis: 0, fet: 0, cv: 0, swv: 0 });
  const gatesRef = useRef<Record<SweepTechnique, SweepGate>>(newGates());

  /** True while a message for this technique can only belong to the sweep before the one just started. */
  const fromPreviousSweep = (technique: SweepTechnique): boolean => {
    const gate = gatesRef.current[technique];
    if (!gate.awaitingRunning) return false;
    if (Date.now() - gate.sentAt >= START_ACK_TIMEOUT_MS[technique]) {
      gate.awaitingRunning = false;
      return false;
    }
    return true;
  };
  /** The device has reported the new sweep (running) or failed to start it (error). */
  const sweepAnnounced = (technique: SweepTechnique) => {
    gatesRef.current[technique].awaitingRunning = false;
  };

  const socketRef = useRef<WebSocket | null>(null);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    setStatus("disconnected");
  }, []);

  const connect = useCallback((url: string) => {
    // Close any existing connection
    if (socketRef.current) {
      socketRef.current.close();
    }

    setStatus("connecting");
    setErrorMessage("");

    try {
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        setErrorMessage("");
      };

      ws.onclose = () => {
        setStatus("disconnected");
      };

      ws.onerror = () => {
        setStatus("error");
        setErrorMessage("Could not connect. Check the IP address and that the ESP32 is on.");
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            case "eis": {
              if (fromPreviousSweep("eis")) break;
              if (msg.filename) setLastFilename(msg.filename);
              const zReal = Number(msg.zReal);
              const zImag = Number(msg.zImag);
              const frequency = Number(msg.frequency);
              if (!Number.isFinite(zReal) || !Number.isFinite(zImag) || !Number.isFinite(frequency) || frequency <= 0) {
                console.warn("[ws] eis ignored — invalid frame", msg);
                break;
              }
              const zMagRaw = Number(msg.zMag);
              const zMag = Number.isFinite(zMagRaw) && zMagRaw > 0
                ? zMagRaw
                : Math.sqrt(zReal * zReal + zImag * zImag);
              const phaseRaw = Number(msg.phase);
              // zImag is true Im(Z) — phase = atan2(Im, Re); negative for capacitive.
              const phase = Number.isFinite(phaseRaw)
                ? phaseRaw
                : Math.atan2(zImag, zReal) * (180 / Math.PI);
              const point: EISDataPoint = { zReal, zImag, frequency, zMag, phase };
              // Raw-signal diagnostics from the firmware (absent in simulated and replayed data).
              const optNum = (v: unknown) => (v == null ? NaN : Number(v));
              const dftCal = optNum(msg.dftCal);
              const dftMag = optNum(msg.dftMag);
              const rtiaOhms = optNum(msg.rtiaOhms);
              if (Number.isFinite(dftCal)) point.dftCal = dftCal;
              if (Number.isFinite(dftMag)) point.dftMag = dftMag;
              if (Number.isFinite(rtiaOhms) && rtiaOhms > 0) point.rtiaOhms = rtiaOhms;
              if (typeof msg.lowSignal === "boolean") point.lowSignal = msg.lowSignal;
              setEisData((prev) => [...prev, point]);
              break;
            }

            case "fet_transfer": {
              if (fromPreviousSweep("fet")) break;
              const vg = Number(msg.vg);
              const id = Number(msg.id);
              const curve = msg.curve;
              if (!Number.isFinite(vg) || !Number.isFinite(id) ||
                  (curve !== "baseline" && curve !== "analyte")) {
                console.warn("[ws] fet_transfer ignored — invalid frame", msg);
                break;
              }
              const outOfRange = msg.outOfRange === true ? true : undefined;
              if (curve === "analyte") setFetAnalyte((prev) => [...prev, { vg, id, outOfRange }]);
              else setFetBaseline((prev) => [...prev, { vg, id, outOfRange }]);
              break;
            }

            case "fet_time": {
              if (fromPreviousSweep("fet")) break;
              const time = Number(msg.time);
              const id = Number(msg.id);
              if (!Number.isFinite(time) || time < 0 || !Number.isFinite(id)) {
                console.warn("[ws] fet_time ignored — invalid frame", msg);
                break;
              }
              const outOfRange = msg.outOfRange === true ? true : undefined;
              setFetTimeData((prev) => [...prev, { time, id, outOfRange }]);
              break;
            }

            // The firmware and bridge.py send both eis_done and eis_status
            // "done" at the end of a sweep. Either one marks the end, and the
            // second is a no-op because the state is already "done".
            case "eis_done":
              if (fromPreviousSweep("eis")) break;
              keepDeviceInfo("eis", "done", msg);
              setEisStatus("done");
              break;

            case "eis_status":
              if (isSweepDeviceStatus(msg.status)) {
                const s: SweepDeviceStatus = msg.status;
                if (s === "running" || s === "error") sweepAnnounced("eis");
                else if (fromPreviousSweep("eis")) break;
                if (s === "running") keepDeviceInfo("eis", "running", msg);
                setEisStatus((prev) => nextSweepStatus(prev, s));
              }
              break;

            case "fet_done":
              if (fromPreviousSweep("fet")) break;
              keepDeviceInfo("fet", "done", msg);
              setFetStatus("done");
              break;

            case "fet_status":
              if (isSweepDeviceStatus(msg.status)) {
                const s: SweepDeviceStatus = msg.status;
                if (s === "running" || s === "error") sweepAnnounced("fet");
                else if (fromPreviousSweep("fet")) break;
                if (s === "running") keepDeviceInfo("fet", "running", msg);
                setFetStatus((prev) => nextSweepStatus(prev, s));
              }
              break;

            case "cv_data": {
              if (fromPreviousSweep("cv")) break;
              const pt = parseCVWebSocketMessage(msg);
              if (!pt) {
                console.warn("[ws] cv_data ignored — invalid frame", msg);
                break;
              }
              setCvData((prev) => [...prev, pt]);
              break;
            }

            case "cv_status": {
              const s = msg.status;
              if (s === "idle" || s === "running" || s === "done" || s === "error") {
                if (s === "running" || s === "error") sweepAnnounced("cv");
                else if (fromPreviousSweep("cv")) break;
                if (s === "running") keepDeviceInfo("cv", "running", msg);
                setCvStatus(s);
                if (s !== "error") setCvError(null);
              }
              break;
            }

            case "cv_done":
              if (fromPreviousSweep("cv")) break;
              keepDeviceInfo("cv", "done", msg);
              setCvStatus("done");
              break;

            case "cv_error":
              sweepAnnounced("cv");
              setCvStatus("error");
              setCvError(typeof msg.message === "string" ? msg.message : "Unknown CV error");
              console.warn("[ws] cv_error", msg);
              break;

            case "swv_data": {
              if (fromPreviousSweep("swv")) break;
              // Accept alternate field names commonly seen on ESP32 firmwares.
              const E = Number(msg.E ?? msg.e ?? msg.potential ?? msg.potential_V);
              const iFwdRaw = msg.IForward ?? msg.ifwd ?? msg.i_forward;
              const iRevRaw = msg.IReverse ?? msg.irev ?? msg.i_reverse;
              const iNetRaw = msg.INet ?? msg.inet ?? msg.current ?? msg.current_uA;
              const iFwd = iFwdRaw != null ? Number(iFwdRaw) : NaN;
              const iRev = iRevRaw != null ? Number(iRevRaw) : NaN;
              let iNet = iNetRaw != null ? Number(iNetRaw) : NaN;
              if (!Number.isFinite(iNet) && Number.isFinite(iFwd) && Number.isFinite(iRev)) {
                iNet = iFwd - iRev;
              }
              if (!Number.isFinite(E) || !Number.isFinite(iNet)) {
                console.warn("[ws] swv_data ignored — invalid frame", msg);
                break;
              }
              const idx = Number.isFinite(Number(msg.index))
                ? Number(msg.index)
                : swvIndexRef.current;
              // Do NOT invent a time axis if the firmware omits it — leave
              // NaN so CSV export renders "N/A" instead of a fabricated stamp.
              const time = Number.isFinite(Number(msg.time ?? msg.t ?? msg.time_s))
                ? Number(msg.time ?? msg.t ?? msg.time_s)
                : NaN;
              const direction = msg.direction === "cathodic" ? "cathodic" : "anodic";
              const outOfRange = msg.outOfRange === true ? true : undefined;
              setSwvData((prev) => [...prev, {
                E,
                // Preserve NaN when F/R are absent — recharts skips NaN points
                // and CSV renders "N/A". Never fabricate 0 A, that would show
                // a false flat trace on the Forward/Reverse overlay.
                IForward: Number.isFinite(iFwd) ? iFwd : NaN,
                IReverse: Number.isFinite(iRev) ? iRev : NaN,
                INet: iNet,
                time,
                index: idx,
                direction,
                outOfRange,
              }]);
              swvIndexRef.current = idx + 1;
              break;
            }

            case "swv_status": {
              const s = msg.status;
              if (s === "idle" || s === "running" || s === "done" || s === "error") {
                if (s === "running" || s === "error") sweepAnnounced("swv");
                else if (fromPreviousSweep("swv")) break;
                if (s === "running") keepDeviceInfo("swv", "running", msg);
                setSwvStatus(s);
                if (s !== "error") setSwvError(null);
              }
              break;
            }

            case "swv_done":
              if (fromPreviousSweep("swv")) break;
              keepDeviceInfo("swv", "done", msg);
              setSwvStatus("done");
              break;

            case "swv_error":
              sweepAnnounced("swv");
              setSwvStatus("error");
              setSwvError(typeof msg.message === "string" ? msg.message : "Unknown SWV error");
              console.warn("[ws] swv_error", msg);
              break;

            default:
              // Unknown message type — ignore
              break;
          }
        } catch (err) {
          // Non-JSON or malformed frame — surface it so bridge bugs are
          // debuggable instead of silently dropping data.
          console.warn("[ws] ignored malformed message frame", err, event.data);
        }
      };
    } catch (err) {
      console.warn("[ws] failed to open WebSocket", err);
      setStatus("error");
      setErrorMessage("Invalid WebSocket URL.");
    }
  }, []);

  const clearDeviceInfo = useCallback((technique: SweepTechnique) => {
    setDeviceInfo((prev) => ({ ...prev, [technique]: {} }));
  }, []);
  const clearEIS = useCallback(() => {
    clearDeviceInfo("eis");
    setEisData([]);
    setLastFilename("");
    setEisStatus("idle");
  }, [clearDeviceInfo]);
  const clearFET = useCallback(() => {
    clearDeviceInfo("fet");
    setFetBaseline([]);
    setFetAnalyte([]);
    setFetTimeData([]);
    setFetStatus("idle");
  }, [clearDeviceInfo]);
  const clearCV = useCallback(() => {
    clearDeviceInfo("cv");
    setCvData([]);
    setCvStatus("idle");
    setCvError(null);
  }, [clearDeviceInfo]);
  const clearSWV = useCallback(() => {
    clearDeviceInfo("swv");
    setSwvData([]);
    setSwvStatus("idle");
    setSwvError(null);
    swvIndexRef.current = 0;
  }, [clearDeviceInfo]);

  const sendCommand = useCallback((command: string, payload?: Record<string, unknown>) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ command, ...(payload ?? {}) }));
    // A start opens a new sweep: a new id, the data of the technique cleared, and whatever the
    // device still says about the sweep before is ignored until it reports this one running.
    const technique = techniqueOfStartCommand(command);
    if (!technique) return;
    const gate = gatesRef.current[technique];
    gate.id += 1;
    gate.awaitingRunning = true;
    gate.sentAt = Date.now();
    setSweepIds((prev) => ({ ...prev, [technique]: gate.id }));
    if (technique === "eis") clearEIS();
    else if (technique === "fet") clearFET();
    else if (technique === "cv") clearCV();
    else clearSWV();
  }, [clearEIS, clearFET, clearCV, clearSWV]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  return {
    status,
    connect,
    disconnect,
    errorMessage,
    eisData,
    clearEIS,
    lastFilename,
    eisStatus,
    fetBaseline,
    fetAnalyte,
    fetTimeData,
    clearFET,
    fetStatus,
    cvData,
    clearCV,
    cvStatus,
    cvError,
    swvData,
    clearSWV,
    swvStatus,
    swvError,
    eisDeviceInfo: deviceInfo.eis,
    fetDeviceInfo: deviceInfo.fet,
    cvDeviceInfo: deviceInfo.cv,
    swvDeviceInfo: deviceInfo.swv,
    eisSweepId: sweepIds.eis,
    fetSweepId: sweepIds.fet,
    cvSweepId: sweepIds.cv,
    swvSweepId: sweepIds.swv,
    sendCommand,
  };
}

/**
 * Per-channel auto-reconnect with exponential backoff (1s → 30s), mirroring
 * bridge.py's WiFi retry loop. Purely a connection concern — no measurement
 * data or math is touched. Lives alongside useWebSocketData since it always
 * drives one of that hook's `connect`/`status` pairs.
 */
export function useChannelReconnect(
  active: boolean,
  url: string,
  status: ConnectionStatus,
  connect: (url: string) => void,
) {
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (status === "connected") {
      attemptRef.current = 0;
      return;
    }
    if (!active || !url) return;
    if (status === "connecting") return;
    const delay = Math.min(30000, 1000 * 2 ** attemptRef.current);
    timerRef.current = setTimeout(() => {
      attemptRef.current += 1;
      connect(url);
    }, delay);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [active, url, status, connect]);
}
