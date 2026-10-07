import { describe, it, expect } from "vitest";
import { complianceTodayItems, rankTodayItems, kindMeta, TODAY_KIND_META, type TodayItem } from "./inbox";

/* 18 Sep 2026, local midday — far from any month edge so the IST/UTC question does not
   decide the outcome. GSTR-1 (11th) and the TDS deposit (7th) for August are late;
   GSTR-3B (20th) is two days out; the quarterly TDS return (31 Oct) and GSTR-9 are not
   today's business. */
const TODAY = new Date(2026, 8, 18, 12, 0, 0);

/* July is filed. Without this the catalog (rightly) shows JULY's GSTR-3B as 29 days late —
   an unfiled previous period stays visible for 45 days, see pick() in obligations.ts. */
const JULY_FILED = () => new Map([
  ["gst_gstr1|2026-07", "2026-08-11"],
  ["gst_gstr3b|2026-07", "2026-08-20"],
  ["tds_payment|2026-07", "2026-08-07"],
]);

describe("complianceTodayItems — GST/TDS from the same catalog /compliance uses", () => {
  it("keeps an unfiled previous period on the list (late is late)", () => {
    const ids = complianceTodayItems(TODAY, new Map()).map((i) => i.id);
    expect(ids).toContain("gst_gstr3b|2026-07");
  });

  it("surfaces late and due-within-a-week filings, and nothing further out", () => {
    const items = complianceTodayItems(TODAY, JULY_FILED());
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    expect(Object.keys(byId).sort()).toEqual(["gst_gstr1|2026-08", "gst_gstr3b|2026-08", "tds_payment|2026-08"]);
    expect(byId["gst_gstr1|2026-08"].priority).toBe(88);   // late
    expect(byId["tds_payment|2026-08"].priority).toBe(88); // late
    expect(byId["gst_gstr3b|2026-08"].priority).toBe(78);  // 2 days
    expect(byId["gst_gstr1|2026-08"].title).toContain("7d LATE");
    expect(items.every((i) => i.kind === "compliance" && i.href === "/compliance")).toBe(true);
  });

  it("drops a filing the moment it is marked filed (the filed-log is load-bearing)", () => {
    const filed = JULY_FILED().set("gst_gstr1|2026-08", "2026-09-10");
    const ids = complianceTodayItems(TODAY, filed).map((i) => i.id);
    expect(ids).not.toContain("gst_gstr1|2026-08");
    // …and does not replace it with next month's, which is 23 days out.
    expect(ids.some((id) => id.startsWith("gst_gstr1|"))).toBe(false);
  });

  it("puts the due date at IST midnight, not UTC midnight", () => {
    const i = complianceTodayItems(TODAY, JULY_FILED()).find((x) => x.id === "gst_gstr3b|2026-08")!;
    expect(i.due_at).toBe("2026-09-19T18:30:00.000Z");
  });

  /* R-325: Today reads the business profile (R-262) like /compliance does. */
  it("a QRMP filer gets PMT-06, not the monthly GSTR-3B", () => {
    const ids = complianceTodayItems(TODAY, JULY_FILED(), undefined, { businessType: "proprietor", gstFiling: "qrmp" })
      .map((i) => i.id);
    expect(ids).not.toContain("gst_gstr3b|2026-08");
    expect(ids.some((id) => id.startsWith("gst_pmt06|"))).toBe(true);
    expect(ids.some((id) => id.startsWith("roc_"))).toBe(false);
  });

  it("an unknown profile gives exactly today's list", () => {
    const unknown = complianceTodayItems(TODAY, JULY_FILED(), undefined, { businessType: null, gstFiling: null });
    expect(unknown).toEqual(complianceTodayItems(TODAY, JULY_FILED()));
  });
});

describe("rankTodayItems — the same order as today_inbox()'s ORDER BY", () => {
  const row = (p: Partial<TodayItem>): TodayItem => ({
    kind: "task", id: "x", title: "t", due_at: null, priority: 50, href: "/tasks", ...p,
  });

  it("orders by priority desc, then due asc with nulls last, then kind, then id", () => {
    const ranked = rankTodayItems([
      row({ id: "low", priority: 30 }),
      row({ id: "no-date", priority: 70, due_at: null }),
      row({ id: "later", priority: 70, due_at: "2026-09-20T00:00:00Z" }),
      row({ id: "sooner", priority: 70, due_at: "2026-09-19T00:00:00Z" }),
      row({ id: "top", priority: 90 }),
      row({ id: "b", kind: "renewal", priority: 50 }),
      row({ id: "a", kind: "renewal", priority: 50 }),
      row({ id: "z", kind: "approval", priority: 50 }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["top", "sooner", "later", "no-date", "z", "a", "b", "low"]);
  });

  it("does not mutate its input", () => {
    const input = [row({ id: "1", priority: 1 }), row({ id: "2", priority: 2 })];
    rankTodayItems(input);
    expect(input.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("merging compliance into an already-ranked SQL list keeps the list ranked", () => {
    const sql = rankTodayItems([
      row({ kind: "provisioning", id: "p", priority: 90 }),
      row({ kind: "invoice_overdue", id: "i", priority: 72, due_at: "2026-09-01T00:00:00Z" }),
    ]);
    const merged = rankTodayItems([...sql, ...complianceTodayItems(TODAY, new Map())]);
    for (let k = 1; k < merged.length; k++) expect(merged[k].priority).toBeLessThanOrEqual(merged[k - 1].priority);
    expect(merged[0].id).toBe("p");            // paid-not-delivered still leads
    expect(merged[1].kind).toBe("compliance"); // a late statutory filing is next
  });
});

describe("kindMeta", () => {
  it("has a label for every kind the SQL function emits", () => {
    // Keep in step with the `'kind'` literals in migration 20260928160000.
    for (const k of ["task", "enquiry", "whatsapp", "support", "automation", "provisioning", "purchase_inbox",
      "approval", "join_request", "renewal", "invoice_overdue", "payment_failed"]) {
      expect(TODAY_KIND_META, k).toHaveProperty(k);
    }
  });

  it("renders an unknown kind rather than crashing", () => {
    expect(kindMeta("brand_new_queue")).toEqual({ label: "brand_new_queue", icon: "info" });
  });
});
