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

/** R-1980: the sales-side counts (_common.sql scn_sales_count) — 0 for a vendor scenario. */
const NO_SALES = { leads: 0, quotes: 0, invoices: 0, payments: 0, subscriptions: 0, campaigns: 0, adDays: 0 };
/** R-1998: the project-side counts (_common.sql scn_project_count) — 0 for every other scenario. */
const NO_PROJECTS = { customers: 0, projects: 0, milestones: 0, projectPayments: 0, projectInvoices: 0, tdsRows: 0 };

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
    expect: { vendors: 2, expenses: 2, bills: 1, txns: 6, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0, ...NO_SALES, ...NO_PROJECTS },
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
    expect: { vendors: 1, expenses: 2, bills: 0, txns: 2, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0, ...NO_SALES, ...NO_PROJECTS },
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
    expect: { vendors: 1, expenses: 1, bills: 1, txns: 3, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0, ...NO_SALES, ...NO_PROJECTS },
    pages: [
      { path: "banking", for: "R-1911 the ₹5,000 Mehta line → 'Already paid … from the Bills page — match' · the ₹4,720 line → match the Mark-paid" },
      { path: "bills", for: "R-1911 SCN-M-10 stays Paid ₹5,000 (not ₹10,000)" },
      { path: "expenses", for: "R-1911 SCN-MP-1" },
    ],
  },
  {
    name: "ads-month",
    about: "Two ad campaigns this month — SCN Workspace Oct (Meta ₹5,000 + designer ₹1,000; the ₹4,000 Meta invoice is the same money, not added) and SCN Google Search (₹4,000) — and five website orders: Alpha ₹11,800, Beta ₹5,900 refunded, Gamma monthly flex ₹1,180 (invoice from subscription billing, no quote), Delta ₹23,600 in two halves (Google), Epsilon ₹2,360 (no campaign); plus Zeta, a Google lead that did not buy.",
    cards: ["R-1980"],
    scope: {
      vendors: [],
      txns: [],
      // every sales row is found from these (see _common.sql scn_sales_scope)
      docs: [
        "EXP-SCN-ADS-1", "EXP-SCN-ADS-2",
        "SCN-ADS-L1", "SCN-ADS-L2", "SCN-ADS-L3", "SCN-ADS-L4", "SCN-ADS-L5", "SCN-ADS-L6",
        "SCN-ADS-INV1", "SCN-ADS-INV3",
        "scn-ws-oct", "scn-gads-search",
        "SCN-ADS-META", "SCN-ADS-GOOGLE",
      ],
      names: [],
      upis: [],
    },
    // Hand-worked (src/lib/marketing/campaign-sales.test.ts, same data):
    //   Workspace Oct  spend 6,000 · 250 clicks · 3 leads · 2 paid · ₹11,000 (16,000 − 5,000 refund) · ROAS 1.83 · CAC 3,000
    //   Google Search  spend 4,000 ·  80 clicks · 2 leads · 1 paid · ₹20,000 · ROAS 5.00 · CAC 4,000
    //   No campaign    1 lead · 1 paid · ₹2,000          Total spend 10,000 · revenue 33,000 · 4 paid orders
    expect: { vendors: 0, expenses: 2, bills: 0, txns: 0, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0,
              leads: 6, quotes: 5, invoices: 2, payments: 6, subscriptions: 1, campaigns: 2, adDays: 3, ...NO_PROJECTS },
    pages: [
      { path: "marketing-reports", for: "R-1980 ROAS & CAC → This month → Sales by campaign: Workspace Oct ₹6,000 / ₹11,000 / 1.83× / CAC ₹3,000 · Google Search ₹4,000 / ₹20,000 / 5.00× · Total ROAS 3.10× (campaigns only) · funnel Ad clicks 330 · 'Not from an ad campaign' also holds the E2E company's other orders (Epsilon adds ₹2,000 to it)" },
      { path: "online-orders", for: "R-1980 Ad source column: SCN Workspace Oct · Facebook / Instagram Ads on Alpha, Beta, Gamma; SCN Google Search · Google Ads on Delta and Zeta; a dash on Epsilon" },
    ],
  },
  {
    name: "project-receipts",
    about: "Reconcile → Project payment (R-1998): SCN Acme Website Co with project SCN Website (3 instalments of ₹1,18,000) and SCN Bharat Apps with SCN Mobile app (2 × ₹1,18,000); money-in lines ₹2,36,000 (Acme, kist 1 + 2), ₹2,12,400 (Bharat, both kists less ₹23,600 TDS) and ₹4,00,000 (Acme, ₹46,000 more than due).",
    cards: ["R-1998", "R-1995", "R-1996"],
    scope: {
      vendors: [],
      txns: [id(431), id(432), id(433)],
      // customers + projects; everything a Save makes from them is found from these (_common.sql scn_project_scope)
      docs: [id(401), id(402), id(411), id(412)],
      names: [],
      upis: [],
    },
    // --self-test: book the ₹2,12,400 line on both Bharat kists with ₹23,600 TDS (R-1996) — or, on a
    // local DB without R-1995/R-1996 yet, one older-style payment — so the reset is proven to take
    // away payments, split instalments, invoices and TDS rows, not just fresh rows.
    selfTestUse: `
      do $scn$ begin
        if to_regprocedure('public.allocate_project_receipt_with_tds(uuid,uuid,jsonb,jsonb,date,text)') is not null then
          perform public.allocate_project_receipt_with_tds('${id(432)}', '${id(412)}',
            '[{"milestone_id":"${id(424)}","amount":118000,"raise_invoice":true},{"milestone_id":"${id(425)}","amount":118000,"raise_invoice":true}]'::jsonb,
            '{"section":"194J","rate_pct":10,"amount":23600}'::jsonb, null, null);
        else
          perform public.record_project_payment('${id(424)}', 118000, 'bank_transfer', null, current_date, null);
          perform public.raise_project_milestone_invoice('${id(424)}');
        end if;
      end $scn$;
    `,
    expect: { vendors: 0, expenses: 0, bills: 0, txns: 3, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0, ...NO_SALES,
              customers: 2, projects: 2, milestones: 5, projectPayments: 0, projectInvoices: 0, tdsRows: 0 },
    pages: [
      { path: "banking", for: "R-1998 ₹2,36,000 Acme line → Reconcile → Project payment → SCN Website opens with kist 1 + 2 ticked → Save & reconcile · ₹2,12,400 Bharat line → tick TDS deducted?, TDS ₹23,600 → matches → Save · ₹4,00,000 Acme line → ₹46,000 more than due, no Save" },
      { path: "projects", for: "R-1998 SCN Website: kist 1 + 2 Paid, kist 3 ₹1,18,000 due · SCN Mobile app: both kists Paid (bank + TDS)" },
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
    case "marketing-reports": return `${base}/marketing/reports`;
    case "projects": return `${base}/projects`;
    case "online-orders": return `${base}/online-orders?q=SCN%20Ads`;
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
