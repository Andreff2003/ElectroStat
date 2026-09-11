import { useState } from "react";
import { Beaker } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { InfoHint, Hint } from "@/components/InfoHint";
import { formatParamValue } from "@/utils/eisFit";
import { evaluateDummyCell, type DummyCellCheckResult, type DummyCellVerdict } from "@/utils/dummyCellCheck";

interface Props {
  /** Best available Randles fit (CNLS preferred, auto-fit fallback) for the current EIS sweep. */
  measured: { Rs: number; Rct: number; Cdl: number } | null;
}

const VERDICT_COLOR: Record<DummyCellVerdict, string> = {
  green: "text-graph-eis",
  yellow: "text-yellow-500",
  red: "text-destructive",
};
const VERDICT_LABEL: Record<DummyCellVerdict, string> = {
  green: "OK",
  yellow: "WARNING",
  red: "FAIL",
};

export function DummyCellCheck({ measured }: Props) {
  // Defaults match the built-in Simulated-mode model (Rs=200Ω, Rct≈300Ω at
  // 0 concentration, Cdl=20µF) so the check is meaningful out of the box;
  // swap these for your real dummy cell's known component values.
  const [rsExpected, setRsExpected] = useState(200);
  const [rctExpected, setRctExpected] = useState(300);
  const [cdlExpectedNF, setCdlExpectedNF] = useState(20000);
  const [result, setResult] = useState<DummyCellCheckResult | null>(null);

  const runCheck = () => {
    if (!measured) return;
    setResult(
      evaluateDummyCell(measured, {
        rsOhm: rsExpected,
        rctOhm: rctExpected,
        cdlF: cdlExpectedNF * 1e-9,
      }),
    );
  };

  const rows = result
    ? [
        { label: "Rs", unit: "Ω", ...result.rs },
        { label: "Rct", unit: "Ω", ...result.rct },
        { label: "Cdl", unit: "F", ...result.cdl },
      ]
    : [];

  return (
    <div className="rounded-lg border border-border bg-card p-2.5 space-y-2">
      <h3 className="text-xs font-mono text-muted-foreground flex items-center gap-1.5">
        <Beaker className="h-3.5 w-3.5" />
        Dummy Cell Check
        <InfoHint text="Run an EIS sweep on a resistor/capacitor test circuit instead of a real electrode, then compare the fitted Rs/Rct/Cdl against the circuit's known values — confirms the instrument and fit are trustworthy before trusting a real sample." />
      </h3>

      <div className="flex flex-wrap gap-2">
        <div className="flex items-center gap-1.5">
          <Label className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">Rs (Ω)</Label>
          <Input
            type="number"
            value={rsExpected}
            onChange={(e) => setRsExpected(Number(e.target.value))}
            className="h-7 w-20 font-mono text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">Rct (Ω)</Label>
          <Input
            type="number"
            value={rctExpected}
            onChange={(e) => setRctExpected(Number(e.target.value))}
            className="h-7 w-20 font-mono text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">Cdl (nF)</Label>
          <Input
            type="number"
            value={cdlExpectedNF}
            onChange={(e) => setCdlExpectedNF(Number(e.target.value))}
            className="h-7 w-20 font-mono text-xs"
          />
        </div>
      </div>

      <Button size="sm" onClick={runCheck} disabled={!measured} className="font-mono text-xs w-full h-7">
        {measured ? "Check Against Known Values" : "Fit an EIS sweep first"}
      </Button>

      {result && (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between bg-secondary rounded-md px-2 py-1">
              <span className="text-xs font-mono text-foreground">
                {r.label} {formatParamValue(r.label, r.measured, r.unit)}
                <span className="text-muted-foreground"> / {formatParamValue(r.label, r.expected, r.unit)}</span>
              </span>
              <Hint text="Deviation from the known value. Within ±10% green (OK), within ±25% yellow (warning), beyond that red (fail).">
                <span className={`text-xs font-mono cursor-help ${VERDICT_COLOR[r.verdict]}`}>
                  {Number.isFinite(r.errorPct) ? `${r.errorPct >= 0 ? "+" : ""}${r.errorPct.toFixed(1)}%` : "—"}
                </span>
              </Hint>
            </div>
          ))}
          <div className="text-xs font-mono">
            Verdict<InfoHint text="The worst verdict among Rs, Rct and Cdl above — one FAIL is enough to fail the whole check." />: <span className={`uppercase ${VERDICT_COLOR[result.overall]}`}>{VERDICT_LABEL[result.overall]}</span>
          </div>
        </div>
      )}
    </div>
  );
}
