import { useState, useEffect, useRef, useCallback } from "react";
import type { EISDataPoint, FETTransferPoint, FETTimePoint } from "./useSimulatedData";
import type { CVDataPoint } from "./useSimulatedCVData";
import { parseCVWebSocketMessage } from "./useSimulatedCVData";
import type { SWVDataPoint } from "@/types/swv";

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
              setEisStatus("done");
              break;

            case "eis_status":
              if (isSweepDeviceStatus(msg.status)) {
                const s: SweepDeviceStatus = msg.status;
                setEisStatus((prev) => nextSweepStatus(prev, s));
              }
              break;

            case "fet_done":
              setFetStatus("done");
              break;

            case "fet_status":
              if (isSweepDeviceStatus(msg.status)) {
                const s: SweepDeviceStatus = msg.status;
                setFetStatus((prev) => nextSweepStatus(prev, s));
              }
              break;

            case "cv_data": {
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
                setCvStatus(s);
                if (s !== "error") setCvError(null);
              }
              break;
            }

            case "cv_done":
              setCvStatus("done");
              break;

            case "cv_error":
              setCvStatus("error");
              setCvError(typeof msg.message === "string" ? msg.message : "Unknown CV error");
              console.warn("[ws] cv_error", msg);
              break;

            case "swv_data": {
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
                setSwvStatus(s);
                if (s !== "error") setSwvError(null);
              }
              break;
            }

            case "swv_done":
              setSwvStatus("done");
              break;

            case "swv_error":
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

  const sendCommand = useCallback((command: string, payload?: Record<string, unknown>) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ command, ...(payload ?? {}) }));
    }
  }, []);

  const clearEIS = useCallback(() => {
    setEisData([]);
    setLastFilename("");
    setEisStatus("idle");
  }, []);
  const clearFET = useCallback(() => {
    setFetBaseline([]);
    setFetAnalyte([]);
    setFetTimeData([]);
    setFetStatus("idle");
  }, []);
  const clearCV = useCallback(() => {
    setCvData([]);
    setCvStatus("idle");
    setCvError(null);
  }, []);
  const clearSWV = useCallback(() => {
    setSwvData([]);
    setSwvStatus("idle");
    setSwvError(null);
    swvIndexRef.current = 0;
  }, []);

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
