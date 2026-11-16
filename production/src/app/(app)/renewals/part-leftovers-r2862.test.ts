/**
 * R-2862 (leftovers of R-2858, staging check 16 Nov 2026) — ONE "due date + amount due" per row
 * (due-anchor.ts rowDue), read by the tabs, the tiles, the sidebar badge and the drawer:
 *   1. sidebar badge = Overdue + ≤7 days tabs (less Won't renew) also for a row whose PART is late / due soon
 *      while its renewal date is 8+ days out;
 *   2. the drawer names the unpaid part ("Oct 2026 · ₹1,000 + GST") before "Next term";
 *   3. the Overdue tile adds the late part's value, not the whole term;
 *   4. the part's period is found from the open part proforma itself, also when a newer quote was sent after it.
 * The rows below are seeded the same way in supabase/tests/r2862_nav_badges_part_due.test.sql (badge = 6).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Subscription } from "@/lib/supabase/database.types";
import { inRenewalsBadge } from "@/lib/renewals/buckets";
import { buildQueueItems, type QueueItem } from "./queue-items";
import { rowDue } from "./due-anchor";
import { lastDocsBySubscription, type DocBilling, type DocInvoice, type DocQuote } from "./last-docs";
import { QUEUE_TABS, TILE_TABS, windowTab, type QueueTab } from "./queue";
import { monthOf, reconcileWindows, renewalTiles, tileText, type TileRow } from "./tiles";
import { unpaidPartWords } from "./drawer";

const TODAY = "2026-11-16";
const d = (n: number) => new Date(Date.UTC(2026, 10, 16 + n)).toISOString().slice(0, 10);

const sub = (id: string, renewal_date: string, extra: Partial<Subscription> = {}): Subscription => ({
  id, customer_id: `c-${id}`, customer_name: `Customer ${id}`, plan: "Business Starter", vendor: "google", seats: 5, used: 5,
  mrr: 1000, status: "active", renewal_date, term_months: 1, auto_renew: true, billing_cycle: "monthly",
  renewal_quote_id: null, outstanding_amount: 0, start_date: d(-200), quote_id: null, renewal_state: null,
  ...extra,
} as unknown as Subscription);

const quote = (id: string, extra: Partial<DocQuote> = {}): DocQuote => ({
  id, status: "sent", payment_status: "awaiting", created_at: `${d(-10)}T05:00:00Z`, created_date: d(-10), expires_date: null,
  invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null, subscription_billing_id: null, superseded_by: null,
  amount: 1180, currency: "INR", exchange_rate: 1, ...extra,
});
const billing = (id: string, subscription_id: string, start: string, end: string, due_on: string | null, extra: Partial<DocBilling> = {}): DocBilling => ({
  id, subscription_id, invoice_id: null, term_start: start, period_index: 1, due_on, period_start: start, period_end: end, taxable_amount: 1000, ...extra,
});

/* The same rows as supabase/tests/r2862_nav_badges_part_due.test.sql. */
const SUBS: Subscription[] = [
  sub("part-late", d(20)),                                   // part proforma due 9 days ago        → Overdue  (badge)
  sub("part-soon", d(20)),                                   // part proforma due in 3 days         → ≤7 days  (badge)
  sub("part-far", d(40)),                                    // part proforma due in 15 days        → 8–30
  sub("part-paid", d(20)),                                   // its part proforma is paid           → 8–30 (by renewal date)
  sub("part-draft", d(20)),                                  // a draft part quote — not sent       → 8–30
  sub("part-first", d(20), { start_date: d(-10) } as Partial<Subscription>),   // the first term's part = the sale, not a renewal → 8–30
  sub("inv-soon", d(20)),                                    // next term's part invoice due in 3d  → ≤7 days  (badge)
  sub("wont-late", d(20), { auto_renew: false } as Partial<Subscription>),     // Won't renew, late part → Overdue tab, NOT the badge
  sub("plain-soon", d(5), { term_months: 12, billing_cycle: "yearly" } as Partial<Subscription>),   // ≤7 days (badge)
  sub("plain-far", d(8), { term_months: 12, billing_cycle: "yearly" } as Partial<Subscription>),    // 8–30
  /* annual, paid quarterly: the term is ₹12,000, the late part ₹3,000; an add-seats quote was sent AFTER the part proforma */
  sub("annual-part", d(60), { term_months: 12, billing_cycle: "quarterly" } as Partial<Subscription>),   // Overdue (badge)
  sub("ravi", "2026-11-01", { start_date: "2026-08-01" } as Partial<Subscription>),                     // Oct part unpaid → Overdue (badge)
];
const BILLINGS: DocBilling[] = [
  billing("b-late", "part-late", d(-10), d(20), d(-9)),
  billing("b-soon", "part-soon", d(-10), d(20), d(3)),
  billing("b-far", "part-far", d(10), d(40), d(15)),
  billing("b-paid", "part-paid", d(-10), d(20), d(-9)),
  billing("b-draft", "part-draft", d(-10), d(20), d(-9)),
  billing("b-first", "part-first", d(-10), d(20), d(-9)),
  billing("b-inv", "inv-soon", d(25), d(55), d(3), { invoice_id: "INV-SOON" }),
  billing("b-wont", "wont-late", d(-10), d(20), d(-9)),
  billing("b-annual", "annual-part", d(-10), "2027-02-06", d(-9), { taxable_amount: 3000 }),
  billing("b-ravi", "ravi", "2026-10-01", "2026-11-01", "2026-10-01"),
];
const QUOTES: DocQuote[] = [
  quote("PI-LATE", { subscription_billing_id: "b-late" }),
  quote("PI-SOON", { subscription_billing_id: "b-soon" }),
  quote("PI-FAR", { subscription_billing_id: "b-far" }),
  quote("PI-PAID", { subscription_billing_id: "b-paid", payment_status: "received" }),
  quote("PI-DRAFT", { subscription_billing_id: "b-draft", status: "draft" }),
  quote("PI-FIRST", { subscription_billing_id: "b-first" }),
  quote("PI-WONT", { subscription_billing_id: "b-wont" }),
  quote("PI-ANNUAL", { subscription_billing_id: "b-annual", amount: 3540 }),
  quote("Q-SEATS", { add_seats_subscription_id: "annual-part", created_at: `${d(-2)}T05:00:00Z`, created_date: d(-2), amount: 590 }),
  quote("PI-RAVI", { subscription_billing_id: "b-ravi", created_at: "2026-10-01T05:00:00Z", created_date: "2026-10-01" }),
];
const INVOICES: DocInvoice[] = [
  { id: "INV-SOON", quote_id: null, invoice_date: d(-1), status: "pending", amount: 1180, paid_amount: 0, currency: "INR", created_at: `${d(-1)}T05:00:00Z`, due_date: d(3), net_payable: null },
];

