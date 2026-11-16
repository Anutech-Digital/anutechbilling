/**
 * R-2853 — the subscription period under an invoice number (/invoices, customer Transactions,
 * invoice page). Owner's examples (16 Nov 2026): "Google Workspace Business Starter · 1 Oct 2026 –
 * 30 Sep 2027", a part bill "Part 2 of 12 · 1–31 Oct 2026", several subscriptions billed together
 * "2 subscriptions · <earliest> – <latest>". Non-subscription invoices: nothing.
 */
import { describe, expect, it } from "vitest";
import { invoicePeriodLine, partRowsByInvoice, rangeWords, type InvoicePartRow } from "./invoice-period";

const stamped = (lines: Array<Record<string, unknown>>) => ({ line_items: lines });
const sp = (from: string, to: string, months: number | null = 12) => ({ from, to, months });

describe("rangeWords", () => {
  it("different years → both dates in full", () => {
    expect(rangeWords("2026-10-01", "2027-09-30")).toBe("1 Oct 2026 – 30 Sep 2027");
  });
  it("same month → 1–31 Oct 2026", () => {
    expect(rangeWords("2026-10-01", "2026-10-31")).toBe("1–31 Oct 2026");
  });
  it("same year, different months → year once", () => {
    expect(rangeWords("2026-10-01", "2026-12-31")).toBe("1 Oct – 31 Dec 2026");
  });
  it("one day", () => {
    expect(rangeWords("2026-10-05", "2026-10-05")).toBe("5 Oct 2026");
  });
});

describe("invoicePeriodLine — stored line periods (R-2744 / R-2848)", () => {
  it("one subscription line → '<plan> · <from> – <to>'", () => {
    const inv = stamped([{ name: "Google Workspace Business Starter", service_period: sp("2026-10-01", "2027-09-30") }]);
    expect(invoicePeriodLine(inv)).toBe("Google Workspace Business Starter · 1 Oct 2026 – 30 Sep 2027");
  });

  it("a one-time line next to it (null period) is left out", () => {
    const inv = stamped([
      { name: "Google Workspace Business Starter", service_period: sp("2026-10-01", "2027-09-30") },
      { name: "Setup fee", service_period: null },
    ]);
    expect(invoicePeriodLine(inv)).toBe("Google Workspace Business Starter · 1 Oct 2026 – 30 Sep 2027");
  });

  it("add-seats name window in brackets is not part of the plan", () => {
    const inv = stamped([{ name: "Google Workspace Business Starter (pro-rata from 2026-11-16 to 2027-09-30)", service_period: sp("2026-11-16", "2027-09-30", null) }]);
    expect(invoicePeriodLine(inv)).toBe("Google Workspace Business Starter · 16 Nov 2026 – 30 Sep 2027");
  });

  it("two lines of ONE subscription (previous + current term) → one plan, whole span", () => {
    const inv = stamped([
      { name: "Google Workspace Business Starter (previous term, pro-rata from 2026-08-01 to 2026-09-30)", service_period: sp("2026-08-01", "2026-09-30", null), subscription_id: "s1" },
      { name: "Google Workspace Business Starter (current term 2026-10-01 to 2027-09-30)", service_period: sp("2026-10-01", "2027-09-30", null), subscription_id: "s1" },
    ]);
    expect(invoicePeriodLine(inv)).toBe("Google Workspace Business Starter · 1 Aug 2026 – 30 Sep 2027");
  });

  it("several subscriptions (Bill together) → 'N subscriptions · earliest – latest'", () => {
    const inv = stamped([
      { name: "Google Workspace Business Starter", subscription_id: "s1", service_period: sp("2026-10-01", "2027-09-30") },
      { name: "Google Workspace Business Standard", subscription_id: "s2", service_period: sp("2026-11-15", "2027-11-14") },
    ]);
    expect(invoicePeriodLine(inv)).toBe("2 subscriptions · 1 Oct 2026 – 14 Nov 2027");
  });

  it("two different plans on one sale quote (no subscription id) count as two", () => {
    const inv = stamped([
      { name: "Google Workspace Business Starter", service_period: sp("2026-10-01", "2027-09-30") },
      { name: "Google Vault", service_period: sp("2026-10-01", "2027-09-30") },
    ]);
    expect(invoicePeriodLine(inv)).toBe("2 subscriptions · 1 Oct 2026 – 30 Sep 2027");
  });

  it("not stamped (issued before R-2744), no lines, or only one-time lines → null (unchanged)", () => {
    expect(invoicePeriodLine(stamped([{ name: "Google Workspace Business Starter", qty: 5 }]))).toBeNull();
    expect(invoicePeriodLine({ line_items: [] })).toBeNull();
    expect(invoicePeriodLine({ line_items: null })).toBeNull();
    expect(invoicePeriodLine(stamped([{ name: "Consulting", service_period: null }]))).toBeNull();
  });

  it("a malformed stored period prints nothing rather than a wrong date", () => {
    expect(invoicePeriodLine(stamped([{ name: "X", service_period: { from: "2026-13-01", to: "2027-01-01", months: 12 } }]))).toBeNull();
  });
});

