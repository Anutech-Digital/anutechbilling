import { describe, it, expect } from "vitest";
import {
  buildQualityReport, fixHours, formatMinutes, isMoneyReport, median, minutesToFirstInvoice,
  mergeQualityInput, ragLowerBetter, type QualityFeedbackRow,
} from "./score";

const NOW = new Date("2026-10-06T12:00:00Z");

const fb = (over: Partial<QualityFeedbackRow>): QualityFeedbackRow => ({
  id: "f", title: "Something", problem_summary: null, status: "open",
  reported_type: "bug", inferred_type: null, reported_severity: "medium",
  created_at: "2026-10-01T00:00:00Z", resolved_at: null, checked_at: null,
  ...over,
});

describe("median", () => {
  it("odd, even, empty", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("ragLowerBetter — target colour", () => {
  it("green at or under target, amber up to the amber line, red beyond", () => {
    expect(ragLowerBetter(10, 10, 60)).toBe("green");
    expect(ragLowerBetter(11, 10, 60)).toBe("amber");
    expect(ragLowerBetter(60, 10, 60)).toBe("amber");
    expect(ragLowerBetter(61, 10, 60)).toBe("red");
  });
  it("no data is no colour — never a fake green", () => {
    expect(ragLowerBetter(null, 10, 60)).toBe("none");
  });
});

describe("minutesToFirstInvoice", () => {
  it("one number per workspace that has an invoice, from its signup to its EARLIEST invoice", () => {
    const tenants = [
      { id: "t1", created_at: "2026-10-01T10:00:00Z" },
      { id: "t2", created_at: "2026-10-01T10:00:00Z" },
      { id: "t3", created_at: "2026-10-01T10:00:00Z" }, // no invoice
    ];
    const invoices = [
      { tenant_id: "t1", created_at: "2026-10-01T10:30:00Z" },
      { tenant_id: "t1", created_at: "2026-10-01T10:08:00Z" },
      { tenant_id: "t2", created_at: "2026-10-01T12:00:00Z" },
      { tenant_id: "tX", created_at: "2026-10-01T12:00:00Z" }, // unknown tenant: ignored
    ];
    expect(minutesToFirstInvoice(tenants, invoices).sort((a, b) => a - b)).toEqual([8, 120]);
  });
  it("an invoice dated before signup (imported data) counts as 0, not negative", () => {
    expect(minutesToFirstInvoice([{ id: "t", created_at: "2026-10-02T00:00:00Z" }], [{ tenant_id: "t", created_at: "2026-09-01T00:00:00Z" }])).toEqual([0]);
  });
});

describe("fixHours", () => {
  it("only fixed BUG reports with a resolved time", () => {
    const rows = [
      fb({ status: "fixed", created_at: "2026-10-01T00:00:00Z", resolved_at: "2026-10-01T06:00:00Z" }),
      fb({ status: "fixed", created_at: "2026-10-01T00:00:00Z", resolved_at: null }),
      fb({ status: "open" }),
      fb({ status: "fixed", reported_type: "bug", inferred_type: "feature", created_at: "2026-10-01T00:00:00Z", resolved_at: "2026-10-05T00:00:00Z" }),
    ];
    expect(fixHours(rows)).toEqual([6]);
  });
});

describe("isMoneyReport", () => {
  it("money words in the title or summary", () => {
    expect(isMoneyReport(fb({ title: "GST total wrong on invoice" }))).toBe(true);
    expect(isMoneyReport(fb({ title: "Page slow", problem_summary: "₹ amount shows twice" }))).toBe(true);
    expect(isMoneyReport(fb({ title: "Button colour is off" }))).toBe(false);
  });
});

describe("formatMinutes", () => {
  it("minutes, hours, days", () => {
    expect(formatMinutes(8)).toBe("8 min");
    expect(formatMinutes(125)).toBe("2 h 5 min");
    expect(formatMinutes(60 * 24 * 3 + 5)).toBe("3 d");
  });
});

describe("buildQualityReport", () => {
  const byId = (r: ReturnType<typeof buildQualityReport>) => Object.fromEntries(r.map((m) => [m.id, m]));

  it("empty data: every measured row is 'none' with a dash, never green", () => {
    const r = byId(buildQualityReport({ tenants: [], invoices: [], feedback: [], checkedAvailable: true }, NOW));
    expect(r["first-invoice"].status).toBe("none");
    expect(r["first-invoice"].value).toBe("—");
    expect(r["bug-fix"].status).toBe("none");
    /* No open bugs IS a real answer — zero against a target of zero. */
    expect(r["open-bugs"].status).toBe("green");
    expect(r["money-bugs"].status).toBe("green");
  });

  it("colours each row against its target", () => {
    const r = byId(buildQualityReport({
      tenants: [{ id: "t1", created_at: "2026-10-01T10:00:00Z" }],
      invoices: [{ tenant_id: "t1", created_at: "2026-10-01T10:05:00Z" }],
      feedback: [
        fb({ status: "fixed", created_at: "2026-10-01T00:00:00Z", resolved_at: "2026-10-03T00:00:00Z", checked_at: "2026-10-05T00:00:00Z" }),
        fb({ status: "open", reported_severity: "high", title: "Invoice PDF GST split wrong" }),
        fb({ status: "agent_queued", reported_severity: "critical" }),
        fb({ status: "open", reported_type: "feature", reported_severity: "critical" }), // not a bug
      ],
      checkedAvailable: true,
    }, NOW));
    expect(r["first-invoice"]).toMatchObject({ value: "5 min", status: "green" });
    expect(r["bug-fix"]).toMatchObject({ value: "2 d", status: "amber" });
    expect(r["open-bugs"]).toMatchObject({ value: "2", status: "red" });
    expect(r["open-bugs"].detail).toContain("1 critical");
    expect(r["money-bugs"]).toMatchObject({ value: "1", status: "red" });
    expect(r["fixed-week"]).toMatchObject({ value: "1", status: "info" });
  });

  it("the weekly fixes row says so when checked_at is not there yet", () => {
    const r = byId(buildQualityReport({ tenants: [], invoices: [], feedback: [], checkedAvailable: false }, NOW));
    expect(r["fixed-week"]).toMatchObject({ value: "—", status: "none" });
  });

  it("lists the targets it cannot measure yet, honestly", () => {
    const r = buildQualityReport({ tenants: [], invoices: [], feedback: [], checkedAvailable: true }, NOW);
    const notYet = r.filter((m) => m.measured === false);
    expect(notYet.map((m) => m.id)).toEqual(["page-speed", "daily-clicks", "phone-375", "nps"]);
    for (const m of notYet) expect(m.status).toBe("none");
  });
});

describe("mergeQualityInput", () => {
  const f = { id: "a", title: "x", problem_summary: null, status: "fixed" as const, reported_type: "bug" as const,
    inferred_type: null, reported_severity: "low" as const, created_at: "2026-10-01T00:00:00Z", resolved_at: null };
  it("joins checked_at by id", () => {
    const r = mergeQualityInput([], [], [f], [{ id: "a", checked_at: "2026-10-05T00:00:00Z" }]);
    expect(r.feedback[0].checked_at).toBe("2026-10-05T00:00:00Z");
    expect(r.checkedAvailable).toBe(true);
  });
  it("no checked_at column (null) → checkedAvailable false, rows still there", () => {
    const r = mergeQualityInput([], [], [f], null);
    expect(r.feedback).toHaveLength(1);
    expect(r.checkedAvailable).toBe(false);
  });
});
