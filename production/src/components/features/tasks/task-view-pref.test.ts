/* R-2937 — the remembered list view (compact / comfortable), per user. */
import { describe, it, expect } from "vitest";
import { DEFAULT_TASK_DENSITY, readTaskDensity, taskDensityKey, writeTaskDensity } from "./task-view-pref";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}
const blocked = {
  getItem: () => { throw new Error("SecurityError"); },
  setItem: () => { throw new Error("QuotaExceededError"); },
};
const ME = "u-me";

describe("task list density preference", () => {
  it("is compact (one line) until the person picks otherwise", () => {
    expect(DEFAULT_TASK_DENSITY).toBe("compact");
    expect(readTaskDensity(ME, memory())).toBe("compact");
    expect(readTaskDensity(ME, null)).toBe("compact");
  });
  it("remembers Comfortable, and going back to compact", () => {
    const s = memory();
    writeTaskDensity(ME, "comfortable", s);
    expect(s.data.get(taskDensityKey(ME)!)).toBe("comfortable");
    expect(readTaskDensity(ME, s)).toBe("comfortable");
    writeTaskDensity(ME, "compact", s);
    expect(readTaskDensity(ME, s)).toBe("compact");
  });
  it("is per user: one login's choice is not the next login's on the same browser", () => {
    const s = memory();
    writeTaskDensity(ME, "comfortable", s);
    expect(readTaskDensity("u-other", s)).toBe("compact");
  });
  it("before we know who is signed in nothing is read or written", () => {
    const s = memory();
    expect(taskDensityKey(null)).toBeNull();
    writeTaskDensity(undefined, "comfortable", s);
    expect(s.data.size).toBe(0);
    expect(readTaskDensity(null, s)).toBe("compact");
  });
  it("an unknown stored value reads as the default", () => {
    expect(readTaskDensity(ME, memory({ [taskDensityKey(ME)!]: "huge" }))).toBe("compact");
  });
  it("blocked storage never throws: read gives the default, write is skipped", () => {
    expect(readTaskDensity(ME, blocked)).toBe("compact");
    expect(() => writeTaskDensity(ME, "comfortable", blocked)).not.toThrow();
    expect(() => writeTaskDensity(ME, "comfortable", null)).not.toThrow();
  });
});
