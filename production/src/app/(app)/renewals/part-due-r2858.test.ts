/**
 * R-2858 (Pardeep, 16 Nov 2026 — staging Chrome test): on a billed-in-parts row the Due date, the period
 * and the tab must be about the SAME part. The three staging shapes (names are the owner's examples):
 *   Ravi     Due 1 Oct (46d ago), but the period read 1 Nov – 30 Nov          → period = the Oct part
 *   Supreme  Due 3 Oct, quote covers 3 Oct – 2 Nov, period read 3 Nov – 2 Dec → period = the quote's part
 *   SAV      part due 11 Nov ("Overdue 5d") yet listed under ≤7 days          → Overdue tab
 */
import { describe, expect, it } from "vitest";
import type { Subscription } from "@/lib/supabase/database.types";
import { buildQueueItems } from "./queue-items";
import { classifyRenewals } from "./classify";
import { dueCellFacts, dueDaysOf, duePeriodFacts } from "./due-anchor";
import { QUEUE_TABS, windowTab } from "./queue";
import type { LastDocs, LastInvoice, LastQuote } from "./last-docs";

const TODAY = "2026-11-16";

const sub = (id: string, renewal_date: string, extra: Partial<Subscription> = {}): Subscription => ({
  id, customer_id: `c-${id}`, customer_name: `Customer ${id}`, plan: "Business Starter", vendor: "google", seats: 5, used: 5,
  mrr: 1000, status: "active", renewal_date, term_months: 1, auto_renew: true, billing_cycle: "monthly",
  renewal_quote_id: null, outstanding_amount: 0, start_date: "2026-08-01", quote_id: null, renewal_state: null,
  ...extra,
} as unknown as Subscription);

const partQuote = (id: string, start: string, endExclusive: string, period: string): LastQuote => ({
  id, date: start, status: "sent", payment_status: "awaiting", expires_date: null, invoice_id: null,
  part: { start, endExclusive }, period,
});

/** A part proforma with the customer, unpaid — what "Bill next part" leaves on the row (last-docs.ts `sent`). */
const sentPart = (id: string, start: string, endExclusive: string, period: string, dueDate: string): LastDocs => ({
  quote: partQuote(id, start, endExclusive, period), invoice: null, invoices: [],
  sent: { quoteId: id, kind: "part", expiresDate: null, status: "sent", dueDate },
});

const base = {
  openRenewalMap: new Map<string, string>(), quoteInfo: new Map(), quoteStatusMap: new Map<string, string>(),
  docsLoading: false, fuData: undefined, contacts: undefined, role: "owner", graceDays: 0,
  today: new Date(`${TODAY}T12:00:00+05:30`), todayIst: TODAY,
};

const ravi = sub("ravi", "2026-11-01");
const supreme = sub("supreme", "2026-11-03", { start_date: "2026-08-03" } as Partial<Subscription>);
const sav = sub("sav", "2026-11-16", { start_date: "2026-08-16" } as Partial<Subscription>);
const docs = new Map<string, LastDocs>([
  ["ravi", sentPart("PI-OCT", "2026-10-01", "2026-11-01", "Oct 2026", "2026-10-01")],
  ["supreme", sentPart("PI-SUP", "2026-10-03", "2026-11-03", "3 Oct 2026 – 2 Nov 2026", "2026-10-03")],
  ["sav", sentPart("PI-SAV", "2026-11-16", "2026-12-16", "16 Nov 2026 – 15 Dec 2026", "2026-11-11")],
]);
const build = (subs: Subscription[], d: Map<string, LastDocs> | undefined = docs, extra: Partial<typeof base> = {}) =>
  buildQueueItems({ ...base, ...extra, subs, docs: d });
const rowOf = (b: ReturnType<typeof build>, id: string) => b.allItems.find((i) => i.sub.id === id)!;
const tabOf = (b: ReturnType<typeof build>, id: string) => QUEUE_TABS.find((t) => b.items[t].some((i) => i.sub.id === id));

