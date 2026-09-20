import { format } from "date-fns";

export interface ActivityEntry {
  timestamp: number;
  category: "connection" | "measurement" | "calibration" | "sample" | "system";
  message: string;
}

type Listener = (entries: ActivityEntry[]) => void;

const KEY = "electrostat-activity-log-v1";
// Old (HelpStat) key, still read so the existing log survives the rename.
const LEGACY_KEY = "helpstat-activity-log-v1";

let entries: ActivityEntry[] = load();
const listeners = new Set<Listener>();

function load(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* ignore */
  }
}

export function logActivity(category: ActivityEntry["category"], message: string) {
  const entry: ActivityEntry = { timestamp: Date.now(), category, message };
  entries = [...entries, entry];
  persist();
  listeners.forEach((l) => l(entries));
}

export function getActivityLog(): ActivityEntry[] {
  return entries.slice();
}

export function clearActivityLog() {
  entries = [];
  persist();
  listeners.forEach((l) => l(entries));
}

export function subscribeActivityLog(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function formatTimestamp(ts: number): string {
  return format(new Date(ts), "yyyy-MM-dd HH:mm:ss");
}
