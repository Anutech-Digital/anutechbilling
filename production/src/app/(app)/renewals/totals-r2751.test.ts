/**
 * R-2751 — Renewals: ONE amount basis everywhere (user audit 14 Nov 2026, job 7).
 *
 * The rule (also on the card): every renewal ₹ on /renewals — the row's figure, Sort: amount, the
 * tiles, the Forecast and the bulk/CSV total — is the renewal's TERM AMOUNT BEFORE GST ("+ GST").
 * A renewal quote never changes that number: a draft (just opening "Review renewal quote") shows
 * nothing at all, a sent/accepted quote only adds a small second line with its total incl. GST.
 * A paid renewal quote counts in "Renewed this month" at its amount before GST (subtotal less
 * discount). The Forecast bar for this month = the tile's "of ₹X due in <month>" (paid + still
 * due), and the header count = the tabs added up.
 *
 * Audit numbers: SCN Kochi ₹21,600/yr + GST; opening its renewal quote (draft Q-F588-27-0156,
 * ₹25,488 incl. IGST) raised "Due in 30 days" from ₹39.9K to ₹43.8K. Here it stays.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renewalAmount, queueTabs, QUEUE_TABS, type RenewalQuoteInfo } from "./queue";
import {
  monthOf, renewalTiles, quoteAmountBeforeGst, forecastWithThisMonth, type TileRow, type RenewalQuotePayment,
} from "./tiles";
import { renewalForecast } from "@/lib/renewals/forecast";

const NOV = monthOf("2026-11-14");
const kochi = { mrr: 1800, term_months: 12, term_amount: 21_600, billing_cycle: "yearly", renewal_quote_id: "Q-F588-27-0156" };
const quote = (status: string, amount = 25_488): RenewalQuoteInfo => ({ id: "Q-F588-27-0156", amount, status, payment_status: "none" });

describe("R-2751 the row's renewal amount has one basis (term amount before GST)", () => {
  const none = renewalAmount({ ...kochi, renewal_quote_id: null }, null);

  it("no quote: ₹21,600/yr + GST", () => {
    expect(none).toMatchObject({ value: 21_600, text: "₹21,600/yr", gst: "+ GST", quoteNote: null });
  });

  it("a DRAFT renewal quote (Review renewal quote opened, nothing sent) changes nothing", () => {
    expect(renewalAmount(kochi, quote("draft"))).toEqual(none);
  });

  it("a sent / viewed / accepted quote keeps the same number; its total incl. GST is only a note", () => {
    for (const s of ["sent", "viewed", "accepted"]) {
      const a = renewalAmount(kochi, quote(s));
      expect(a.value).toBe(21_600);
      expect(a.text).toBe("₹21,600/yr");
      expect(a.gst).toBe("+ GST");
      expect(a.quoteNote).toBe("Quote ₹25,488 incl. GST");
    }
  });

  it("a closed or someone else's quote adds no note", () => {
    expect(renewalAmount(kochi, quote("rejected")).quoteNote).toBeNull();
    expect(renewalAmount(kochi, { ...quote("sent"), id: "Q-OTHER" }).quoteNote).toBeNull();
  });
});

describe("R-2751 the tiles never move when a draft quote is made", () => {
  /* the 8–30 tab of the audit: SCN Kochi + three more rows, ₹39.9K together */
  const rowsWith = (q: RenewalQuoteInfo | null): TileRow[] => [
    { id: "kochi", tab: "d30", statusKey: "due", amount: renewalAmount(kochi, q).value, renewalDate: "2026-12-01" },
    { id: "delhi", tab: "d30", statusKey: "due", amount: 9_000, renewalDate: "2026-12-05" },
    { id: "ms1", tab: "d30", statusKey: "due", amount: 6_000, renewalDate: "2026-12-08" },
    { id: "ms2", tab: "due7", statusKey: "due", amount: 3_300, renewalDate: "2026-11-18" },
  ];
  it("Due in 30 days is the same before and after the draft (and after sending)", () => {
    const before = renewalTiles(rowsWith(null), [], NOV).due30;
    expect(before.amount).toBe(39_900);
    expect(renewalTiles(rowsWith(quote("draft")), [], NOV).due30).toEqual(before);
    expect(renewalTiles(rowsWith(quote("sent")), [], NOV).due30).toEqual(before);
  });
});