describe("R-2858 the three staging shapes — Due date, period and tab agree", () => {
  const b = build([ravi, supreme, sav]);

  it("Ravi: Due 1 Oct → the period is the Oct part, not the next term (1 Nov – 30 Nov)", () => {
    const r = rowOf(b, "ravi");
    expect(dueCellFacts(r.stage, r.sub, r.daysUntil)).toMatchObject({ date: "2026-10-01", days: -46 });
    expect(r.period).toMatchObject({ source: "part", start: "2026-10-01", end: "2026-10-31", words: "Oct 2026", short: "1 Oct 26 – 31 Oct 26" });
    expect(r.period?.running).toBe("Oct unpaid · Nov running");
    expect(tabOf(b, "ravi")).toBe("overdue");
  });

  it("Supreme: Due 3 Oct, quote for 3 Oct – 2 Nov → the row's period is the quote's own", () => {
    const r = rowOf(b, "supreme");
    expect(dueCellFacts(r.stage, r.sub, r.daysUntil).date).toBe("2026-10-03");
    expect(r.period).toMatchObject({ source: "part", words: "3 Oct 2026 – 2 Nov 2026", short: "3 Oct 26 – 2 Nov 26" });
    expect(r.period?.words).toBe(r.docs?.quote?.period);
    expect(r.period?.running).toBe("3 Oct – 2 Nov unpaid · 3 Nov – 2 Dec running");
    expect(tabOf(b, "supreme")).toBe("overdue");
  });

  it("SAV: part due 11 Nov (5d ago), renews today → Overdue tab, never ≤7 days", () => {
    const r = rowOf(b, "sav");
    expect(r.daysUntil).toBe(0);
    expect(r.stage?.note).toBe("Overdue 5d · part due 11 Nov 2026");
    expect(r.dueDays).toBe(-5);
    expect(tabOf(b, "sav")).toBe("overdue");
    expect(b.items.due7.map((i) => i.sub.id)).not.toContain("sav");
    /* its part is the one that starts today — nothing later is running */
    expect(r.period).toMatchObject({ source: "part", short: "16 Nov 26 – 15 Dec 26", running: null });
  });

  it("every row sits in the tab of its own Due day count, and the tab counts are the lists", () => {
    const all = build([ravi, supreme, sav, sub("plain", "2026-11-20"), sub("far", "2027-06-01", { term_months: 12, billing_cycle: "yearly" } as Partial<Subscription>)]);
    for (const t of QUEUE_TABS) {
      expect(all.tabs[t].map((r) => r.sub.id)).toEqual(all.items[t].map((i) => i.sub.id));
      for (const i of all.items[t]) {
        expect(windowTab(i.dueDays)).toBe(t);
        expect(dueCellFacts(i.stage, i.sub, i.daysUntil).days).toBe(i.dueDays);
      }
    }
    expect(all.allItems).toHaveLength(5);
  });
});

describe("R-2858 tab = the Due column's date, in every direction", () => {
  it("renews in 20 days but its part fell due 9 days ago → Overdue (was 8–30)", () => {
    const s = sub("early", "2026-12-06", { start_date: "2026-08-06" } as Partial<Subscription>);
    const b = build([s], new Map([["early", sentPart("PI-E", "2026-11-06", "2026-12-06", "6 Nov 2026 – 5 Dec 2026", "2026-11-07")]]));
    expect(rowOf(b, "early").dueDays).toBe(-9);
    expect(tabOf(b, "early")).toBe("overdue");
    expect(b.groups.atRisk.map((r) => r.sub.id)).toContain("early");
  });

  it("renews in 20 days, its part is due in 3 → ≤7 days (the Due column says 'in 3d')", () => {
    const s = sub("soon", "2026-12-06", { start_date: "2026-08-06" } as Partial<Subscription>);
    const b = build([s], new Map([["soon", sentPart("PI-S", "2026-12-06", "2027-01-06", "6 Dec 2026 – 5 Jan 2027", "2026-11-19")]]));
    expect(rowOf(b, "soon").dueDays).toBe(3);
    expect(tabOf(b, "soon")).toBe("due7");
  });

  it("a Won't renew row still running, with an overdue part → Overdue tab (never dropped from the page)", () => {
    const s = sub("wont", "2026-12-06", { start_date: "2026-08-06", auto_renew: false } as Partial<Subscription>);
    const b = build([s], new Map([["wont", sentPart("PI-W", "2026-11-06", "2026-12-06", "6 Nov 2026 – 5 Dec 2026", "2026-11-06")]]));
    expect(b.groups.nonRenewing.map((r) => r.sub.id)).toEqual(["wont"]);
    expect(rowOf(b, "wont").dueDays).toBe(-10);
    expect(tabOf(b, "wont")).toBe("overdue");
  });

  it("documents still loading → the renewal date decides (no guessed part date)", () => {
    const b = build([sav], docs, { docsLoading: true });
    expect(rowOf(b, "sav").stage).toBeNull();
    expect(rowOf(b, "sav").dueDays).toBe(0);
    expect(tabOf(b, "sav")).toBe("due7");
  });

  it("a row with no part document keeps its renewal-date tab and the next term's period", () => {
    const b = build([sub("plain", "2026-11-20", { start_date: "2026-08-20" } as Partial<Subscription>)], new Map());
    const r = rowOf(b, "plain");
    expect(tabOf(b, "plain")).toBe("due7");
    expect(r.period).toMatchObject({ source: "term", start: "2026-11-20", end: "2026-12-19", short: "20 Nov 26 – 19 Dec 26", running: null });
  });
});

