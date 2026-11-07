/**
 * R-2548 (Pardeep, 7 Nov 2026) — an annual commitment paid half-yearly / quarterly / monthly
 * showed the same "Bill next part" mid-year AND at the end of the year. The end-of-year click is
 * the RENEWAL (part 1 of the next term at today's seats × rate), so the button now says so:
 * "Bill renewal · part 1 of next year" (… "of next term" for a non-yearly term) with the line
 * "Renewal for <term dates> · part 1 (<its dates>): <seats> × ₹<rate>". Mid-term parts keep "Bill next part". One rule
 * (nextPartToBill) for the Renewals page and Payment Follow-up.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renewalActionSet, renewalNextStep, nextPartToBill, billPartDialogTitle,
  BILL_NEXT_PART, BILL_RENEWAL_YEAR, BILL_RENEWAL_TERM, SEND_RENEWAL_QUOTE,
  type RenewalActionSub,
} from "./renewal-actions-rules";

/* An annual Workspace commitment, 10 seats at ₹500 a seat a month (₹60,000 a year), term 1 Jan–31 Dec 2026. */
const sub = (p: Partial<RenewalActionSub> = {}): RenewalActionSub => ({
  id: "s1", renewal_state: "notice_sent", renewal_date: "2026-12-31", term_months: 12, status: "active",
  auto_renew: true, renewal_quote_id: null, billing_cycle: "half_yearly", grace_until: null,
  start_date: "2026-01-01", seats: 10, mrr: 5000, term_amount: null, ...p,
});
const OWNER = { tenantGraceDays: 15, canEndSubscription: true };
/** IST days from `today` to 31 Dec 2026. */
const days = (today: string) => Math.round((Date.parse("2026-12-31") - Date.parse(today)) / 86_400_000);