describe("invoicePeriodLine — part bills (subscription_billings.invoice_id)", () => {
  const part = (o: Partial<InvoicePartRow>): InvoicePartRow => ({
    invoice_id: "INV-1", subscription_id: "s1", period_index: 2,
    period_start: "2026-10-01", period_end: "2026-11-01", billing_cycle: "monthly", term_months: 12, ...o,
  });

  it("one part → 'Part 2 of 12 · 1–31 Oct 2026' (period_end is exclusive)", () => {
    expect(invoicePeriodLine({ line_items: [] }, [part({})])).toBe("Part 2 of 12 · 1–31 Oct 2026");
  });

  it("the part wins over any stored line period", () => {
    const inv = stamped([{ name: "Google Workspace Business Starter", service_period: sp("2026-10-01", "2027-09-30") }]);
    expect(invoicePeriodLine(inv, [part({})])).toBe("Part 2 of 12 · 1–31 Oct 2026");
  });

  it("a term that does not divide → 'Part 2'", () => {
    expect(invoicePeriodLine({}, [part({ billing_cycle: "quarterly", term_months: 10 })])).toBe("Part 2 · 1–31 Oct 2026");
  });

  it("quarterly part across months", () => {
    expect(invoicePeriodLine({}, [part({ period_index: 1, billing_cycle: "quarterly", period_start: "2026-10-01", period_end: "2027-01-01" })]))
      .toBe("Part 1 of 4 · 1 Oct – 31 Dec 2026");
  });

  it("parts of several subscriptions on one bill → 'N subscriptions · earliest – latest'", () => {
    const rows = [part({}), part({ subscription_id: "s2", period_start: "2026-10-15", period_end: "2026-11-15" })];
    expect(invoicePeriodLine({}, rows)).toBe("2 subscriptions · 1 Oct – 14 Nov 2026");
  });

  it("two parts of one subscription → 'Parts 2–3 of 12 · span'", () => {
    const rows = [part({ period_index: 3, period_start: "2026-11-01", period_end: "2026-12-01" }), part({})];
    expect(invoicePeriodLine({}, rows)).toBe("Parts 2–3 of 12 · 1 Oct – 30 Nov 2026");
  });
});

describe("partRowsByInvoice", () => {
  it("groups by invoice id and drops rows with none", () => {
    const m = partRowsByInvoice([
      { invoice_id: "A", subscription_id: "s1", period_index: 1, period_start: "2026-10-01", period_end: "2026-11-01" },
      { invoice_id: null, subscription_id: "s1", period_index: 2, period_start: "2026-11-01", period_end: "2026-12-01" },
      { invoice_id: "A", subscription_id: "s2", period_index: 1, period_start: "2026-10-01", period_end: "2026-11-01" },
    ]);
    expect([...m.keys()]).toEqual(["A"]);
    expect(m.get("A")).toHaveLength(2);
  });
});