const docs = lastDocsBySubscription({ subs: SUBS, quotes: QUOTES, billings: BILLINGS, invoices: INVOICES });
const build = buildQueueItems({
  subs: SUBS, docs, openRenewalMap: new Map(), quoteInfo: new Map(), quoteStatusMap: new Map(), docsLoading: false,
  fuData: undefined, contacts: undefined, role: "owner", graceDays: 0, today: new Date(`${TODAY}T12:00:00+05:30`), todayIst: TODAY,
});
const row = (id: string): QueueItem => build.allItems.find((i) => i.sub.id === id)!;
const tabOf = (id: string) => QUEUE_TABS.find((t) => build.items[t].some((i) => i.sub.id === id));
const ids = (t: QueueTab) => build.items[t].map((i) => i.sub.id).sort();

describe("R-2862 one 'due date + amount due' per row (rowDue)", () => {
  it("every row's due.days is the tab's own count (R-2858 dueDays) and due.date the Due column's date", () => {
    for (const t of QUEUE_TABS) for (const i of build.items[t]) {
      expect(i.due.days).toBe(i.dueDays);
      expect(windowTab(i.due.days)).toBe(t);
    }
    expect(row("part-late").due).toMatchObject({ date: d(-9), days: -9, source: "part", amount: 1000 });
    expect(row("plain-soon").due).toMatchObject({ date: d(5), days: 5, source: "term", amount: 12000, unpaidPart: null });
  });

  it("a part-billed row with one part unpaid owes that PART — the term amount stays the row's renewal amount", () => {
    const r = row("annual-part");
    expect(r.amount.value).toBe(12000);
    expect(r.due).toMatchObject({ source: "part", amount: 3000, days: -9 });
    expect(r.due.unpaidPart).toEqual({ period: "6 Nov 2026 – 5 Feb 2027", amount: 3000 });
  });

  it("(4) the part is found from the open part proforma itself, although an add-seats quote was sent after it", () => {
    const r = row("annual-part");
    expect(r.docs?.quote?.id).toBe("Q-SEATS");            // the newest quote sent is NOT the part proforma
    expect(r.docs?.sent).toMatchObject({ quoteId: "PI-ANNUAL", kind: "part", part: { start: d(-10), endExclusive: "2027-02-06", taxable: 3000 } });
    expect(r.period).toMatchObject({ source: "part", start: d(-10), end: "2027-02-05" });
    expect(r.stage?.label).toBe("Renewal quote sent · 6 Nov 2026 – 5 Feb 2027");
  });

  it("a part read without its value falls back to the term amount, never ₹0; no stage / a whole term → the term", () => {
    const stage = { key: "sent" as const, quoteId: "PI", invoiceId: null, anchorDate: "2026-10-01", anchorKind: "part" as const, days: -46, partDueDate: "2026-10-01" };
    const period = { ...row("ravi").period!, amount: null };
    expect(rowDue(stage, period, { renewal_date: "2026-11-01" }, -15, 12000)).toMatchObject({ source: "part", amount: 12000, unpaidPart: { period: "Oct 2026", amount: null } });
    expect(rowDue(null, period, { renewal_date: "2026-11-01" }, -15, 12000)).toEqual({ date: "2026-11-01", days: -15, source: "term", amount: 12000, unpaidPart: null });
    /* a draft part quote: the part is what is due, but nothing is with the customer → no "Unpaid part" */
    expect(rowDue({ ...stage, key: "draft" }, period, { renewal_date: "2026-11-01" }, -15, 12000).unpaidPart).toBeNull();
  });
});

