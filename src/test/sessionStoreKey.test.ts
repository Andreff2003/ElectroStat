import { describe, it, expect, beforeEach } from "vitest";
import { loadSession, saveSession, type StoredMeasurement } from "@/utils/sessionStore";

const item = [{ id: "x", mode: "eis" }] as unknown as StoredMeasurement[];

describe("session storage key (HelpStat -> ElectroStat rename)", () => {
  beforeEach(() => localStorage.clear());

  it("still loads a session saved under the old helpstat key", () => {
    localStorage.setItem("helpstat-session-v1", JSON.stringify(item));
    expect(loadSession()).toEqual(item);
  });

  it("saves under the electrostat key and prefers it over the old one", () => {
    localStorage.setItem("helpstat-session-v1", JSON.stringify([{ id: "old" }]));
    saveSession(item);
    expect(localStorage.getItem("electrostat-session-v1")).toBe(JSON.stringify(item));
    expect(loadSession()).toEqual(item);
  });
});
