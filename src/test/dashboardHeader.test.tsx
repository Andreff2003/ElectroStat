import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DashboardHeader from "@/components/helpstat/DashboardHeader";

const noop = () => {};

function baseProps() {
  return {
    sourceLabel: "Simulated Data",
    autosaveStatus: "idle" as const,
    exportSessionButtonRef: { current: null },
    onExportSession: noop,
    sessionMeasurementsCount: 0,
    onClearSession: noop,
    dataSource: "simulated" as const,
    wsStatus: "disconnected" as const,
    demoPhase: "idle" as const,
    demoRunning: false,
    demoStep: 0,
    onStartDemo: noop,
    onContinueDemo: noop,
    onCancelDemo: noop,
    onResetDemo: noop,
    onHome: noop,
  };
}

describe("DashboardHeader", () => {
  it("shows the session count and disables export/clear when there is nothing saved", () => {
    render(<DashboardHeader {...baseProps()} sessionMeasurementsCount={0} />);
    expect(screen.getByText("⬇ Export Session CSV (0)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export Session CSV/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear Session" })).toBeDisabled();
  });

  it("enables export and calls onExportSession when there are saved measurements", () => {
    const onExportSession = vi.fn();
    render(
      <DashboardHeader {...baseProps()} sessionMeasurementsCount={3} onExportSession={onExportSession} />,
    );
    const exportButton = screen.getByRole("button", { name: /Export Session CSV \(3\)/ });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    expect(onExportSession).toHaveBeenCalledTimes(1);
  });

  it("shows the autosave status text for each state", () => {
    const { rerender } = render(<DashboardHeader {...baseProps()} autosaveStatus="saving" />);
    expect(screen.getByText("Saving session…")).toBeInTheDocument();

    rerender(<DashboardHeader {...baseProps()} autosaveStatus="saved" />);
    expect(screen.getByText("Session saved locally")).toBeInTheDocument();

    rerender(<DashboardHeader {...baseProps()} autosaveStatus="error" />);
    expect(screen.getByText("⚠ Session not saved — storage full")).toBeInTheDocument();
  });

  it("starts the guided demo when 'Try Demo Data' is clicked", () => {
    const onStartDemo = vi.fn();
    render(<DashboardHeader {...baseProps()} onStartDemo={onStartDemo} />);
    fireEvent.click(screen.getByRole("button", { name: "▶ Try Demo Data" }));
    expect(onStartDemo).toHaveBeenCalledTimes(1);
  });

  it("shows Cancel Demo while running and calls onCancelDemo", () => {
    const onCancelDemo = vi.fn();
    render(
      <DashboardHeader
        {...baseProps()}
        demoRunning={true}
        demoPhase="eis"
        demoStep={1}
        onCancelDemo={onCancelDemo}
      />,
    );
    expect(screen.getByText(/Running EIS…/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "✕ Cancel Demo" }));
    expect(onCancelDemo).toHaveBeenCalledTimes(1);
  });

  it("offers to continue to the next demo phase once a phase finishes", () => {
    const onContinueDemo = vi.fn();
    render(
      <DashboardHeader
        {...baseProps()}
        demoRunning={false}
        demoPhase="cv"
        onContinueDemo={onContinueDemo}
      />,
    );
    const button = screen.getByRole("button", { name: "Continue to CV Mode →" });
    fireEvent.click(button);
    expect(onContinueDemo).toHaveBeenCalledTimes(1);
  });

  it("does not show demo controls when the data source is live", () => {
    render(<DashboardHeader {...baseProps()} dataSource="live" />);
    expect(screen.queryByRole("button", { name: "▶ Try Demo Data" })).not.toBeInTheDocument();
  });
});
