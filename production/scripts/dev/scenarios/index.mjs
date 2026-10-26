/**
 * R-1957 — the named test scenarios scripts/dev/scenario.mjs loads into "E2E Test Co" (LOCAL DB only).
 *
 * Each entry says which rows the scenario owns (fixed ids — the SQL file inserts exactly these),
 * what a fresh load must count, which board cards it serves and which pages to open.
 * The SQL lives next to this file (<name>.sql); _common.sql holds the scope / clear / count helpers.
 */

/** The scenarios' own bank account ("SCN HDFC Current ··7788"), created when missing. */
export const SCN_ACCOUNT_ID = "c1957000-0000-4000-8000-000000000a01";

const id = (n) => `c1957000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SCENARIOS = [
  {
    name: "vendor-sharma",
    about: "Sharma Associates (no bank details) with unpaid bills SCN-PS-1 ₹59,000 and SCN-PS-2 ₹11,800; Google Cloud India COGS bill SCN-G-20 ₹11,800; money-out lines ₹25,000 (NEFT DR) + ₹34,000 (IMPS) + ₹11,800 for Sharma, ₹5,000 for Google, and two UPI lines from Bansal Print House (not a vendor yet).",
    cards: ["R-1915", "R-1917", "R-1912", "R-1918", "R-1919"],
    scope: {
      vendors: [id(101), id(102)],
      txns: [id(111), id(112), id(113), id(114), id(115), id(116)],
      docs: ["EXP-SCN-PS-1", "EXP-SCN-PS-2", "BILL-SCN-G-20"],
      // a vendor someone adds from the Bansal lines (R-1918 "＋ New vendor") belongs to this scenario too
      names: ["bansal print house"],
      upis: ["bansalprint@okicici"],
    },
    // --self-test only: what a tester does in the app (the cards' own RPCs), so the reset is proven
    // to take away payments, a new bill, a new vendor and its learned alias — not just fresh rows.
    selfTestUse: `
      select public.reconcile_bank_debit_to_vendor('${id(111)}', '${id(101)}', null,
        '[{"source":"expense","doc_id":"EXP-SCN-PS-1","amount":25000,"tds_amount":0}]'::jsonb);
      select public.reconcile_bank_debit_to_vendor('${id(113)}', '${id(101)}', null,
        '[{"source":"expense","doc_id":"EXP-SCN-PS-2","amount":11800,"tds_amount":0}]'::jsonb);
      select public.pay_vendor_bill((public.reconcile_bank_debit_to_vendor('${id(114)}', '${id(102)}', null, '[]'::jsonb,
        '{"kind":"cogs","bill_no":"SCN-G-NEW","bill_date":"2026-10-20","category":"COGS-Workspace","taxable":10000,"gst":1800,"itc":true,"pay":5000}'::jsonb)
        ->'new_bill'->>'doc_id'), 6800, current_date, '${SCN_ACCOUNT_ID}', 'NEFT');
      select public.reconcile_bank_debit_to_vendor('${id(115)}', null,
        '{"name":"Bansal Print House","upi_id":"bansalprint@okicici"}'::jsonb, '[]'::jsonb, null, 7080, 'Printing & Stationery');
    `,
    expect: { vendors: 2, expenses: 2, bills: 1, txns: 6, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0 },
    pages: [
      { path: "banking", for: "R-1915 ₹25,000 + ₹34,000 Sharma lines · R-1917 ₹11,800 Sharma line · R-1912 ₹5,000 Google line · R-1918/R-1919 the two Bansal Print House UPI lines" },
      { path: "expenses", for: "R-1915 / R-1917 bills SCN-PS-1 and SCN-PS-2 (Partly paid / due)" },
      { path: "bills", for: "R-1912 Google COGS bills" },
      { path: "vendors", for: "R-1915 Sharma popup (₹ due) · R-1918 Bansal Print House bank details" },
    ],
  },
  {
    name: "vendor-advance",
    about: "Verma Traders: money-out lines ₹30,000 and ₹3,000 (advances to record), unpaid expense bills SCN-VT-1 ₹50,000 and SCN-VT-2 ₹5,000.",
    cards: ["R-1913", "R-1952"],
    scope: {
      vendors: [id(201)],
      txns: [id(211), id(212)],
      docs: ["EXP-SCN-VT-1", "EXP-SCN-VT-2"],
      names: [],
      upis: [],
    },
    selfTestUse: `
      select public.reconcile_bank_debit_to_vendor('${id(211)}', '${id(201)}', null, '[]'::jsonb, null, 30000, 'Repairs & Maintenance');
      select public.apply_vendor_advance('expense', 'EXP-SCN-VT-1', null, current_date);
    `,
    expect: { vendors: 1, expenses: 2, bills: 0, txns: 2, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0 },
    pages: [
      { path: "banking", for: "R-1913 ₹30,000 Verma line · R-1952 ₹3,000 Verma line → Record payment as an advance" },
      { path: "expenses", for: "R-1913 SCN-VT-1 Apply advance · R-1952 SCN-VT-2 Apply advance, then Mark paid shows ₹2,000" },
      { path: "payment-runs", for: "R-1952 SCN-VT-2 offered at ₹2,000" },
      { path: "balance-sheet", for: "R-1952 as-of a date before the advance was applied" },
    ],
  },
  {
    name: "bills-page-paid",
    about: "Mehta Cloud Distributors: COGS bill SCN-M-10 ₹10,000 with ₹5,000 already paid from the Bills page (manual bank line) + the real ₹5,000 HDFC line; expense SCN-MP-1 ₹4,720 marked paid (no bank line) + its real ₹4,720 line.",
    cards: ["R-1911"],
    scope: {
      vendors: [id(301)],
      txns: [id(311), id(312)],
      docs: ["BILL-SCN-M-10", "EXP-SCN-MP-1"],
      names: [],
      upis: [],
    },
    selfTestUse: `
      select public.reconcile_bank_debit_to_vendor('${id(311)}', '${id(301)}', null,
        jsonb_build_array(jsonb_build_object('source', 'recorded_payment', 'amount', 5000, 'doc_id',
          (select t.id from public.bank_transactions t where t.source = 'manual' and t.matched_to_id = 'BILL-SCN-M-10'))));
    `,
    // txns 3 = the two real lines + the manual line the Bills page wrote
    expect: { vendors: 1, expenses: 1, bills: 1, txns: 3, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0 },
    pages: [
      { path: "banking", for: "R-1911 the ₹5,000 Mehta line → 'Already paid … from the Bills page — match' · the ₹4,720 line → match the Mark-paid" },
      { path: "bills", for: "R-1911 SCN-M-10 stays Paid ₹5,000 (not ₹10,000)" },
      { path: "expenses", for: "R-1911 SCN-MP-1" },
    ],
  },
];

export const SCENARIO_NAMES = SCENARIOS.map((s) => s.name);

/** yyyy-mm-dd of a Date in local time. */
function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The URL for a page key on the local app.
 * @param {string} host  e.g. "localhost:3001"
 * @param {string} key   banking | expenses | bills | vendors | payment-runs | balance-sheet
 * @param {Date} [today]
 */
export function pageUrl(host, key, today = new Date()) {
  const from = ymd(new Date(today.getTime() - 90 * 86400000));
  const to = ymd(new Date(today.getTime() + 35 * 86400000));
  const base = `http://${host}`;
  switch (key) {
    case "banking": return `${base}/accounting/banking/${SCN_ACCOUNT_ID}`;
    case "expenses": return `${base}/accounting/expenses?from=${from}&to=${to}&q=SCN`;
    case "bills": return `${base}/accounting/bills?q=SCN`;
    default: return `${base}/accounting/${key}`;
  }
}

/** The SQL literal of a string array — values are fixed ids / names from this file, checked anyway. */
export function sqlTextArray(values) {
  for (const v of values) {
    if (!/^[A-Za-z0-9 ._@-]+$/.test(v)) throw new Error(`unsafe scenario value: ${v}`);
  }
  return `array[${values.map((v) => `'${v}'`).join(", ")}]::text[]`;
}
