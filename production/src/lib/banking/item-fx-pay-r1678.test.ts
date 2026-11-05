/* R-1678 — a foreign-currency invoice settled from a bank credit: in ₹ (no "USD…@" in the narration),
   or several invoices of one currency on one credit. The same rules as reconcile_bank_credit_split's
   p_rest 'fx' (migration 20261105175200; SQL test r1678_forex_receipts). Real cases, R-2094:
     #7  Peak Performance Hackers  USD 139 @ 95.007 = ₹13,206; ₹12,976 reached the bank → ₹230 loss.
     #10 Timbergloss (UAE)         USD 759 @ 95.17  = ₹72,234; "USD759.0@93.55" ₹71,004 → ₹1,230 loss.
     #27 Bot Workshop              several invoices on one inward credit → split by each invoice's USD. */
import { describe, expect, it } from "vitest";
import { EXCHANGE_LEDGER, fxDefaultChoice, itemPayPlan, splitFxPlan, splitFxText } from "./item-fx-pay";
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";

const inv = (id: string, due: number, rate: number, currency = "USD") =>
  ({ kind: "invoice" as const, invoice_id: id, quote_id: `Q-${id}`, amount_due: due, currency, fx_rate: rate });
const line = (description: string, credit: number) => ({ description, credit });
const US = { customerCountry: "United States" };

describe("R-1678 a ₹ receipt settles a USD invoice", () => {
  it("Peak Performance: ₹12,976 for USD 139 @ 95.007 (₹13,206) → paid in full, ₹230 exchange loss, nothing due, no TDS", () => {
    const peak = inv("INV-0823", 13206, 95.007);
    const p = itemPayPlan(peak, line("NEFT CR-CITI0000001-PEAK PERFORMANCE HACKERS", 12976), US);
    expect(p.problem).toBeNull();
    expect(p.fx).toBeNull();
    expect(p.splitFx).toMatchObject({ currency: "USD", foreignDue: 139, due: 13206, remittance: null, bankCharges: 0, forex: 230 });
    expect(splitFxText(p.splitFx!)).toBe(
      `INV-0823 is settled in full ($139 due = ₹13,206 at its own rate) — ₹230 exchange loss to "${EXCHANGE_LEDGER}" on the bank line's date. Nothing stays due; no TDS. The ₹ gap is 1.74% of the due.`);
    expect(fxDefaultChoice(p.splitFx!, line("NEFT CR-CITI0000001-PEAK PERFORMANCE HACKERS", 12976), 13206)).toBe("fx");
  });

  it("R-1678b: more ₹ than due on a ₹ credit is an ADVANCE, never an exchange gain — a plain ₹ payment", () => {
    expect(itemPayPlan(inv("INV-G", 83000, 83), line("NEFT CR", 84500), US)).toEqual({ fx: null, problem: null, splitFx: null });
  });

  it("R-1678b: exactly 10% short (TDS-shaped) and anything over 5% is not exchange; 5% itself is", () => {
    expect(itemPayPlan(inv("INV-T", 100000, 100), line("NEFT CR", 90000), US).splitFx).toBeNull();
    expect(itemPayPlan(inv("INV-T", 100000, 100), line("NEFT CR", 94999), US).splitFx).toBeNull();
    expect(itemPayPlan(inv("INV-T", 100000, 100), line("NEFT CR", 95000), US).splitFx).toMatchObject({ forex: 5000, gapPct: 5 });
  });

  it("R-1678b: a customer in India (or no country) never gets an exchange difference on a ₹ credit", () => {
    expect(itemPayPlan(inv("INV-I", 100000, 100), line("NEFT CR", 98000), { customerCountry: "India" })).toEqual({ fx: null, problem: null, splitFx: null });
    expect(itemPayPlan(inv("INV-I", 100000, 100), line("NEFT CR", 98000), {}).splitFx).toBeNull();
  });

  it("R-1678b: the sheet pre-selects 'book in ₹' for a 2% TDS-shaped gap and for a gateway settlement", () => {
    const tds = itemPayPlan(inv("INV-2", 100000, 100), line("NEFT CR ACME LLC", 98000), US).splitFx!;
    expect(fxDefaultChoice(tds, line("NEFT CR ACME LLC", 98000), 100000)).toBe("rupee");
    const rzp = itemPayPlan(inv("INV-R", 13206, 95.007), line("RAZORPAY SOFTWARE PVT LTD SETTLEMENT", 12976), US).splitFx!;
    expect(fxDefaultChoice(rzp, line("RAZORPAY SOFTWARE PVT LTD SETTLEMENT", 12976), 13206)).toBe("rupee");
    const usd = splitFxPlan([{ item: inv("INV-W", 90000, 90), amount: 90000 }], line("INW X USD1000.0@95", 95000)).fx!;
    expect(fxDefaultChoice(usd, line("INW X USD1000.0@95", 95000), 90000)).toBe("fx");   // a remittance: no choice
  });

  it("a ₹ gap of more than 5% is not an exchange difference — a plain ₹ payment (part / TDS / advance as usual)", () => {
    const p = itemPayPlan(inv("INV-P", 47000, 94), line("NEFT CR BOT", 40000), US);
    expect(p).toEqual({ fx: null, problem: null, splitFx: null });
    expect(splitFxPlan([{ item: inv("INV-P", 47000, 94), amount: 40000 }], line("NEFT CR BOT", 40000))).toEqual({ fx: null, problem: null });
  });

  it("paise: the credit is rounded once, and the parts add up to the booked difference", () => {
    const s = splitFxPlan([{ item: inv("INV-0823", 13206, 95.007), amount: 13206 }], line("NEFT CR PEAK", 12976.5), US);
    expect(s.fx).toMatchObject({ forex: 229, parts: [{ bankShare: 12977, forex: 229 }] });
  });

  it("the ledger is one of the expense heads, under the owner's name", () => {
    expect(EXCHANGE_LEDGER).toBe("Exchange gain / loss (realised)");
    expect(EXPENSE_CATEGORIES).toContain(EXCHANGE_LEDGER);
    expect(EXPENSE_CATEGORIES as readonly string[]).not.toContain("Foreign Exchange Gain / Loss");
  });
});

