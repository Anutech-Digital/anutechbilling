/* R-2898 — session health hook: threshold logic, rate limit, never-fail. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import * as sh from "../../scripts/ops/session-health.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { output as startOutput } from "../../scripts/ops/session-start-note.mjs";

const T = { ignoreBirth: true }; // file birth time is "now" in a test; use the transcript timestamps
const NOW = Date.parse("2026-11-17T12:00:00Z");

describe("session-health decide()", () => {
  it("below both thresholds → no reminder", () => {
    expect(sh.decide({ percent: 59, ageHours: 7.9, nowMs: NOW }).remind).toBe(false);
  });
  it("context at threshold → reminds", () => {
    expect(sh.decide({ percent: sh.REMIND_AT_PERCENT, ageHours: 1, nowMs: NOW })).toEqual({ remind: true, reason: "context" });
  });
  it("age at threshold → reminds", () => {
    expect(sh.decide({ percent: 5, ageHours: sh.REMIND_AT_HOURS, nowMs: NOW })).toEqual({ remind: true, reason: "age" });
  });
  it("rate limit: inside the window suppressed, after it allowed", () => {
    const inside = NOW - (sh.REMIND_EVERY_MIN - 1) * 60_000;
    const outside = NOW - sh.REMIND_EVERY_MIN * 60_000;
    expect(sh.decide({ percent: 90, ageHours: 1, nowMs: NOW, lastRemindedMs: inside }).remind).toBe(false);
    expect(sh.decide({ percent: 90, ageHours: 1, nowMs: NOW, lastRemindedMs: outside }).remind).toBe(true);
  });
  it("compact mode always reminds, even below thresholds / rate limited", () => {
    expect(sh.decide({ percent: 1, ageHours: 0, nowMs: NOW, lastRemindedMs: NOW, mode: "compact" }).remind).toBe(true);
  });
});

describe("session-health estimate", () => {
  it("real tokens beat file bytes", () => {
    expect(sh.estimatePercent({ tokens: 600_000, bytes: 1 })).toBe(60);
  });
  it("falls back to bytes / BYTES_PER_TOKEN", () => {
    const bytes = 0.8 * sh.CONTEXT_WINDOW_TOKENS * sh.BYTES_PER_TOKEN;
    expect(sh.estimatePercent({ tokens: null, bytes })).toBe(80);
  });
  it("reads newest usage from a transcript tail, ignoring a cut first line", () => {
    const tail = [
      'rt":"x"}',
      JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 100 } } }),
      JSON.stringify({ message: { usage: { input_tokens: 5, cache_read_input_tokens: 500, cache_creation_input_tokens: 1 } } }),
    ].join("\n");
    expect(sh.tokensFromTail(tail)).toBe(506);
  });
});

describe("session-health run() end to end", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sh-test-"));
  const mk = (name: string, tokens: number, startIso: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, [JSON.stringify({ timestamp: startIso, type: "user" }), JSON.stringify({ message: { usage: { input_tokens: tokens } } })].join("\n") + "\n");
    return f;
  };
  it("long session: reminds once, then is rate limited", () => {
    const f = mk("long.jsonl", 700_000, "2026-11-17T11:00:00Z");
    const stdin = JSON.stringify({ transcript_path: f, session_id: "test-" + Date.now() });
    const o = JSON.parse(sh.run(stdin, "prompt", NOW, T));
    expect(o.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(o.hookSpecificOutput.additionalContext).toContain("session-handoff");
    expect(o.hookSpecificOutput.additionalContext).toContain("70%");
    expect(sh.run(stdin, "prompt", NOW + 5 * 60_000, T)).toBe("");
    expect(sh.run(stdin, "prompt", NOW + 31 * 60_000, T)).not.toBe("");
  });
  it("old session (age) reminds; young small session is silent", () => {
    const old = mk("old.jsonl", 1000, "2026-11-17T01:00:00Z");
    expect(sh.run(JSON.stringify({ transcript_path: old, session_id: "o" + Date.now() }), "prompt", NOW, T)).toContain("11 hours");
    const young = mk("young.jsonl", 1000, "2026-11-17T11:30:00Z");
    expect(sh.run(JSON.stringify({ transcript_path: young, session_id: "y" + Date.now() }), "prompt", NOW, T)).toBe("");
  });
  it("compact mode: systemMessage, and the next prompt reminds at once", () => {
    const f = mk("c.jsonl", 700_000, "2026-11-17T11:00:00Z");
    const stdin = JSON.stringify({ transcript_path: f, session_id: "c" + Date.now() });
    sh.run(stdin, "prompt", NOW, T);
    expect(JSON.parse(sh.run(stdin, "compact", NOW + 60_000, T)).systemMessage).toContain("handoff");
    expect(sh.run(stdin, "prompt", NOW + 120_000, T)).not.toBe("");
  });
  it("never throws: bad JSON, missing file, empty stdin", () => {
    expect(sh.run("not json")).toBe("");
    expect(sh.run("")).toBe("");
    expect(sh.run(JSON.stringify({ transcript_path: path.join(dir, "nope.jsonl") }))).toBe("");
  });
});

describe("session-start-note", () => {
  it("names the board doc collection and the skill", () => {
    const o = JSON.parse(startOutput());
    expect(o.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(o.hookSpecificOutput.additionalContext).toContain("coordinator");
    expect(o.hookSpecificOutput.additionalContext).toContain("session-handoff");
  });
});