describe("R-2548 the next part to bill — mid-term part or the renewal", () => {
  it("half-yearly annual sub mid-year (15 May, part 2 starts 1 Jul): 'Bill next part', no renewal line", () => {
    const a = renewalActionSet(sub(), null, { ...OWNER, daysUntil: days("2026-05-15") });
    expect(a.primary).toEqual({ kind: "generate", label: BILL_NEXT_PART });
    expect(a.note).toBeNull();
  });

  it("the same sub on 1 Jul (part 2's own day): still 'Bill next part'", () => {
    expect(nextPartToBill(sub(), days("2026-07-01"))).toMatchObject({ label: BILL_NEXT_PART, renewal: false, note: null });
  });

  it("at year end (20 Dec, every part of 2026 billed): 'Bill renewal · part 1 of next year' + 'Renewal for 1 Jan–31 Dec 2027 · part 1 (1 Jan–30 Jun 2027): 10 × ₹3,000'", () => {
    const a = renewalActionSet(sub(), null, { ...OWNER, daysUntil: days("2026-12-20") });
    expect(a.primary).toEqual({ kind: "generate", label: BILL_RENEWAL_YEAR });
    expect(BILL_RENEWAL_YEAR).toBe("Bill renewal · part 1 of next year");
    /* ₹60,000 a year ÷ 2 parts = ₹30,000 a half-year ÷ 10 seats = ₹3,000 a seat a part. */
    expect(a.note).toBe("Renewal for 1 Jan–31 Dec 2027 · part 1 (1 Jan–30 Jun 2027): 10 × ₹3,000");
  });

  it("past the date unbilled (6 Jan 2027): the oldest unbilled part IS part 1 of the new term → the renewal label", () => {
    const a = renewalActionSet(sub({ renewal_state: "grace_period" }), null, { ...OWNER, daysUntil: -6 });
    expect(a.primary?.label).toBe(BILL_RENEWAL_YEAR);
    expect(a.note).toBe("Renewal for 1 Jan–31 Dec 2027 · part 1 (1 Jan–30 Jun 2027): 10 × ₹3,000");
  });

  it("quarterly: mid-term (part 4 starts 1 Oct) 'Bill next part'; after it, the renewal", () => {
    const q = sub({ billing_cycle: "quarterly" });
    expect(nextPartToBill(q, days("2026-09-20")).label).toBe(BILL_NEXT_PART);
    expect(nextPartToBill(q, days("2026-10-01")).label).toBe(BILL_NEXT_PART);
    expect(nextPartToBill(q, days("2026-10-02")).label).toBe(BILL_RENEWAL_YEAR);
    /* ₹60,000 ÷ 4 parts = ₹15,000 a quarter ÷ 10 seats. */
    expect(nextPartToBill(q, days("2026-10-02")).note).toBe("Renewal for 1 Jan–31 Dec 2027 · part 1 (1 Jan–31 Mar 2027): 10 × ₹1,500");
  });

  it("monthly on an annual commitment: Dec 1 is part 12 ('Bill next part'); from Dec 2 the next part is next year's part 1", () => {
    const m = sub({ billing_cycle: "monthly" });
    expect(nextPartToBill(m, days("2026-12-01")).label).toBe(BILL_NEXT_PART);
    expect(nextPartToBill(m, days("2026-12-02"))).toMatchObject({ label: BILL_RENEWAL_YEAR, note: "Renewal for 1 Jan–31 Dec 2027 · part 1 (1 Jan–31 Jan 2027): 10 × ₹500" });
  });

  it("a 6-month commitment paid quarterly says 'of next term', not 'of next year'", () => {
    const six = sub({ term_months: 6, billing_cycle: "quarterly", start_date: "2026-07-01", renewal_date: "2026-12-31", mrr: 5000 });
    const r = nextPartToBill(six, days("2026-12-20"));
    expect(r.label).toBe(BILL_RENEWAL_TERM);
    expect(BILL_RENEWAL_TERM).toBe("Bill renewal · part 1 of next term");
    expect(r.note).toBe("Renewal for 1 Jan–30 Jun 2027 · part 1 (1 Jan–31 Mar 2027): 10 × ₹1,500");
  });

  it("an annual subscription paid in one go is unchanged: Send renewal quote, no line", () => {
    const a = renewalActionSet(sub({ billing_cycle: "yearly" }), null, { ...OWNER, daysUntil: days("2026-12-20") });
    expect(a.primary).toEqual({ kind: "send-now", label: SEND_RENEWAL_QUOTE });
    expect(a.note).toBeNull();
  });

  it("monthly flex (1-month term, one part a term) keeps 'Bill next part' — 'part 1 of next term' would say nothing", () => {
    const flex = sub({ term_months: 1, billing_cycle: "monthly", renewal_date: "2026-10-30", renewal_state: "grace_period" });
    const a = renewalActionSet(flex, null, { ...OWNER, daysUntil: -2 });
    expect(a.primary).toEqual({ kind: "generate", label: BILL_NEXT_PART });
    expect(a.note).toBeNull();
  });

  it("no per-seat rate (amount does not divide by the seats, or no seats) → the part's amount + GST; no amount at all → the dates only", () => {
    expect(nextPartToBill(sub({ seats: 7 }), days("2026-12-20")).note).toBe("Renewal for 1 Jan–31 Dec 2027 · part 1 (1 Jan–30 Jun 2027): ₹30,000 + GST");
    expect(nextPartToBill(sub({ seats: null }), days("2026-12-20")).note).toBe("Renewal for 1 Jan–31 Dec 2027 · part 1 (1 Jan–30 Jun 2027): ₹30,000 + GST");
    expect(nextPartToBill(sub({ seats: null, mrr: null }), days("2026-12-20")).note).toBe("Renewal for 1 Jan–31 Dec 2027 · part 1 (1 Jan–30 Jun 2027)");
  });

  it("term_amount (the agreed term price) wins over mrr × months, as everywhere else (termAmountOf)", () => {
    expect(nextPartToBill(sub({ term_amount: 48_000 }), days("2026-12-20")).note).toBe("Renewal for 1 Jan–31 Dec 2027 · part 1 (1 Jan–30 Jun 2027): 10 × ₹2,400");
  });

  it("a renewal quote already exists → Send / Resend as before, never the Bill renewal button", () => {
    const a = renewalActionSet(sub({ renewal_quote_id: "Q-1" }), "draft", { ...OWNER, daysUntil: 5 });
    expect(a.primary?.kind).toBe("send-now");
    expect(a.note).toBeNull();
  });

  it("renewalNextStep carries the renewal label as the row's ONE button (Renewals and Payment Follow-up)", () => {
    const set = renewalActionSet(sub(), null, { ...OWNER, daysUntil: days("2026-12-20") });
    expect(renewalNextStep(set, { followup: true, messaging: true }).button).toEqual({ kind: "generate", label: BILL_RENEWAL_YEAR });
    expect(renewalNextStep(set, { followup: false, messaging: false }).button?.label).toBe(BILL_RENEWAL_YEAR);
  });
});