describe("R-1678 several USD invoices on one credit", () => {
  const bot1 = inv("INV-0372", 90000, 90);
  const bot2 = inv("INV-0373", 46000, 92);

  it("one inward credit USD 1,500 @ 95 for $1,000 + $500 → both in full, gain split by each invoice's USD", () => {
    const s = splitFxPlan([{ item: bot1, amount: 90000 }, { item: bot2, amount: 46000 }], line("INW 100926I049900020 USD1500.0@95", 142500));
    expect(s.problem).toBeNull();
    expect(s.fx).toMatchObject({ currency: "USD", foreignDue: 1500, due: 136000, bankCharges: 0, forex: -6500 });
    expect(s.fx!.parts).toEqual([
      { id: "INV-0372", foreignDue: 1000, due: 90000, bankShare: 95000, bankCharges: 0, forex: -5000 },
      { id: "INV-0373", foreignDue: 500, due: 46000, bankShare: 47500, bankCharges: 0, forex: -1500 },
    ]);
    expect(splitFxText(s.fx!)).toContain("By each invoice's USD: INV-0372 gain ₹5,000, INV-0373 gain ₹1,500.");
  });

  it("charges kept abroad on a short remittance → Bank Charges, split by USD too", () => {
    const s = splitFxPlan([{ item: bot1, amount: 90000 }, { item: bot2, amount: 46000 }], line("INW X USD1470.0@95", 139650));
    expect(s.fx).toMatchObject({ bankCharges: 2850, forex: 136000 - 2850 - 139650 });
    expect(s.fx!.parts.map((p) => p.bankCharges)).toEqual([1900, 950]);
    expect(s.fx!.parts.reduce((a, p) => a + p.forex, 0)).toBe(s.fx!.forex);
  });

  it("refusals: ₹ item mixed in, two currencies, part payment, a new sale, more dollars than due, another currency", () => {
    const rupees = { ...inv("INV-INR", 10000, 1), currency: "INR", fx_rate: null };
    const eur = inv("INV-EUR", 50000, 100, "EUR");
    const credit = line("INW X USD1500.0@95", 142500);
    expect(splitFxPlan([{ item: rupees, amount: 10000 }], credit)).toEqual({ fx: null, problem: null });   // a plain ₹ split
    expect(splitFxPlan([{ item: bot1, amount: 90000 }, { item: rupees, amount: 10000 }], credit).problem).toMatch(/pay them separately/);
    expect(splitFxPlan([{ item: bot1, amount: 90000 }, { item: eur, amount: 50000 }], credit).problem).toMatch(/one currency together/);
    expect(splitFxPlan([{ item: bot1, amount: 80000 }], credit).problem).toMatch(/settles its invoices in full/);
    expect(splitFxPlan([{ item: bot1, amount: 90000 }], credit, { sale: true }).problem).toMatch(/new sale on its own/);
    expect(splitFxPlan([{ item: bot1, amount: 90000 }], credit).problem).toMatch(/the extra is the customer's advance/);
    expect(splitFxPlan([{ item: bot1, amount: 90000 }], line("INW X EUR900.0@100", 90000)).problem).toMatch(/came in EUR/);
  });
});
