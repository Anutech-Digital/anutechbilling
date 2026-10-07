import { describe, it, expect } from "vitest";
import { buildDealHistory, filterDealHistory, formatIstDateTime, dealMoney, type DealHistorySources } from "./timeline";

const lead: NonNullable<DealHistorySources["lead"]> = {
  id: "L-1", company: "Acme", stage: "quote", created_at: "2026-09-01T04:00:00Z", created_by: "u1",
  stage_changed_at: "2026-09-10T06:00:00Z", lost_at: null, lost_reason: null, lost_note: null,
  trial_started_at: null, trial_converted_at: null, trial_expired_at: null, source: "website",
};
const names = (id: string | null | undefined) => (id === "u1" ? "Pardeep" : id === "u2" ? "Pawan" : null);

const full: DealHistorySources = {
  lead,
  activities: [
    { id: "a1", kind: "call", detail: "Baat hui", created_at: "2026-09-05T05:00:00Z", created_by: "u2" },
    { id: "a2", kind: "email_in", detail: "Reply from x", created_at: "2026-09-06T05:00:00Z" },
  ],
  emails: [{ id: "e1", subject: "Pricing?", from_email: "x@acme.in", created_at: "2026-09-06T05:00:00Z", sent: false }],
  tasks: [{ id: "t1", title: "Call back", status: "done", due_at: "2026-09-12T05:00:00Z", created_at: "2026-09-08T05:00:00Z", completed_at: "2026-09-12T06:00:00Z", owner_id: "u1" }],
  quotes: [{ id: "Q-1", status: "sent", amount: 50_000, created_at: "2026-09-09T05:00:00Z", owner_id: "u1" }],
  quoteSends: [{ id: "s1", quote_id: "Q-1", sent_at: "2026-09-10T06:00:00Z", recipient_email: "x@acme.in", status: "sent", sent_by: "u1" }],
  quoteViews: [
    { id: "v1", quote_id: "Q-1", viewed_at: "2026-09-11T05:00:00Z", is_bot: false },
    { id: "v2", quote_id: "Q-1", viewed_at: "2026-09-11T07:00:00Z", is_bot: false },
    { id: "v3", quote_id: "Q-1", viewed_at: "2026-09-10T06:01:00Z", is_bot: true },
  ],
  invoices: [{ id: "INV-1", amount: 59_000, status: "pending", created_at: "2026-09-13T05:00:00Z", quote_id: "Q-1" }],
  payments: [{ id: "p1", amount: 20_000, method: "upi", received_at: "2026-09-14T05:00:00Z", quote_id: "Q-1", recorded_by: "u1" }],
  subscriptions: [],
  whatsapp: [{ id: "w1", direction: "inbound", text_body: "ok", created_at: "2026-09-07T05:00:00Z" }],
  aiCalls: [],
  auditLog: [
    { id: 9, entity: "leads", entity_id: "L-1", action: "update", changes: { stage: { old: "contact", new: "quote" } }, created_at: "2026-09-10T06:00:00Z", user_id: "u1" },
    { id: 10, entity: "quotes", entity_id: "Q-1", action: "update", changes: { status: { old: "draft", new: "sent" } }, created_at: "2026-09-10T06:00:00Z", user_id: "u1" },
  ],
};