describe("R-2548 one source on both pages", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("the component renders the rule's line (set.note); Payment Follow-up's renewal rows carry seats for it", () => {
    const comp = read("src/components/features/renewals/renewal-actions.tsx");
    expect(comp).toMatch(/set\.note/);
    expect(comp).not.toMatch(/Bill renewal/);   // the label lives in the rules file only
    const cols = read("src/lib/queries/collections.ts");
    expect(cols).toMatch(/seats/);
  });
});

describe("R-2548 review — the dialog title follows what the server will bill", () => {
  it("preview's first period = next term's start → the renewal title; a missed / freed part of this term → Bill next part", () => {
    expect(billPartDialogTitle(sub(), BILL_RENEWAL_YEAR, "2027-01-01")).toBe(BILL_RENEWAL_YEAR);
    /* Dec 2026 part missed or freed (R-2519b): firstUnbilledPeriod bills it first — not the renewal. */
    expect(billPartDialogTitle(sub({ billing_cycle: "monthly" }), BILL_RENEWAL_YEAR, "2026-12-01")).toBe(BILL_NEXT_PART);
    /* The row said Bill next part (1 Dec) but the billing job already raised Dec → the click bills the renewal. */
    expect(billPartDialogTitle(sub({ billing_cycle: "monthly" }), BILL_NEXT_PART, "2027-01-01")).toBe(BILL_RENEWAL_YEAR);
    expect(billPartDialogTitle(sub({ term_months: 6, billing_cycle: "quarterly", start_date: "2026-07-01" }), BILL_NEXT_PART, "2027-01-01")).toBe(BILL_RENEWAL_TERM);
  });

  it("before the preview loads: the row's own label; flex (one part a term): Bill next part", () => {
    expect(billPartDialogTitle(sub(), BILL_RENEWAL_YEAR, null)).toBe(BILL_RENEWAL_YEAR);
    expect(billPartDialogTitle(sub({ term_months: 1, billing_cycle: "monthly", renewal_date: "2026-10-30" }), BILL_NEXT_PART, "2026-10-31")).toBe(BILL_NEXT_PART);
  });

  it("the set carries `renewal` (the tooltip and the line hang on it, not on the note's text)", () => {
    expect(renewalActionSet(sub(), null, { ...OWNER, daysUntil: days("2026-12-20") }).renewal).toBe(true);
    expect(renewalActionSet(sub(), null, { ...OWNER, daysUntil: days("2026-05-15") }).renewal).toBe(false);
  });

  it("the dialog takes its title from the rule; Bulk send names the row's own button", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(read("src/components/features/renewals/bill-next-part-dialog.tsx")).toMatch(/titleFor\(preview\?\.firstStart/);
    expect(read("src/components/features/renewals/renewal-actions.tsx")).toMatch(/billPartDialogTitle\(/);
    expect(read("src/app/(app)/renewals/queue.ts")).toMatch(/use \$\{set\.primary\.label\}/);
  });
});
