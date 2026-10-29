import { describe, expect, it } from "vitest";
import { buildCustomerStatement, statementPayments, type StatementInput } from "./customer-statement";
import { invoiceAmountDue } from "@/lib/payments/amount-due";

const base: StatementInput = { invoices: [], payments: [], creditNotes: [], debitNotes: [], projectPayments: [] };

describe("R-1682 customer Statement", () => {
  it("staging T-19: invoice, payment, credit note, part refund → closing ₹0", () => {
    const { rows, closing } = buildCustomerStatement({
      ...base,
      invoices: [{ id: "INV-5F40-27-0079", invoice_date: "2026-10-19", amount: 7646 }],
      payments: [
        // the payment after the partial refund: ₹1,274 kept, ₹6,372 split off and refunded
        { id: "p1", quote_id: "Q-1", amount: 1274, status: "received", received_at: "2026-10-19T05:00:00Z", receipt_voucher_no: "RV-1" },
        { id: "p2", quote_id: "Q-1", amount: 6372, status: "refunded", received_at: "2026-10-19T05:00:00Z", refunded_at: "2026-10-19T09:00:00Z", refund_voucher_no: "RFV-1" },
      ],
      creditNotes: [{ id: "CN-5F40-27-0001", invoice_id: "INV-5F40-27-0079", credit_date: "2026-10-19", amount: 6372 }],
    });
    expect(closing).toBe(0);
    expect(rows.map((r) => r.desc)).toEqual([
      "Invoice INV-5F40-27-0079",
      "Payment received · RV-1",
      "Payment received",
      "Credit note CN-5F40-27-0001 · on INV-5F40-27-0079",
      "Refund · RFV-1",
    ]);
    // never dips into credit before the refund is shown
    expect(rows.map((r) => r.balance)).toEqual([7646, 6372, 0, -6372, 0]);
  });

  it("before the refund the credit note shows as money owed to the customer", () => {
    const { closing } = buildCustomerStatement({
      ...base,
      invoices: [{ id: "INV-1", invoice_date: "2026-10-19", amount: 7646 }],
      payments: [{ id: "p1", quote_id: "Q-1", amount: 7646, status: "received", received_at: "2026-10-19T05:00:00Z" }],
      creditNotes: [{ id: "CN-1", invoice_id: "INV-1", credit_date: "2026-10-19", amount: 6372 }],
    });
    expect(closing).toBe(-6372);
  });

  it("a fully refunded payment shows its receipt AND the refund (it used to show only the refund)", () => {
    const { rows, closing } = buildCustomerStatement({
      ...base,
      payments: [{ id: "p1", quote_id: "Q-1", amount: 1180, status: "refunded", received_at: "2026-10-01T05:00:00Z", refunded_at: "2026-10-05T05:00:00Z" }],
    });
    expect(rows).toHaveLength(2);
    expect(closing).toBe(0);
  });

  it("debit notes add to what is owed; project receipts reduce it", () => {
    const { closing } = buildCustomerStatement({
      ...base,
      invoices: [{ id: "INV-1", invoice_date: "2026-10-01", amount: 1000 }],
      debitNotes: [{ id: "DN-1", invoice_id: "INV-1", debit_date: "2026-10-02", amount: 180 }],
      projectPayments: [{ received_at: "2026-10-03T05:00:00Z", amount: 500, project_title: "Site", project_id: "pr1", invoice_id: null }],
    });
    expect(closing).toBe(680);
  });
});

/* R-1632 (weekly audit 19 Oct 2026): every row once; a void / draft invoice is not owed; a
   written-off invoice (R-1635) is not owed; a credit note lowers the due; a refund undoes its
   receipt (never a second due); advance credit spent on a payment is not money in twice. The
   closing must equal what /collections asks for (invoiceAmountDue per invoice) minus the
   customer's open credit. */