describe("R-2862 (1) sidebar badge = Overdue + ≤7 days tabs, row for row", () => {
  it("the tabs: late / soon parts sit by their own due date", () => {
    expect(ids("overdue")).toEqual(["annual-part", "part-late", "ravi", "wont-late"]);
    expect(ids("due7")).toEqual(["inv-soon", "part-soon", "plain-soon"]);
    for (const id of ["part-far", "part-paid", "part-draft", "part-first", "plain-far"]) expect(tabOf(id)).toBe("d30");
  });

  it("inRenewalsBadge (the rule nav_badges() runs in SQL) picks exactly those rows, less Won't renew (R-2225)", () => {
    const badge = build.allItems.filter((i) => inRenewalsBadge(i.sub, i.daysUntil, false, i.due.days)).map((i) => i.sub.id).sort();
    expect(badge).toEqual([...ids("overdue"), ...ids("due7")].filter((id) => id !== "wont-late").sort());
    expect(badge).toHaveLength(6);   // = r2862_nav_badges_part_due.test.sql
    /* by the renewal date alone (before R-2862) only two of them were counted */
    expect(build.allItems.filter((i) => inRenewalsBadge(i.sub, i.daysUntil, false)).map((i) => i.sub.id).sort()).toEqual(["plain-soon", "ravi"]);
  });

  it("nav_badges() SQL carries the same rule: an open unpaid part proforma / part invoice due by today + 7", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const file = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
      .filter((f) => /function\s+public\.nav_badges\s*\(/i.test(readFileSync(join(dir, f), "utf8"))).pop()!;
    const sql = readFileSync(join(dir, file), "utf8");
    expect(sql).toContain("R-2862");
    expect(sql).toMatch(/coalesce\(b\.due_on, b\.period_start, b\.term_start\) <= v_today \+ 7/);
    expect(sql).toMatch(/pq\.status in \('sent', 'viewed', 'accepted'\)/);
    expect(sql).toMatch(/coalesce\(i\.due_date, b\.period_start\) <= v_today \+ 7/);
    /* Won't renew stays out, the paid-renewal rule stays on the renewal date */
    expect(sql).toMatch(/s\.auto_renew/);
    expect(sql).toMatch(/s\.renewal_date < v_today and s\.renewal_state <> 'suspended'/);
  });
});