describe("R-2751 Renewed this month counts a paid quote before GST", () => {
  const paid = (over: Partial<RenewalQuotePayment>): RenewalQuotePayment => ({
    id: "Q-P", amount: 25_488, payment_amount: 25_488, payment_status: "received", status: "accepted",
    renewal_subscription_id: "kochi", renewal_term_date: "2026-11-05", subtotal: 21_600, discount_pct: 0, tax_rate: 18, ...over,
  });

  it("subtotal less discount; no subtotal → total ÷ (1 + GST rate)", () => {
    expect(quoteAmountBeforeGst(paid({}))).toBe(21_600);
    expect(quoteAmountBeforeGst(paid({ subtotal: 24_000, discount_pct: 10 }))).toBe(21_600);
    expect(quoteAmountBeforeGst(paid({ subtotal: 0 }))).toBe(21_600);
    expect(quoteAmountBeforeGst(paid({ subtotal: null, tax_rate: null }))).toBe(21_600);
  });

  it("the tile adds the paid quote at ₹21,600 (not ₹25,488) to the rows' ex-GST amounts", () => {
    const rows: TileRow[] = [{ id: "due-nov", tab: "due7", statusKey: "due", amount: 9_000, renewalDate: "2026-11-20" }];
    const t = renewalTiles(rows, [paid({})], NOV).renewedMonth;
    expect(t.amount).toBe(21_600);
    expect(t.dueAmount).toBe(21_600 + 9_000);
  });
});

describe("R-2751 numbers add up: Forecast this month = the tile; tabs = header", () => {
  it("the Forecast's bar for this month is the tile's 'of ₹X due in <month>', and the total moves with it", () => {
    const subs = [
      { status: "active", mrr: 750, term_months: 12, term_amount: 9_000, renewal_date: "2026-11-20" },
      { status: "active", mrr: 1000, term_months: 12, term_amount: 12_000, renewal_date: "2027-01-10" },
    ];
    const f = renewalForecast(subs as never, "2026-11-14");
    const rows: TileRow[] = [{ id: "a", tab: "due7", statusKey: "due", amount: 9_000, renewalDate: "2026-11-20" }];
    const paidQ: RenewalQuotePayment = {
      id: "Q-P", amount: 118_000, payment_amount: 118_000, payment_status: "received", status: "accepted",
      renewal_subscription_id: "b", renewal_term_date: "2026-11-02", subtotal: 100_000, discount_pct: 0, tax_rate: 18,
    };
    const tiles = renewalTiles(rows, [paidQ], NOV);
    const aligned = forecastWithThisMonth(f, tiles.renewedMonth, NOV);
    expect(aligned.months[0]).toMatchObject({ key: "2026-11", amount: tiles.renewedMonth.dueAmount, count: 2 });
    expect(aligned.months[0].amount).toBe(109_000);
    expect(aligned.months.slice(1)).toEqual(f.months.slice(1));
    expect(aligned.totalAmount).toBe(aligned.months.reduce((s, m) => s + m.amount, 0));
    expect(aligned.totalCount).toBe(aligned.months.reduce((s, m) => s + m.count, 0));
  });

  it("every listed row is on exactly one tab, so the tabs add up to the header's count", () => {
    const mk = (id: string, daysUntil: number) => ({ id, daysUntil });
    const tabs = queueTabs({
      expired: [mk("e", -3)], stopped: [mk("s", -40)], due7: [mk("a", 2)], upcoming: [mk("b", 20)],
      future: [mk("c", 45), mk("d", 80)], later: [mk("l", 200)], nonRenewing: [mk("w", 15)],
    } as never);
    const total = QUEUE_TABS.reduce((s, t) => s + tabs[t].length, 0);
    expect(total).toBe(8);
  });

  it("page: header counts the queue rows (= tabs), the Forecast gets the tile-aligned months, CSV basis is one", () => {
    const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
    expect(page).toContain("forecastWithThisMonth(");
    expect(page).not.toMatch(/activeSubs\} active subscription/);
    expect(page).toMatch(/\{queueCount\} subscription/);
    expect(page).not.toContain("Renewal quote, incl. GST");
  });
});
