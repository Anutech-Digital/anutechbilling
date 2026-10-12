import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { classify, newItems, newLine, shouldReportError, errorLine, parseState, serializeState, parseEnvFile, ERROR_EVERY_MS } from "../../scripts/ops/queue-watch-lib.mjs";

/* R-1412 (12 Oct 2026): queue-watch.mjs — the no-LLM fast lane that prints one line per new
   report in the agent feedback queue. All values here are fake. */

describe("classify", () => {
  it("urgent wins over everything", () => {
    expect(classify({ id: "a", urgent: true, reported_severity: "critical", title: "payment leak" })).toBe("urgent");
  });
  it("p0 from critical severity or a high triage score", () => {
    expect(classify({ id: "a", reported_severity: "critical" })).toBe("p0");
    expect(classify({ id: "a", reported_severity: "low", severity_score: 85 })).toBe("p0");
    expect(classify({ id: "a", reported_severity: "high", severity_score: 79 })).toBe("normal");
  });
  it("security from the type or a security word", () => {
    expect(classify({ id: "a", inferred_type: "security" })).toBe("security");
    expect(classify({ id: "a", title: "Other users' invoices exposed on the list" })).toBe("security");
    expect(classify({ id: "a", directive: "Password reset link never expires" })).toBe("security");
  });
  it("money from the type or a money word", () => {
    expect(classify({ id: "a", reported_type: "billing" })).toBe("money");
    expect(classify({ id: "a", problem_summary: "Customer was charged twice" })).toBe("money");
    expect(classify({ id: "a", title: "Total shows ₹0" })).toBe("money");
  });
  it("normal otherwise, and for junk input", () => {
    expect(classify({ id: "a", title: "Button text is cut off", reported_severity: "medium" })).toBe("normal");
    expect(classify(null)).toBe("normal");
  });
});

describe("seen state", () => {
  it("prints each id once per env", () => {
    let seen = new Set<string>();
    const a = newItems("staging", [{ id: "f1" }, { id: "f2" }], seen);
    expect(a.fresh.map((x: { id: string }) => x.id)).toEqual(["f1", "f2"]);
    seen = a.seen;
    const b = newItems("staging", [{ id: "f2" }, { id: "f3" }], seen);
    expect(b.fresh.map((x: { id: string }) => x.id)).toEqual(["f3"]);
    // same id on another env is a different report
    expect(newItems("local", [{ id: "f2" }], b.seen).fresh).toHaveLength(1);
  });
  it("skips items without an id and a non-array body", () => {
    expect(newItems("local", [{ title: "x" }], new Set()).fresh).toEqual([]);
    expect(newItems("local", undefined, new Set()).fresh).toEqual([]);
  });
  it("round-trips through the state file and survives a broken one", () => {
    const s = { seen: new Set(["local:f1", "staging:f2"]), lastErrorAt: { local: 123 } };
    const back = parseState(serializeState(s));
    expect([...back.seen]).toEqual(["local:f1", "staging:f2"]);
    expect(back.lastErrorAt).toEqual({ local: 123 });
    expect(parseState("{not json").seen.size).toBe(0);
  });
  it("NEW line format", () => {
    expect(newLine("staging", { id: "f9", urgent: true })).toBe("NEW staging f9 urgent");
  });
});

describe("error rate limit", () => {
  it("once per 30 min per env", () => {
    const t0 = 1_000_000;
    let r = shouldReportError("local", {}, t0);
    expect(r.print).toBe(true);
    r = shouldReportError("local", r.lastAt, t0 + 90_000);
    expect(r.print).toBe(false);
    // another env is counted on its own
    expect(shouldReportError("staging", r.lastAt, t0 + 90_000).print).toBe(true);
    expect(shouldReportError("local", r.lastAt, t0 + ERROR_EVERY_MS).print).toBe(true);
    expect(errorLine("local", "down")).toBe("QUEUE local HTTP down");
  });
});

describe("env file", () => {
  it("reads KEY=value, skips comments, strips quotes", () => {
    expect(parseEnvFile("# c\nAGENT_QUEUE_TOKEN=\"fake-value\"\n\nX=1\nbad\n")).toEqual({ AGENT_QUEUE_TOKEN: "fake-value", X: "1" });
  });
});
