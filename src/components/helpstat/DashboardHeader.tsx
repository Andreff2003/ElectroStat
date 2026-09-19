import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { ConnectionStatus } from "@/hooks/useWebSocketData";
import { PHASE_LABEL, type DemoPhase } from "@/components/helpstat/demoPhases";

interface DashboardHeaderProps {
  sourceLabel: string;
  autosaveStatus: "idle" | "saving" | "saved" | "error";
  exportSessionButtonRef: RefObject<HTMLButtonElement | null>;
  onExportSession: () => void;
  sessionMeasurementsCount: number;
  onClearSession: () => void;
  dataSource: "simulated" | "live" | "multichannel";
  wsStatus: ConnectionStatus;
  demoPhase: DemoPhase;
  demoRunning: boolean;
  demoStep: number;
  onStartDemo: () => void;
  onContinueDemo: () => void;
  onCancelDemo: () => void;
  onResetDemo: () => void;
  onHome: () => void;
}

/**
 * App title bar: session export/clear, live connection dot and the guided
 * demo controls. Pure presentation — all state lives in IndexPage.
 */
export default function DashboardHeader({
  sourceLabel,
  autosaveStatus,
  exportSessionButtonRef,
  onExportSession,
  sessionMeasurementsCount,
  onClearSession,
  dataSource,
  wsStatus,
  demoPhase,
  demoRunning,
  demoStep,
  onStartDemo,
  onContinueDemo,
  onCancelDemo,
  onResetDemo,
  onHome,
}: DashboardHeaderProps) {
  return (
    <header className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold text-foreground tracking-tight font-mono">
          <button
            type="button"
            onClick={onHome}
            title="Back to home"
            className="text-left hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
          >
            ElectroStat
            <span className="text-primary ml-2 text-sm font-normal">Biosensor Dashboard</span>
          </button>
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          ESP32-S3 / AD5941 — {sourceLabel}
        </p>
        <p className="text-[10px] text-muted-foreground/80 font-mono mt-0.5" aria-live="polite">
          {autosaveStatus === "saving" && "Saving session…"}
          {autosaveStatus === "saved" && "Session saved locally"}
          {autosaveStatus === "error" && "⚠ Session not saved — storage full"}
          {autosaveStatus === "idle" && "Space: start/stop · E: export session"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={exportSessionButtonRef}
          size="sm"
          variant="outline"
          onClick={onExportSession}
          disabled={sessionMeasurementsCount === 0}
          className="font-mono text-xs"
        >
          ⬇ Export Session CSV ({sessionMeasurementsCount})
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={sessionMeasurementsCount === 0}
              className="font-mono text-xs"
            >
              Clear Session
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear all stored measurements?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure? This cannot be undone. All saved EIS/BioFET sweeps and the calibration history will be removed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onClearSession}>
                Yes, clear everything
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground ml-2">
          <div className={`w-2 h-2 rounded-full ${
            dataSource === "simulated"
              ? "bg-graph-alt"
              : wsStatus === "connected"
                ? "bg-graph-primary"
                : wsStatus === "error"
                  ? "bg-destructive"
                  : "bg-muted-foreground"
          }`} />
          <span>{dataSource === "simulated" ? "Simulated" : wsStatus === "connected" ? "Live" : "Offline"}</span>
        </div>
        {dataSource === "simulated" && (
          <>
            {demoPhase === "idle" && !demoRunning && (
              <Button
                size="sm"
                variant="outline"
                onClick={onStartDemo}
                className="font-mono text-xs"
              >
                ▶ Try Demo Data
              </Button>
            )}
            {demoRunning && (
              <>
                <Button size="sm" variant="outline" disabled className="font-mono text-xs">
                  ▶ Running {PHASE_LABEL[demoPhase === "idle" ? "eis" : demoPhase]}… ({demoStep}/3)
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancelDemo} className="font-mono text-xs">
                  ✕ Cancel Demo
                </Button>
              </>
            )}
            {!demoRunning && demoPhase !== "idle" && demoPhase !== "done" && (
              <Button
                size="sm"
                variant="outline"
                onClick={onContinueDemo}
                className="font-mono text-xs"
              >
                Continue to {PHASE_LABEL[demoPhase]} Mode →
              </Button>
            )}
            {!demoRunning && demoPhase === "done" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onResetDemo}
                className="font-mono text-xs"
              >
                ✓ Demo complete — reset
              </Button>
            )}
          </>
        )}
      </div>
    </header>
  );
}