describe("buildDealHistory — ordering", () => {
  const h = buildDealHistory(full, names);

  it("is newest first across every source", () => {
    const ats = h.events.map((e) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    expect(h.events[0].id).toBe("payment:p1");
    expect(h.events[h.events.length - 1].id).toBe("lead:created:L-1");
  });

  it("breaks same-instant ties the same way every time", () => {
    const again = buildDealHistory({ ...full, auditLog: [...(full.auditLog ?? [])].reverse() }, names);
    expect(again.events.map((e) => e.id)).toEqual(h.events.map((e) => e.id));
  });

  it("names who did it, and never shows a bare id", () => {
    expect(h.events.find((e) => e.id === "activity:a1")!.who).toBe("Pawan");
    expect(h.events.find((e) => e.id === "email:e1")!.who).toBe("x@acme.in");
    expect(h.events.every((e) => e.who !== "u1" && e.who !== "u2")).toBe(true);
  });

  it("links quotes, invoices and payments to their records", () => {
    expect(h.events.find((e) => e.id === "quote:Q-1")!.href).toBe("/quotes/Q-1");
    expect(h.events.find((e) => e.id === "invoice:INV-1")!.href).toBe("/invoices/INV-1");
    expect(h.events.find((e) => e.id === "payment:p1")!.amount).toBe(20_000);
  });
});

describe("buildDealHistory — de-duplication", () => {
  const h = buildDealHistory(full, names);

  it("drops email_in activities when the mail rows are loaded, keeps them when not", () => {
    expect(h.events.some((e) => e.id === "activity:a2")).toBe(false);
    const noMail = buildDealHistory({ ...full, emails: undefined }, names);
    expect(noMail.events.some((e) => e.id === "activity:a2")).toBe(true);
  });

  it("collapses human quote views into one event and ignores bots", () => {
    const views = h.events.filter((e) => e.id.startsWith("quote-view:"));
    expect(views).toHaveLength(1);
    expect(views[0].at).toBe("2026-09-11T05:00:00.000Z");
    expect(views[0].detail).toContain("2 baar dekha");
  });

  it("prefers the send log over the audit log's draft→sent", () => {
    expect(h.events.some((e) => e.id === "audit:10")).toBe(false);
    expect(h.events.some((e) => e.id === "quote-send:s1")).toBe(true);
  });

  it("does not add a derived stage event when the audit log explains the current stage", () => {
    expect(h.events.some((e) => e.id === "lead:stage:L-1")).toBe(false);
    expect(h.events.find((e) => e.id === "audit:9")!.title).toBe("Stage: Contacted → Quote Sent");
  });

  it("adds one derived stage event when nothing explains how the deal got there", () => {
    const bare = buildDealHistory({ lead }, names);
    expect(bare.events.map((e) => e.id)).toEqual(["lead:stage:L-1", "lead:created:L-1"]);
  });

  it("does not add a derived stage event when a 'stage' activity already records the move", () => {
    const h2 = buildDealHistory({
      lead: { ...lead, stage: "won", stage_changed_at: "2026-09-26T14:47:00Z" },
      activities: [{ id: "s", kind: "stage", detail: "moved to Won automatically", created_at: "2026-09-26T14:47:02Z" }],
    });
    expect(h2.events.map((e) => e.id)).toEqual(["activity:s", "lead:created:L-1"]);
  });

  it("does not add a derived stage event for a lead created straight into its stage", () => {
    const h2 = buildDealHistory({ lead: { ...lead, stage_changed_at: "2026-09-01T04:00:30Z" } });
    expect(h2.events.map((e) => e.id)).toEqual(["lead:created:L-1"]);
  });

  it("dates an accepted quote with no record of the change at its last update, and says so", () => {
    const h2 = buildDealHistory({ quotes: [{ id: "Q-2", status: "accepted", amount: 1, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-03T00:00:00Z" }] });
    const e = h2.events.find((x) => x.id === "quote-status:Q-2")!;
    expect(e.at).toBe("2026-09-03T00:00:00.000Z");
    expect(e.detail).toContain("last update");
  });
});

describe("buildDealHistory — filters and missing sources", () => {
  const h = buildDealHistory(full, names);

  it("filters by chip and counts each chip", () => {
    for (const f of ["calls", "email", "money", "stage"] as const) {
      const rows = filterDealHistory(h.events, f);
      expect(rows.every((e) => e.group === f)).toBe(true);
      expect(rows.length).toBe(h.counts[f]);
    }
    expect(filterDealHistory(h.events, "all")).toHaveLength(h.counts.all);
    expect(h.counts.calls + h.counts.email + h.counts.money + h.counts.stage).toBe(h.counts.all);
  });

  it("works with every source missing", () => {
    const empty = buildDealHistory({});
    expect(empty.events).toEqual([]);
    expect(empty.undated).toBe(0);
    expect(empty.counts.all).toBe(0);
  });

  it("drops and counts rows with no usable date instead of guessing", () => {
    const h2 = buildDealHistory({ activities: [{ id: "x", kind: "note", created_at: null }, { id: "y", kind: "note", created_at: "garbage" }] });
    expect(h2.events).toHaveLength(0);
    expect(h2.undated).toBe(2);
  });

  it("places a bare calendar date at IST midnight", () => {
    const h2 = buildDealHistory({ subscriptions: [{ id: "s", plan: "Business", start_date: "2026-09-30" }] });
    expect(h2.events[0].at).toBe("2026-09-29T18:30:00.000Z");
  });
});

describe("formatIstDateTime", () => {
  it("shows IST, not UTC", () => {
    expect(formatIstDateTime("2026-09-30T20:00:00Z")).toBe("1 Oct 2026, 1:30 am");
    expect(formatIstDateTime("2026-09-30T06:35:00Z")).toBe("30 Sep 2026, 12:05 pm");
    expect(formatIstDateTime("2026-09-29T18:30:00Z")).toBe("30 Sep 2026, 12:00 am");
  });
  it("returns empty for garbage", () => {
    expect(formatIstDateTime("nope")).toBe("");
  });
});

describe("dealMoney", () => {
  it("adds invoiced and paid, ignoring void and refunded", () => {
    const m = dealMoney({
      invoices: [{ id: "i1", amount: 1000, status: "pending" }, { id: "i2", amount: 500, status: "void" }],
      payments: [{ id: "p1", amount: 400 }, { id: "p2", amount: 100, refunded_at: "2026-09-01T00:00:00Z" }],
    });
    expect(m).toMatchObject({ invoiced: 1000, paid: 400, outstanding: 600, invoiceCount: 1, paymentCount: 1 });
  });
  it("has no outstanding before an invoice exists", () => {
    expect(dealMoney({ payments: [{ id: "p", amount: 10 }] }).outstanding).toBeNull();
  });
});