describe("R-2862 (3) tiles add what is due on the Due date", () => {
  const month = monthOf(TODAY);
  const rows: TileRow[] = TILE_TABS.flatMap((t) => build.items[t].map((i) => ({
    id: i.sub.id, tab: t, statusKey: i.status.key, amount: i.amount.value, dueAmount: i.due.amount, renewalDate: i.sub.renewal_date,
  })));
  const tiles = renewalTiles(rows, [], month);

  it("Overdue = the late parts' own value (₹3,000 of the ₹12,000 annual term), Won't renew left to its tile", () => {
    expect(tiles.overdue).toEqual({ count: 3, amount: 1000 + 3000 + 1000 });   // part-late, annual-part, ravi
    /* before: the whole term for annual-part */
    expect(renewalTiles(rows.map((r) => ({ ...r, dueAmount: undefined })), [], month).overdue.amount).toBe(1000 + 12000 + 1000);
  });

  it("tile rows = tab rows − the closed rows, for every window (same fixture as the tabs and the badge)", () => {
    const w = reconcileWindows(rows, month);
    expect(w.overdue).toMatchObject({ tabRows: build.items.overdue.length, tileRows: tiles.overdue.count, wontRenew: 1 });
    expect(w.due30.tabRows).toBe(build.items.due7.length + build.items.d30.length);
    expect(w.due30.tileRows).toBe(tiles.due30.count);
    expect(tiles.due30.amount).toBe(1000 /* inv-soon */ + 1000 /* part-soon */ + 12000 /* plain-soon */ + 1000 * 4 /* far, paid, draft, first */ + 12000 /* plain-far */);
  });

  it("Won't renew and Renewed this month stay on the term amount", () => {
    expect(tiles.wontRenew).toEqual({ count: 1, amount: 1000 });
    const one: TileRow[] = [{ id: "x", tab: "overdue", statusKey: "overdue", amount: 12000, dueAmount: 3000, renewalDate: "2026-11-05" }];
    const t = renewalTiles(one, [], month);
    expect(t.overdue.amount).toBe(3000);
    expect(t.renewedMonth.stillDue.amount).toBe(12000);
  });

  it("the Overdue / Due tooltips say a part-billed renewal adds its unpaid part only", () => {
    expect(tileText("overdue", tiles, month, {}).title).toContain("A renewal billed in parts with one part unpaid adds that part only.");
    expect(tileText("wontRenew", tiles, month, {}).title).not.toContain("adds that part only");
  });
});

describe("R-2862 (2) the drawer names the unpaid part", () => {
  it("'Oct 2026 · ₹1,000 + GST' for Ravi; nothing for a row about its whole next term", () => {
    expect(unpaidPartWords(row("ravi").due, "+ GST")).toBe("Oct 2026 · ₹1,000 + GST");
    expect(unpaidPartWords(row("annual-part").due, "+ GST")).toBe("6 Nov 2026 – 5 Feb 2027 · ₹3,000 + GST");
    expect(unpaidPartWords(row("plain-soon").due, "+ GST")).toBeNull();
    expect(unpaidPartWords(row("part-paid").due, "+ GST")).toBeNull();
    expect(unpaidPartWords(null, "+ GST")).toBeNull();
  });

  it("an invoiced part is named too; a foreign-currency row or an unread value gets the period alone", () => {
    expect(row("inv-soon").due).toMatchObject({ source: "part", amount: 1000, days: 3 });
    expect(unpaidPartWords(row("inv-soon").due, "+ GST")).toBe(`${row("inv-soon").period!.words} · ₹1,000 + GST`);
    expect(unpaidPartWords(row("ravi").due, "no GST (LUT)")).toBe("Oct 2026");
    expect(unpaidPartWords({ unpaidPart: { period: "Oct 2026", amount: null } }, "+ GST")).toBe("Oct 2026");
  });
});
