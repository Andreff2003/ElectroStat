import NyquistPlot from "@/components/NyquistPlot";
import CVPlot from "@/components/CVPlot";
import SWVPlot from "@/components/SWVPlot";
import FETTransferPlot from "@/components/FETTransferPlot";
import FETTimePlot from "@/components/FETTimePlot";
import type { Channel } from "@/components/MultiChannelPanel";
import type { useWebSocketData } from "@/hooks/useWebSocketData";

/**
 * Renders the active technique's plot(s) for the enabled multi-channel devices.
 * Combined view reuses each plot's existing overlay support; separate view
 * stacks one plot per channel. No new math — data is passed straight through.
 */

type WS = ReturnType<typeof useWebSocketData>;

interface Props {
  mode: "eis" | "fet" | "cv" | "swv" | "dashboard";
  channels: Channel[];
  wsChannels: WS[];
  layout: "combined" | "separate";
}

export default function MultiChannelView({ mode, channels, wsChannels, layout }: Props) {
  const active = channels
    .map((c, i) => ({ c, ws: wsChannels[i] }))
    .filter(({ c }) => c.enabled);

  const technique = mode === "dashboard" ? "eis" : mode;

  if (active.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center text-xs font-mono text-muted-foreground">
        Enable at least one channel to see live plots.
      </div>
    );
  }

  const header = (
    <div className="flex items-center gap-3 flex-wrap mb-2">
      {active.map(({ c, ws }) => (
        <span key={c.id} className="flex items-center gap-1.5 text-xs font-mono">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: c.color }} />
          <span style={{ color: c.color }}>{c.label}</span>
          <span className="text-muted-foreground">
            ({ws.status === "connected" ? "connected" : ws.status})
          </span>
        </span>
      ))}
    </div>
  );

  const plotFor = (ws: WS, overlays: boolean, ov: Array<{ id: string; label: string; color: string; ws: WS }>) => {
    switch (technique) {
      case "eis":
        return (
          <NyquistPlot
            data={overlays ? [] : ws.eisData}
            overlays={overlays ? ov.map((o) => ({ label: o.label, color: o.color, data: o.ws.eisData })) : []}
          />
        );
      case "cv":
        return (
          <CVPlot
            data={overlays ? [] : ws.cvData}
            metrics={null}
            overlays={overlays ? ov.map((o) => ({ id: o.id, label: o.label, color: o.color, data: o.ws.cvData })) : []}
          />
        );
      case "swv":
        return (
          <SWVPlot
            data={overlays ? [] : ws.swvData}
            overlays={overlays ? ov.map((o) => ({ id: o.id, label: o.label, color: o.color, data: o.ws.swvData })) : []}
          />
        );
      case "fet":
        return (
          <div className="space-y-3">
            <FETTransferPlot
              baseline={overlays ? [] : ws.fetBaseline}
              withAnalyte={overlays ? [] : ws.fetAnalyte}
              overlays={
                overlays
                  ? ov.map((o) => ({
                      id: o.id,
                      label: o.label,
                      color: o.color,
                      baseline: o.ws.fetBaseline,
                      withAnalyte: o.ws.fetAnalyte,
                    }))
                  : []
              }
            />
            <FETTimePlot
              data={overlays ? [] : ws.fetTimeData}
              overlays={overlays ? ov.map((o) => ({ id: o.id, label: o.label, color: o.color, data: o.ws.fetTimeData })) : []}
            />
          </div>
        );
      default:
        return null;
    }
  };

  const overlayDefs = active.map(({ c, ws }) => ({
    id: `channel_${c.id}`,
    label: c.label,
    color: c.color,
    ws,
  }));

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      {header}
      {layout === "combined" ? (
        plotFor(active[0].ws, true, overlayDefs)
      ) : (
        <div>
          {active.map(({ c, ws }) => (
            <div key={c.id} className="border-t border-border pt-3 mt-3 first:border-t-0 first:pt-0 first:mt-0">
              <div className="text-sm font-mono mb-1" style={{ color: c.color }}>
                {c.label}
                {ws.status !== "connected" && (
                  <span className="text-muted-foreground text-xs"> — {ws.status}</span>
                )}
              </div>
              {plotFor(ws, false, [])}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
