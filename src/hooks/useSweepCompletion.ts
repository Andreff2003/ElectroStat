import { useEffect, useRef } from "react";

/**
 * Decides when an EIS or BioFET sweep is over, so the app can freeze the data
 * it has received.
 *
 * Simulated source: the simulator has no "done" message, so a sweep ends after
 * a short pause with no new points (SIM_INACTIVITY_MS).
 *
 * Live sources (single and Multi-Channel): the firmware and bridge.py announce
 * the end of a sweep with eis_done / fet_done, and the hook exposes it as
 * deviceDone. A real EIS sweep can wait many seconds between low-frequency
 * points, so a 2 s pause means nothing there. The inactivity timer is kept only
 * as a safety net for a "done" message that never arrives (LIVE_FALLBACK_MS).
 */
export const SIM_INACTIVITY_MS = 2000;
export const LIVE_FALLBACK_MS = 180_000;

/**
 * done       the device reported the end of the sweep (nothing to stop)
 * inactivity simulated source, no new point for SIM_INACTIVITY_MS
 * fallback   live source, no new point for LIVE_FALLBACK_MS (device may still run)
 */
export type SweepCompletionReason = "done" | "inactivity" | "fallback";

interface Options {
  /** The sweep was started and has not been completed or stopped yet. */
  running: boolean;
  /** Data comes from a device (single live or Multi-Channel) and not from the simulator. */
  live: boolean;
  /** Enough data has arrived for the inactivity timer to be armed. */
  ready: boolean;
  /** Changes every time new data arrives (typically a point count). Resets the timer. */
  activity: number;
  /** The device reported that the sweep ended. Only used for live sources. */
  deviceDone: boolean;
  onComplete: (reason: SweepCompletionReason) => void;
}

export function useSweepCompletion({ running, live, ready, activity, deviceDone, onComplete }: Options) {
  // Always call the latest callback, so the timer sees the data of the moment it fires.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (running && live && deviceDone) onCompleteRef.current("done");
  }, [running, live, deviceDone]);

  useEffect(() => {
    if (!running || !ready) return;
    const timer = setTimeout(
      () => onCompleteRef.current(live ? "fallback" : "inactivity"),
      live ? LIVE_FALLBACK_MS : SIM_INACTIVITY_MS,
    );
    return () => clearTimeout(timer);
  }, [running, live, ready, activity]);
}
