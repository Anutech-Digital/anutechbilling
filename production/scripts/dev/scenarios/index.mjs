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
/** R-2458: the localhost-check counts (_common.sql scn_extra_count) — 0 for every older scenario. */
const NO_EXTRA = { xCustomers: 0, xQuotes: 0, xInvoices: 0, xPayments: 0, employees: 0, salaries: 0, loans: 0, loanPayments: 0,
                   luts: 0, companies: 0, connections: 0, networkDocs: 0, gstinClaims: 0,
                   memberships: 0 /* R-2476 */ };
/** R-2458 ids: c2458000-0000-4000-8000-0000000000NN. */
const x = (n) => `c2458000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A scenario that touches no vendor / sales / project rows. */
const NO_OLD = { vendors: 0, expenses: 0, bills: 0, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0, ...NO_SALES, ...NO_PROJECTS };

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
    expect: { vendors: 2, expenses: 2, bills: 1, txns: 6, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0, ...NO_SALES, ...NO_PROJECTS, ...NO_EXTRA },
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
    expect: { vendors: 1, expenses: 2, bills: 0, txns: 2, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0, ...NO_SALES, ...NO_PROJECTS, ...NO_EXTRA },
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
    expect: { vendors: 1, expenses: 1, bills: 1, txns: 3, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0, ...NO_SALES, ...NO_PROJECTS, ...NO_EXTRA },
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
              leads: 6, quotes: 5, invoices: 2, payments: 6, subscriptions: 1, campaigns: 2, adDays: 3, ...NO_PROJECTS, ...NO_EXTRA },
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
              customers: 2, projects: 2, milestones: 5, projectPayments: 0, projectInvoices: 0, tdsRows: 0, ...NO_EXTRA },
    pages: [
      { path: "banking", for: "R-1998 ₹2,36,000 Acme line → Reconcile → Project payment → SCN Website opens with kist 1 + 2 ticked → Save & reconcile · ₹2,12,400 Bharat line → tick TDS deducted?, TDS ₹23,600 → matches → Save · ₹4,00,000 Acme line → ₹46,000 more than due, no Save" },
      { path: "projects", for: "R-1998 SCN Website: kist 1 + 2 Paid, kist 3 ₹1,18,000 due · SCN Mobile app: both kists Paid (bank + TDS)" },
    ],
  },
  /* ── R-2458: the data the localhost checks of 4 Nov 2026 needed (one scenario per data need) ── */
  {
    name: "customer-no-state",
    about: "SCN Pathak Fabrication — State 'Not known yet' (saved as no state) — with draft quote Q-SCN-NS-1 (5 × Business Starter, ₹7,080).",
    cards: ["R-2363", "R-2442", "R-2448"],
    scope: { vendors: [], txns: [], docs: [], names: [], upis: [], extra: [x(1), "Q-SCN-NS-1"] },
    expect: { ...NO_OLD, txns: 0, ...NO_EXTRA, xCustomers: 1, xQuotes: 1 },
    pages: [
      { path: "customers", for: "R-2363 SCN Pathak Fabrication has the 'State missing' badge" },
      { path: "quote:Q-SCN-NS-1", for: "R-2442 / R-2448 Send, PDF, WhatsApp, customer link, Mark as sent wait for the state; set it (e.g. Delhi) → all work" },
    ],
  },
  {
    name: "usd-inw-lines",
    about: "Three USD inward remittances on SCN HDFC Current ··7788: $1,024 @ ₹93.60 = ₹95,846 (SCN Design Box LLC, new export sale); $2,000 @ ₹88.50 = ₹1,77,000 (SCN Timbergloss Inc) paying INV-SCN-USD-1 raised at $2,000 @ ₹84.00 (₹9,000 forex gain); $1,000 @ ₹93.60 = ₹93,600 (Design Box, short: billed $1,024). R-1678: ₹12,976 NEFT from SCN Peak Performance Hackers for INV-SCN-USD-2 ($139 @ ₹95.007 = ₹13,206 → ₹230 exchange loss); $1,500 @ ₹95 = ₹1,42,500 (Timbergloss) for INV-SCN-USD-3 ($1,000 @ ₹90) + INV-SCN-USD-4 ($500 @ ₹92) → ₹6,500 gain. LUTs: scenario lut-per-fy.",
    cards: ["R-2425", "R-2427", "R-2440", "R-2466", "R-1678"],
    /* R-2466: INV-SCN-USD-1 comes from its USD quote Q-SCN-USD-1 (as every export sale in the app). */
    scope: { vendors: [], txns: [x(21), x(22), x(23), x(24), x(25)], docs: [], names: [], upis: [],
      extra: [x(11), x(12), x(13), "Q-SCN-USD-1", "INV-SCN-USD-1", "Q-SCN-USD-2", "INV-SCN-USD-2", "Q-SCN-USD-3", "INV-SCN-USD-3", "Q-SCN-USD-4", "INV-SCN-USD-4"] },
    expect: { ...NO_OLD, txns: 5, ...NO_EXTRA, xCustomers: 3, xQuotes: 4, xInvoices: 4 },
    pages: [
      { path: "banking", for: "R-2425 'INW … USD1024.0@93.6' line shows $1,024 @ ₹93.60 · R-2427 / R-2466 the ₹1,77,000 line → Reconcile → SCN Timbergloss Inc → An open quote / invoice → INV-SCN-USD-1 ('₹9,000 forex gain') and the ₹93,600 line is the short one · R-1678 the ₹12,976 NEFT line → SCN Peak Performance Hackers → An open quote / invoice → INV-SCN-USD-2 (₹230 exchange loss) · the ₹1,42,500 line → SCN Timbergloss Inc → Several quotes / invoices → INV-SCN-USD-3 + INV-SCN-USD-4 (₹6,500 gain) · Reconcile from Zoho needs a Zoho connection (not local)" },
      { path: "invoices", for: "R-2427 INV-SCN-USD-1 in USD ($2,000 @ ₹84.00)" },
    ],
  },
  {
    name: "lut-per-fy",
    about: "E2E Test Co's LUT (export without IGST) for last FY and this FY — ARNs AD2703250024581 and AD2704260024582. Delete this FY's row in Settings → Company to see the 'No LUT for FY …' refusal.",
    cards: ["R-2444", "R-2440"],
    needs: { sql: "to_regclass('public.tenant_luts') is not null", what: "LUT table (migration R-2444)" },
    scope: { vendors: [], txns: [], docs: [], names: [], upis: [], extra: [x(31), x(32)] },
    expect: { ...NO_OLD, txns: 0, ...NO_EXTRA, luts: 2 },
    pages: [
      { path: "settings-company", for: "R-2444 'LUT for exports (one per financial year)' lists both FYs · R-2440 USD lines are zero-rated under this FY's LUT" },
    ],
  },
  {
    name: "zero-ref-credits",
    about: "SCN Zero Ref Traders: INV-SCN-ZR-1 ₹11,800 + two ₹5,000 money-in lines, both reference 000000000000000; INV-SCN-ZR-3 ₹2,360; SCN-ZB-0042 ₹11,800 last year's invoice imported from Zoho (opening, no quote). SCN Placeholder Labs: INV-SCN-ZR-2 ₹5,900.",
    cards: ["R-2430", "R-2424", "R-2441", "R-2466"],
    /* R-2466: ZR-1..3 come from their quotes; SCN-ZB-0042 through import_opening_invoices (found by its customer). */
    scope: { vendors: [], txns: [x(43), x(44)], docs: [], names: [], upis: [], extra: [x(41), x(42), "Q-SCN-ZR-1", "Q-SCN-ZR-2", "Q-SCN-ZR-3", "INV-SCN-ZR-1", "INV-SCN-ZR-2", "INV-SCN-ZR-3"] },
    expect: { ...NO_OLD, txns: 2, ...NO_EXTRA, xCustomers: 2, xQuotes: 3, xInvoices: 4 },
    pages: [
      { path: "banking", for: "R-2430 the two ₹5,000 SCN Zero Ref Traders lines → both on INV-SCN-ZR-1 → two receipts, ₹10,000 received · R-2466 'An open quote / invoice' also lists SCN-ZB-0042 'Opening invoice (from Zoho)' — both lines on it → two receipts" },
      { path: "invoices", for: "R-2424 / R-2441 Record payment with reference 000000000000000 (or NEFT-000000000000) on ZR-1 and ZR-2 — both save; a real UTR twice is refused" },
    ],
  },
  {
    name: "small-leftover",
    about: "Payment Follow-up: SCN Leftover Hosting INV-SCN-LO-1 ₹354 (nothing paid) + INV-SCN-LO-2 ₹5,900 with ₹5,845 received (₹55 left); SCN Late Payer Co INV-SCN-LO-3 ₹23,600 (40 days late); SCN Slow Pay Studio INV-SCN-LO-4 ₹11,800 (20 days late).",
    cards: ["R-2421", "R-2413"],
    scope: { vendors: [], txns: [], docs: [], names: [], upis: [], extra: [x(51), x(52), x(53), "INV-SCN-LO-1", "INV-SCN-LO-2", "INV-SCN-LO-3", "INV-SCN-LO-4"] },
    expect: { ...NO_OLD, txns: 0, ...NO_EXTRA, xCustomers: 3, xQuotes: 1, xInvoices: 4, xPayments: 1 },
    pages: [
      { path: "collections", for: "R-2421 ₹354 bill in the main list, ₹55 leftover in 'Small leftovers' (Write off) · R-2413 tick the three SCN customers → Assign owner / Send reminder" },
    ],
  },
  {
    name: "salary-part-paid",
    about: "SCN Ravi Kumar: last month's ₹30,000 salary (made with pay_salary) with a ₹25,000 bank line linked → Partially paid. SCN Sunita Rao: '… FULL N FINAL SALARY-SCN SUNITA RAO' ₹52,000 line (last month) + a salary line this month.",
    cards: ["R-2428"],
    scope: { vendors: [], txns: [x(63), x(64), x(65)], docs: [], names: [], upis: [], extra: [x(61), x(62)] },
    expect: { ...NO_OLD, txns: 3, ...NO_EXTRA, employees: 2, salaries: 1 },
    pages: [
      { path: "banking", for: "R-2428 the FULL N FINAL line → Reconcile → Full & final settlement ticked → Book as salary → Start exit; then this month's Sunita line says she left" },
      { path: "payroll", for: "R-2428 SCN Ravi Kumar Partially paid → ⋯ → Edit salary — set LOP (net = ₹25,000)" },
    ],
  },
  {
    name: "employee-owed-back",
    about: "SCN Neelam Sharma: last month's ₹30,000 salary (made with pay_salary, unpaid), a ₹16,000 money-in line 'UPI/…/SCN NEELAM SHARMA/PAID BY MISTAKE' (no advance held) and a ₹46,000 'NEFT DR-…-SALARY-SCN NEELAM SHARMA' line (salary + the ₹16,000 back).",
    cards: ["R-2407"],
    scope: { vendors: [], txns: [x(103), x(104)], docs: [], names: [], upis: [], extra: [x(101)] },
    expect: { ...NO_OLD, txns: 2, ...NO_EXTRA, employees: 1, salaries: 1 },
    pages: [
      { path: "banking", for: "R-2407 the ₹16,000 SCN Neelam line → Reconcile → Employee return → every employee listed → 'Paid to us by mistake — we owe it back' → Book; then the ₹46,000 line → Employee / salary → 'Also pays back ₹16,000 owed to SCN Neelam Sharma' → Pay salary + ₹16,000 owed back" },
      { path: "payroll", for: "R-2407 SCN Neelam Sharma's salary Paid (₹30,000) — no extra salary" },
    ],
  },
  {
    name: "nbfc-interest",
    about: "Business Loans: SCN Bajaj Finance Ltd (NBFC) ₹13,000 interest this FY (2 EMIs × ₹6,500) and SCN HDFC Bank ₹8,000; a ₹15,000 'ACH DR-SCN BAJAJ FINANCE LTD-EMI' money-out line.",
    cards: ["R-2376"],
    scope: { vendors: [], txns: [x(76)], docs: [], names: [], upis: [], extra: [x(71), x(72)] },
    expect: { ...NO_OLD, txns: 1, ...NO_EXTRA, loans: 2, loanPayments: 3 },
    pages: [
      { path: "business-loans", for: "R-2376 'TDS on loan interest' box: SCN Bajaj Finance → Not a bank → TDS 10% due ₹1,300; nothing for SCN HDFC Bank" },
      { path: "banking", for: "R-2376 the ₹15,000 Bajaj line → Reconcile → Loan / EMI → 'Keep ₹… back'" },
    ],
  },
  {
    name: "approved-quote",
    about: "SCN Approved Buyer: Q-SCN-AP-1 (sent) approved by the E2E manager — 10 × ₹1,080 (10% off ₹1,200) against ₹1,000 cost; Q-SCN-AP-2 (accepted, approved) + Q-SCN-AP-3 (accepted, no approval needed) for Combine. Made by the E2E sales user.",
    cards: ["R-2447", "R-2441"],
    scope: { vendors: [], txns: [], docs: [], names: [], upis: [], extra: [x(91), "Q-SCN-AP-1", "Q-SCN-AP-2", "Q-SCN-AP-3"] },
    expect: { ...NO_OLD, txns: 0, ...NO_EXTRA, xCustomers: 1, xQuotes: 3 },
    pages: [
      { path: "quote:Q-SCN-AP-1", for: "R-2447 as Sales: rate below ₹1,000 (or > 20% off) → Needs approval (Owner); a higher rate stays Approved · R-2441 approve as owner with a reason" },
      { path: "quotes", for: "R-2447 Combine Q-SCN-AP-2 + Q-SCN-AP-3 → the new quote shows Approved" },
    ],
  },
  {
    name: "connected-companies",
    about: "A second local company, SCN Network Partner Pvt Ltd (Delhi, GSTIN 07AAECS2458K1Z4), connected to E2E Test Co (accepted; both GSTINs registered + ownership proved; partner shares invoices + partner metrics, E2E shares invoices + payments) with two of its invoices Pending in E2E's Purchase Inbox: SNP/26-27/0101 ₹11,800 and SNP/26-27/0102 ₹5,900. No login for the second company yet.",
    cards: ["R-2433", "R-2445", "R-2449", "R-2434", "R-2450", "R-2432"],
    needs: { sql: "to_regclass('public.network_documents') is not null and to_regclass('public.gstin_ownership_claims') is not null", what: "network tables (migrations R-2433 / R-2445 / R-2434)" },
    scope: { vendors: [], txns: [], docs: [], names: ["scn network partner pvt ltd"], upis: [], extra: [x(81), x(82)] },
    expect: { ...NO_OLD, txns: 0, ...NO_EXTRA, companies: 1, connections: 1, networkDocs: 2 },
    // --self-test: accept one (a vendor + bill VB-NET-… appear in E2E Test Co) and reject the other — the reset must take both away
    selfTestUse: `
      select * from public.network_accept_document('${x(83)}', null);
      select * from public.network_reject_document('${x(84)}', 'SCN self-test: wrong rate');
    `,
    pages: [
      { path: "settings-network", for: "R-2433 / R-2445 'Connected businesses' shows SCN Network Partner Pvt Ltd; Your GSTIN 'Ownership proved'" },
      { path: "purchase-inbox", for: "R-2449 From network → two Pending invoices → Accept SNP/26-27/0101 (bill VB-NET-…), Reject SNP/26-27/0102 with a reason" },
    ],
  },
  {
    name: "two-companies",
    about: "One login in two companies (R-2471 memberships): a second local company, SCN Second Company Pvt Ltd (no customers, quotes or invoices), and an active membership in it as Manager for e2e-owner@example.test (the login 'Local test login → Owner' uses). That login sees the company switcher in the top bar: E2E Test Co (Owner, ticked) and SCN Second Company Pvt Ltd (Manager). --reset / --clear first moves that login back to E2E Test Co if it was left in the second company.",
    cards: ["R-2476"],
    needs: { sql: "to_regprocedure('public.my_companies()') is not null", what: "company switcher (migration R-2476)" },
    scope: { vendors: [], txns: [], docs: [], names: [], upis: [], extra: ["c2476000-0000-4000-8000-000000000001"] },
    expect: { ...NO_OLD, txns: 0, ...NO_EXTRA, companies: 1, memberships: 1 },
    // --self-test: the owner switches into the second company — the reset must bring the login back, not delete it
    selfTestUse: `
      select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub',
        (select u.id from public.users u where lower(u.email) = 'e2e-owner@example.test'))::text, true);
      select public.switch_company('c2476000-0000-4000-8000-000000000001');
    `,
    pages: [
      { path: "dashboard", for: "R-2476 top bar: the company button (E2E Test Co) → Switch company lists both companies with their roles" },
      { path: "customers-all", for: "R-2476 after switching to SCN Second Company Pvt Ltd: the list is empty (no E2E Test Co customer stays)" },
    ],
  },
  {
    name: "renewal-proforma",
    about: "SCN Bit Labs — monthly Google Workspace Business Starter, 17 seats × ₹300; its current month was billed the old way as Q-SCN-PF-1 (1 × ₹5,100 'One-time' + IGST = ₹6,018, Sent, nothing emailed) — staging BITDECENTRO Q-A378-27-0947 in miniature. Cancel it, then Renewals → Bill next part at 18 seats.",
    cards: ["R-2519"],
    needs: { sql: "to_regprocedure('public.cancel_quote(text,text)') is not null", what: "proforma + cancel (migration R-2519)" },
    scope: { vendors: [], txns: [], docs: [], names: [], upis: [], extra: [x(201), "Q-SCN-PF-1"] },
    expect: { ...NO_OLD, txns: 0, ...NO_EXTRA, xCustomers: 1, xQuotes: 1 },
    pages: [
      { path: "quote:Q-SCN-PF-1", for: "R-2519 More → Cancel quote (reason) → 'Cancelled', kept; More → Undo cancel brings it back; cancel again" },
      { path: "renewals", for: "R-2519 SCN Bit Labs → ⋯ → Bill next part… → preview 17 × ₹300 → Seats 18, Periods 2 → Create 2 proformas (PI-…)" },
    ],
  },
  {
    name: "money-owed-archived",
    about: "R-1473 Pawan's staging case: SCN Kochi Hosting owes ₹25,488 on its subscription; SCN Delhi Traders (ARCHIVED) owes ₹19,258 on its subscription + ₹23,109 on project invoice INV-SCN-MO-1. Dashboard 'to collect', Companies › Has receivables and its line all say ₹67,855 (subscriptions ₹44,746 + project ₹23,109); Renewals says ₹44,746 on these renewals + the project money.",
    cards: ["R-1473"],
    // customers + project, like project-receipts: their subscriptions and invoices go with them (_common.sql scn_project_clear)
    scope: { vendors: [], txns: [], docs: [x(301), x(302), x(321)], names: [], upis: [] },
    expect: { vendors: 0, expenses: 0, bills: 0, txns: 0, prepaid: 0, paymentLines: 0, aliases: 0, duplicateBillNos: 0, ...NO_SALES,
              customers: 2, projects: 1, milestones: 2, projectPayments: 0, projectInvoices: 1, tdsRows: 0, ...NO_EXTRA },
    pages: [
      { path: "dashboard", for: "R-1473 Collections card: ₹67,855 to collect (Subscription dues ₹44.7K + project invoices ₹23.1K)" },
      { path: "customers?view=unpaid", for: "R-1473 Has receivables lists SCN Kochi Hosting ₹25,488 and SCN Delhi Traders ₹42,367 (Archived badge); line over the list: … = ₹67,855 to collect · includes 1 archived company" },
      { path: "renewals", for: "R-1473 under the title: ₹44,746 unpaid on these renewals · Companies › Has receivables ₹67,855 also has project invoices ₹23,109" },
    ],
  },
  {
    name: "renewal-parts",
    about: "R-2548 card test's own customers, no subscriptions (the test adds them through Subscriptions → Add Subscription): SCN Part Bill Studio (Annual · Half-yearly, renews in 30 days), SCN Part Bill Late Co (Half-yearly, renews in 3 days), SCN Part Bill Yearly (paid Yearly). A reload or --clear also removes the subscriptions added on them.",
    cards: ["R-2548", "R-2569"],
    scope: { vendors: [], txns: [], docs: [], names: [], upis: [],
             extra: ["c2569000-0000-4000-8000-000000000001", "c2569000-0000-4000-8000-000000000002", "c2569000-0000-4000-8000-000000000003"] },
    expect: { ...NO_OLD, txns: 0, ...NO_EXTRA, xCustomers: 3 },
    pages: [
      { path: "customers", for: "R-2548 the three SCN Part Bill customers — Subscriptions → Add Subscription → Existing Customer picks them" },
      { path: "renewals", for: "R-2548 after adding SCN Part Bill Studio's Annual · Half-yearly subscription: 'Bill renewal · part 1 of next year'" },
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
    /* R-2458 */
    case "customers": return `${base}/customers?q=SCN`;
    case "quotes": return `${base}/quotes?q=SCN`;
    case "invoices": return `${base}/invoices?q=SCN`;
    case "collections": return `${base}/collections`;
    case "payroll": return `${base}/accounting/payroll`;
    case "settings-company": return `${base}/settings?tab=company`;
    case "settings-network": return `${base}/settings?tab=network`;
    case "purchase-inbox": return `${base}/purchases/inbox`;
    /* R-2476 */
    case "dashboard": return `${base}/dashboard`;
    case "customers-all": return `${base}/customers`;
    /* R-2519 */
    case "renewals": return `${base}/renewals?q=SCN`;
    default:
      if (key.startsWith("quote:")) return `${base}/quotes/${encodeURIComponent(key.slice(6))}`;
      return `${base}/accounting/${key}`;
  }
}

/** The SQL literal of a string array — values are fixed ids / names from this file, checked anyway. */
export function sqlTextArray(values) {
  for (const v of values) {
    if (!/^[A-Za-z0-9 ._@-]+$/.test(v)) throw new Error(`unsafe scenario value: ${v}`);
  }
  return `array[${values.map((v) => `'${v}'`).join(", ")}]::text[]`;
}
