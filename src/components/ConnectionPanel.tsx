import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConnectionStatus } from "@/hooks/useWebSocketData";

/**
 * Panel for switching between Simulated and Live data modes.
 * In Live mode, lets you enter the ESP32's WebSocket URL.
 */

export type DataSource = "simulated" | "live" | "multichannel";

interface ConnectionPanelProps {
  dataSource: DataSource;
  onChangeSource: (source: DataSource) => void;
  connectionStatus: ConnectionStatus;
  errorMessage: string;
  onConnect: (url: string) => void;
  onDisconnect: () => void;
  /** Multi-Channel: how many enabled channels are currently connected. */
  multiConnectedCount?: number;
  /** Multi-Channel: how many channels are enabled. */
  multiEnabledCount?: number;
}

export default function ConnectionPanel({
  dataSource,
  onChangeSource,
  connectionStatus,
  errorMessage,
  onConnect,
  onDisconnect,
  multiConnectedCount = 0,
  multiEnabledCount = 0,
}: ConnectionPanelProps) {
  // The browser talks to bridge.py, which listens on 127.0.0.1:81 and relays to the
  // ESP32 over USB serial or WiFi. The board itself serves no WebSocket.
  const [wsUrl, setWsUrl] = useState("ws://127.0.0.1:81");

  const statusColor: Record<ConnectionStatus, string> = {
    disconnected: "bg-muted-foreground",
    connecting: "bg-yellow-400 animate-pulse",
    connected: "bg-graph-primary",
    error: "bg-destructive",
  };

  const statusLabel: Record<ConnectionStatus, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting...",
    connected: "Connected",
    error: "Error",
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-mono text-muted-foreground uppercase">Data Source:</span>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={dataSource === "simulated" ? "default" : "outline"}
            onClick={() => onChangeSource("simulated")}
            className="font-mono text-xs h-7 px-3"
          >
            Simulated
          </Button>
          <Button
            size="sm"
            variant={dataSource === "live" ? "default" : "outline"}
            onClick={() => onChangeSource("live")}
            className="font-mono text-xs h-7 px-3"
          >
            Live
          </Button>
          <Button
            size="sm"
            variant={dataSource === "multichannel" ? "default" : "outline"}
            onClick={() => onChangeSource("multichannel")}
            className="font-mono text-xs h-7 px-3"
          >
            Multi-Channel Live
            {dataSource === "multichannel" && multiEnabledCount > 0 && (
              <span
                className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-mono ${
                  multiConnectedCount === multiEnabledCount
                    ? "bg-graph-primary/20 text-graph-primary"
                    : multiConnectedCount === 0
                      ? "bg-destructive/20 text-destructive"
                      : "bg-amber-500/20 text-amber-400"
                }`}
              >
                ● {multiConnectedCount}/{multiEnabledCount}
              </span>
            )}
          </Button>
        </div>
      </div>

      {dataSource === "live" && (
        <div className="space-y-2">
          <div className="flex gap-2 items-center">
            <Input
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
              placeholder="ws://127.0.0.1:81"
              className="font-mono text-xs h-8 bg-secondary"
              disabled={connectionStatus === "connected" || connectionStatus === "connecting"}
            />
            {connectionStatus === "connected" ? (
              <Button size="sm" variant="destructive" onClick={onDisconnect} className="font-mono text-xs h-8 px-3 shrink-0">
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => onConnect(wsUrl)}
                disabled={connectionStatus === "connecting" || !wsUrl}
                className="font-mono text-xs h-8 px-3 shrink-0"
              >
                Connect
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <div className={`w-2 h-2 rounded-full ${statusColor[connectionStatus]}`} />
            <span>{statusLabel[connectionStatus]}</span>
          </div>

          {errorMessage && (
            <p className="text-xs font-mono text-destructive">{errorMessage}</p>
          )}

          {connectionStatus === "disconnected" && (
            <p className="text-[10px] text-muted-foreground font-mono leading-relaxed">
              Enter the address of bridge.py, which prints it on startup (normally ws://127.0.0.1:81).
              The bridge relays to the ESP32-S3 over USB or WiFi, so keep it running on this computer.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