describe("R-1632 customer Statement — real sequences", () => {
  type Inv = StatementInput["invoices"][number];
  const inv = (o: Partial<Inv> & { id: string; amount: number }): Inv => ({
    invoice_date: "2026-10-01", status: "pending", net_payable: o.amount, paid_amount: 0, written_off_at: null, ...o,
  });
  const cases: Array<{
    name: string;
    input: Partial<StatementInput>;
    closing: number;
    /** What /collections says for the same customer: Σ invoiceAmountDue. */
    collectionsDue: number;
    /** The customer's open credit (Payments → credit). */
    openCredit: number;
    descs?: string[];
  }> = [
    {
      name: "card doneWhen: invoice 10k, payment 10k, credit note 10k, refund 10k → ₹0; the void invoice has no line",
      input: {
        invoices: [
          inv({ id: "INV-1", amount: 10000, net_payable: 0, paid_amount: 0, status: "paid" }),
          inv({ id: "INV-2", amount: 5000, status: "void", invoice_date: "2026-10-02" }),
        ],
        payments: [{ id: "p1", quote_id: "Q-1", amount: 10000, status: "refunded", received_at: "2026-10-01T06:00:00Z", refunded_at: "2026-10-05T06:00:00Z", receipt_voucher_no: "RV-1", refund_voucher_no: "RFV-1" }],
        creditNotes: [{ id: "CN-1", invoice_id: "INV-1", credit_date: "2026-10-04", amount: 10000 }],
      },
      closing: 0, collectionsDue: 0, openCredit: 0,
      descs: ["Invoice INV-1", "Payment received · RV-1", "Credit note CN-1 · on INV-1", "Refund · RFV-1"],
    },
    {
      name: "invoice 10k, part payment 4k, credit note 1k → ₹5,000 owed (same as /collections)",
      input: {
        invoices: [inv({ id: "INV-1", amount: 10000, net_payable: 9000, paid_amount: 4000 })],
        payments: [{ id: "p1", quote_id: "Q-1", amount: 4000, status: "received", received_at: "2026-10-02T06:00:00Z" }],
        creditNotes: [{ id: "CN-1", invoice_id: "INV-1", credit_date: "2026-10-03", amount: 1000 }],
      },
      closing: 5000, collectionsDue: 5000, openCredit: 0,
    },
    {
      name: "the same invoice written off (R-1635) → ₹0, with a 'Written off' line for the ₹5,000",
      input: {
        invoices: [inv({ id: "INV-1", amount: 10000, net_payable: 9000, paid_amount: 4000, written_off_at: "2026-10-10T06:00:00Z" })],
        payments: [{ id: "p1", quote_id: "Q-1", amount: 4000, status: "received", received_at: "2026-10-02T06:00:00Z" }],
        creditNotes: [{ id: "CN-1", invoice_id: "INV-1", credit_date: "2026-10-03", amount: 1000 }],
      },
      closing: 0, collectionsDue: 0, openCredit: 0,
      descs: ["Invoice INV-1", "Payment received", "Credit note CN-1 · on INV-1", "Written off · INV-1 (not collected)"],
    },
    {
      name: "a draft invoice is not owed yet",
      input: { invoices: [inv({ id: "INV-D", amount: 2360, status: "draft" })] },
      closing: 0, collectionsDue: 0, openCredit: 0, descs: [],
    },
    {
      name: "a void invoice's credit note is not a credit either (the invoice it reverses is off the statement)",
      input: {
        invoices: [inv({ id: "INV-V", amount: 1180, status: "void" })],
        creditNotes: [{ id: "CN-V", invoice_id: "INV-V", credit_date: "2026-10-03", amount: 1180 }],
      },
      closing: 0, collectionsDue: 0, openCredit: 0, descs: [],
    },
    {
      name: "overpaid 2k becomes credit; the next payment spends it (credit_applied) — money in counted once",
      input: {
        invoices: [
          inv({ id: "INV-1", amount: 10000, paid_amount: 10000, status: "paid" }),
          inv({ id: "INV-2", amount: 5000, paid_amount: 5000, status: "paid", invoice_date: "2026-10-08" }),
        ],
        payments: [
          { id: "p1", quote_id: "Q-1", amount: 12000, status: "received", received_at: "2026-10-01T06:00:00Z" },
          { id: "p2", quote_id: "Q-2", amount: 5000, credit_applied: 2000, status: "received", received_at: "2026-10-08T06:00:00Z" },
        ],
      },
      closing: 0, collectionsDue: 0, openCredit: 0,
    },
    {
      name: "a refund of a payment that spent credit gives back only the cash part",
      input: {
        invoices: [inv({ id: "INV-1", amount: 5000, paid_amount: 0, invoice_date: "2026-10-08" })],
        payments: [
          { id: "p0", quote_id: "Q-0", amount: 2000, status: "received", received_at: "2026-10-01T06:00:00Z" },
          { id: "p1", quote_id: "Q-1", amount: 5000, credit_applied: 2000, status: "refunded", received_at: "2026-10-08T06:00:00Z", refunded_at: "2026-10-09T06:00:00Z" },
        ],
      },
      // the invoice is owed again (₹5,000); the ₹2,000 advance is credit again → net ₹3,000
      closing: 3000, collectionsDue: 5000, openCredit: 2000,
    },
  ];

  it.each(cases)("$name", ({ input, closing, collectionsDue, openCredit, descs }) => {
    const out = buildCustomerStatement({ ...base, ...input });
    expect(out.closing).toBe(closing);
    expect(out.closing).toBe(collectionsDue - openCredit);
    // /collections reads pending / overdue invoices and asks invoiceAmountDue of each
    const due = (input.invoices ?? [])
      .filter((i) => i.status === "pending" || i.status === "overdue")
      .reduce((s, i) => s + invoiceAmountDue(i), 0);
    expect(due).toBe(collectionsDue);
    if (descs) expect(out.rows.map((r) => r.desc)).toEqual(descs);
    // every row once
    const keys = out.rows.map((r) => `${r.date}|${r.desc}|${r.debit}|${r.credit}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("R-1632 statementPayments — the /payments customer rule", () => {
  const pays = [
    { id: "a", customer_id: "c1", quote_id: "Q-1" },
    { id: "b", customer_id: null, quote_id: "Q-2" },   // taken before the lead was converted
    { id: "c", customer_id: null, quote_id: "Q-9" },   // someone else's quote
    { id: "d", customer_id: "c2", quote_id: null },
  ];
  it("keeps a payment by its own customer_id or by its quote's customer", () => {
    expect(statementPayments(pays, "c1", ["Q-1", "Q-2"]).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("R-2029 statement labels a customer advance", () => {
  it("a payment on an advance holder quote reads 'Advance (RV-…)' — balance unchanged", () => {
    const input: StatementInput = {
      ...base,
      payments: [
        { id: "p1", quote_id: "Q-ADV", amount: 47348, status: "received", received_at: "2026-10-27T05:00:00Z", receipt_voucher_no: "RV-0042" },
        { id: "p2", quote_id: "Q-2", amount: 1000, status: "received", received_at: "2026-10-27T06:00:00Z", receipt_voucher_no: "RV-0043" },
      ],
    };
    const plain = buildCustomerStatement(input);
    const labelled = buildCustomerStatement({ ...input, isAdvanceQuote: (id) => id === "Q-ADV" });
    expect(labelled.rows.map((r) => r.desc)).toEqual(["Advance (RV-0042)", "Payment received · RV-0043"]);
    expect(labelled.rows.map((r) => r.balance)).toEqual(plain.rows.map((r) => r.balance));
    expect(labelled.closing).toBe(plain.closing);
  });
});

describe("R-2029 follow-up: an advance on the statement — closing credit, Use advance not counted twice", () => {
  // SCN Bharat Apps shape: ₹4,00,000 advance (R-1863: a payment on the ₹0 holder quote,
  // received on the bank date), later two invoices paid with "Use advance" (R-2023:
  // record_desk_payment with credit_applied — no new cash).
  const advance = { id: "adv", quote_id: "Q-ADV", amount: 400000, status: "received", received_at: "2026-10-25T00:00:00Z", receipt_voucher_no: "RV-F588-27-0021" };
  const isAdvanceQuote = (id: string) => id === "Q-ADV";

  it("the advance alone: an 'Advance (RV-…)' credit row on its receipt date, closing ₹4,00,000 credit", () => {
    const { rows, closing } = buildCustomerStatement({ ...base, payments: [advance], isAdvanceQuote });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-10-25T00:00:00Z", desc: "Advance (RV-F588-27-0021)", debit: 0, credit: 400000 });
    expect(closing).toBe(-400000);
  });

  it("after Use advance on an invoice the advance is not counted twice — closing = advance − invoice", () => {
    const { rows, closing } = buildCustomerStatement({
      ...base,
      invoices: [{ id: "INV-1", invoice_date: "2026-10-27", amount: 118000 }],
      payments: [
        advance,
        { id: "use", quote_id: "Q-1", invoice_id: "INV-1", amount: 118000, credit_applied: 118000, status: "received", received_at: "2026-10-27T06:00:00Z", receipt_voucher_no: "RV-F588-27-0022" },
      ],
      isAdvanceQuote,
    });
    expect(closing).toBe(118000 - 400000);
    expect(rows.reduce((s, r) => s + r.credit, 0)).toBe(400000);
  });
});

describe("R-2029 follow-up: one bank receipt that paid several project instalments = one row (+ one TDS row)", () => {
  // SCN Bharat Apps, local 24 Oct: one ₹2,12,400 bank line paid Kist 1 and Kist 2 (₹1,06,200
  // each, bank_txn …432) and each carried ₹11,800 TDS 194J (method tds, no bank line).
  const P = (id: string, ms: string, label: string, amount: number, method: string, reference: string, bank: string | null) => ({
    id, received_at: "2026-10-24", amount, reference, project_title: "SCN Website", project_id: "proj-1", invoice_id: null,
    method, bank_txn_id: bank, milestone_id: ms, milestone_label: label,
  });
  const scn = [
    P("a", "m1", "Kist 1 — advance", 106200, "bank_transfer", "SCN-N298261957000432", "bt-432"),
    P("b", "m1", "Kist 1 — advance", 11800, "tds", "TDS 194J @ 10% on ₹100000", null),
    P("c", "m2", "Kist 2 — delivery", 106200, "bank_transfer", "SCN-N298261957000432", "bt-432"),
    P("d", "m2", "Kist 2 — delivery", 11800, "tds", "TDS 194J @ 10% on ₹100000", null),
  ];
  const invoices = [{ id: "INV-1", invoice_date: "2026-10-20", amount: 260000 }];

  it("shows ONE receipt row and ONE TDS row, amounts summed, closing unchanged", () => {
    const ungrouped = scn.map(({ bank_txn_id: _b, milestone_id: _m, milestone_label: _l, method: _x, ...r }) => r);
    const before = buildCustomerStatement({ ...base, invoices, projectPayments: ungrouped });
    const { rows, closing } = buildCustomerStatement({ ...base, invoices, projectPayments: scn });
    expect(before.rows).toHaveLength(5);
    expect(rows.map((r) => [r.desc, r.credit])).toEqual([
      ["Invoice INV-1", 0],
      ["Payment received · SCN-N298261957000432 · Kist 1 + Kist 2", 212400],
      ["TDS 194J · Kist 1 + Kist 2", 23600],
    ]);
    expect(closing).toBe(before.closing);
    expect(rows[rows.length - 1].balance).toBe(before.rows[before.rows.length - 1].balance);
  });

  it("a long list of instalments is capped: 'Kist 1 + Kist 2 + 2 more'", () => {
    const many = [1, 2, 3, 4].map((n) => P(`x${n}`, `m${n}`, `Kist ${n}`, 1000, "bank_transfer", "REF-9", "bt-9"));
    const { rows } = buildCustomerStatement({ ...base, projectPayments: many });
    expect(rows.map((r) => [r.desc, r.credit])).toEqual([["Payment received · REF-9 · Kist 1 + Kist 2 + 2 more", 4000]]);
  });

  it("a receipt for a single instalment reads as before", () => {
    const one = [scn[0], scn[1]];
    const { rows } = buildCustomerStatement({ ...base, projectPayments: one });
    expect(rows.map((r) => [r.desc, r.credit])).toEqual([
      ["Payment received · SCN-N298261957000432", 106200],
      ["Payment received · TDS 194J @ 10% on ₹100000", 11800],
    ]);
  });
});
