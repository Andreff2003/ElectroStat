import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export type HomeMode = "eis" | "fet" | "cv" | "swv";
type DataSource = "simulated" | "live" | "multichannel";

const GREEN = "hsl(160 70% 55%)";
const AMBER = "hsl(30 90% 60%)";

// CV path traced from the simulator's own default curve (buildCVPointsForTest).
const CV_PATH =
  "M112.0 24.3 L108.9 24.3 L105.8 24.3 L102.6 24.3 L99.5 24.3 L96.4 24.3 L93.3 24.3 L90.2 24.3 L87.0 24.3 L83.9 24.4 L80.8 24.5 L77.7 24.8 L74.6 25.6 L71.4 27.4 L68.3 31.3 L65.2 37.8 L62.1 44.7 L59.0 47.9 L55.8 46.9 L52.7 44.3 L49.6 41.7 L46.5 39.7 L43.4 38.1 L40.2 37.0 L37.1 36.1 L34.0 35.3 L30.9 34.7 L27.8 34.2 L24.6 33.8 L21.5 33.4 L18.4 33.1 L15.3 32.8 L12.2 32.5 L9.0 32.2 L10.1 32.0 L13.2 31.8 L16.3 31.6 L19.4 31.4 L22.6 31.3 L25.7 31.1 L28.8 31.0 L31.9 30.8 L35.0 30.7 L38.2 30.6 L41.3 30.4 L44.4 30.2 L47.5 29.7 L50.6 28.9 L53.8 26.9 L56.9 23.0 L60.0 16.4 L63.1 9.4 L66.2 6.1 L69.4 7.0 L72.5 9.6 L75.6 12.1 L78.7 14.1 L81.8 15.5 L85.0 16.6 L88.1 17.5 L91.2 18.2 L94.3 18.7 L97.4 19.2 L100.6 19.5 L103.7 19.9 L106.8 20.2 L109.9 20.4 L112.0 20.6";

const Sketch = ({ label, children }: { label: string; children: ReactNode }) => (
  <svg
    width="100%"
    height="54"
    viewBox="0 0 120 54"
    role="img"
    aria-label={label}
    fill="none"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

const TECHNIQUES: { mode: HomeMode; title: string; subtitle: string; sketch: ReactNode }[] = [
  {
    mode: "eis",
    title: "EIS",
    subtitle: "Impedance",
    sketch: (
      <Sketch label="Nyquist semicircle with Warburg tail">
        <path d="M10 46 A38 38 0 0 1 86 46" stroke={GREEN} />
        <path d="M86 46 L108 24" stroke={AMBER} strokeDasharray="4 3" />
      </Sketch>
    ),
  },
  {
    mode: "fet",
    title: "BioFET",
    subtitle: "Transfer curve",
    sketch: (
      <Sketch label="Baseline and analyte transfer curves">
        <path d="M8 48 C40 48 50 46 64 30 C78 14 90 8 112 6" stroke={GREEN} />
        <path d="M8 48 C50 48 62 47 76 34 C90 20 100 14 112 12" stroke={AMBER} />
      </Sketch>
    ),
  },
  {
    mode: "cv",
    title: "CV",
    subtitle: "Cyclic voltammetry",
    sketch: (
      <Sketch label="Cyclic voltammogram">
        <path d={CV_PATH} stroke={GREEN} />
      </Sketch>
    ),
  },
  {
    mode: "swv",
    title: "SWV",
    subtitle: "Square wave",
    sketch: (
      <Sketch label="Square wave voltammetry peak">
        <path d="M8 44 L40 44 C52 44 56 10 66 10 C76 10 80 44 92 44 L112 44" stroke={GREEN} />
      </Sketch>
    ),
  },
];

const SOURCES: { id: DataSource; label: string }[] = [
  { id: "simulated", label: "Simulated" },
  { id: "live", label: "Live" },
  { id: "multichannel", label: "Multi-channel" },
];

const USER_GUIDE_URL = "https://github.com/Andreff2003/ElectroStat#readme";

interface HomeViewProps {
  dataSource: DataSource;
  onChangeSource: (source: DataSource) => void;
  onSelectMode: (mode: HomeMode) => void;
  onTryDemo: () => void;
}

/** Landing screen shown before the dashboard: pick a technique and a data source. */
export default function HomeView({ dataSource, onChangeSource, onSelectMode, onTryDemo }: HomeViewProps) {
  return (
    <div className="flex min-h-screen flex-col bg-background p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-mono text-xl font-semibold tracking-tight text-foreground">
          ElectroStat
          <span className="ml-2 text-sm font-normal text-primary">Biosensor Dashboard</span>
        </h1>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline" className="font-mono text-xs">
            <a href={USER_GUIDE_URL} target="_blank" rel="noopener noreferrer">
              User guide
            </a>
          </Button>
          {dataSource === "simulated" && (
            <Button size="sm" variant="outline" onClick={onTryDemo} className="font-mono text-xs">
              ▶ Try Demo Data
            </Button>
          )}
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center py-10">
        <div className="w-full max-w-2xl">
          <h2 className="mb-7 text-center text-xl font-medium text-foreground">Choose a measurement</h2>

          <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {TECHNIQUES.map((t) => (
              <button
                key={t.mode}
                type="button"
                onClick={() => onSelectMode(t.mode)}
                className="rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {t.sketch}
                <div className="mt-2.5 text-[15px] font-medium text-foreground">{t.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{t.subtitle}</div>
              </button>
            ))}
          </div>

          <div className="flex justify-center">
            <div
              role="group"
              aria-label="Data source"
              className="inline-flex gap-1 rounded-[10px] border border-border bg-card p-1"
            >
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={dataSource === s.id}
                  onClick={() => onChangeSource(s.id)}
                  className={`rounded-[7px] px-3.5 py-1.5 font-mono text-xs transition-colors ${
                    dataSource === s.id
                      ? "bg-primary font-medium text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