describe("R-2858 classifyRenewals — dueDays (the Due column's count) picks the group", () => {
  const row = (id: string, daysUntil: number, dueDays?: number, extra: Record<string, unknown> = {}) =>
    ({ sub: { renewal_date: "2026-11-16", status: "active", auto_renew: true, mrr: 100, ...extra }, daysUntil, dueDays, id });
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it("part due before the renewal date and late → expired (Overdue) and At risk", () => {
    const g = classifyRenewals([row("sav", 0, -5), row("ok", 0)], () => false);
    expect(ids(g.expired)).toEqual(["sav"]);
    expect(ids(g.due7)).toEqual(["ok"]);
    expect(ids(g.atRisk)).toEqual(["sav"]);
    expect(g.atRiskArr).toBe(1200);
  });

  it("part due sooner than the renewal → the sooner window", () => {
    const g = classifyRenewals([row("soon", 20, 3)], () => false);
    expect(ids(g.due7)).toEqual(["soon"]);
    expect(g.upcoming).toHaveLength(0);
  });

  it("no dueDays → the renewal date, as before", () => {
    const g = classifyRenewals([row("a", -2), row("b", 5), row("c", 20)], () => false);
    expect([ids(g.expired), ids(g.due7), ids(g.upcoming)]).toEqual([["a"], ["b"], ["c"]]);
  });

  it("Won't renew and paid-renewal rules stay on the renewal date", () => {
    const g = classifyRenewals(
      [row("wont", 5, -3, { auto_renew: false }), row("paid", -2, -9)],
      () => false, new Date(`${TODAY}T12:00:00+05:30`), (r) => r.id === "paid",
    );
    expect(ids(g.nonRenewing)).toEqual(["wont"]);
    expect(ids(g.renewedPaid)).toEqual(["paid"]);
    expect(g.expired).toHaveLength(0);
  });
});

describe("R-2858 duePeriodFacts / dueDaysOf", () => {
  const inv = (o: Partial<LastInvoice> & { id: string }): LastInvoice => ({
    date: "2026-10-01", status: "sent", amount: 1180, paidAmount: 0, currency: "INR", dueDate: "2026-10-01",
    netPayable: 1180, adjustedAdvances: null, writtenOffAt: null, fxRate: null, sourceQuoteId: null,
    part: null, period: null, notes: null, ...o,
  });
  const monthly = { renewal_date: "2026-11-01", term_months: 1, start_date: "2026-08-01" };

  it("an invoiced part → that invoice's period", () => {
    const i = inv({ id: "INV-OCT", part: { start: "2026-10-01", endExclusive: "2026-11-01" }, period: "Oct 2026" });
    const p = duePeriodFacts({ key: "invoiced", quoteId: null, invoiceId: "INV-OCT" }, { quote: null, invoice: i, invoices: [i], sent: null }, monthly, TODAY);
    expect(p).toMatchObject({ source: "part", words: "Oct 2026", running: "Oct unpaid · Nov running" });
  });

  it("a draft part quote is not 'unpaid' — no running words", () => {
    const d = sentPart("PI-D", "2026-10-01", "2026-11-01", "Oct 2026", "2026-10-01");
    expect(duePeriodFacts({ key: "draft", quoteId: "PI-D", invoiceId: null }, d, monthly, TODAY)?.running).toBeNull();
  });

  it("a part from another year names the year", () => {
    const d = sentPart("PI-Y", "2025-12-01", "2026-01-01", "Dec 2025", "2025-12-01");
    expect(duePeriodFacts({ key: "sent", quoteId: "PI-Y", invoiceId: null }, d, monthly, TODAY)?.running).toBe("Dec 2025 unpaid · Nov running");
  });

  it("a part with no whole-month length → plain words, no invented month", () => {
    const d = sentPart("PI-X", "2026-10-01", "2026-10-20", "1 Oct 2026 – 19 Oct 2026", "2026-10-01");
    expect(duePeriodFacts({ key: "sent", quoteId: "PI-X", invoiceId: null }, d, monthly, TODAY)?.running).toBe("1 Oct – 19 Oct unpaid · a later part is running");
  });

  it("a whole renewal quote, a broken part or no stage → the next term from the renewal date", () => {
    const whole: LastDocs = { quote: { ...partQuote("Q-1", "2026-11-01", "2026-12-01", "Nov 2026"), part: null }, invoice: null, invoices: [], sent: null };
    const term = { source: "term", start: "2026-11-01", end: "2026-11-30", words: "Nov 2026", running: null };
    expect(duePeriodFacts({ key: "sent", quoteId: "Q-1", invoiceId: null }, whole, monthly, TODAY)).toMatchObject(term);
    const broken = sentPart("PI-B", "2026-10-01", "2026-10-01", "", "2026-10-01");
    expect(duePeriodFacts({ key: "sent", quoteId: "PI-B", invoiceId: null }, broken, monthly, TODAY)).toMatchObject(term);
    expect(duePeriodFacts(null, undefined, monthly, TODAY)).toMatchObject(term);
    expect(duePeriodFacts(null, undefined, { renewal_date: null }, TODAY)).toBeNull();
  });

  it("dueDaysOf = the Due column's own count; the renewal date's while the stage is not read", () => {
    expect(dueDaysOf({ anchorDate: "2026-11-11", anchorKind: "part", days: -5, partDueDate: "2026-11-11" }, { renewal_date: "2026-11-16" }, 0)).toBe(-5);
    expect(dueDaysOf(null, { renewal_date: "2026-11-16" }, 0)).toBe(0);
  });
});
