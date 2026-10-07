/**
 * Demo data for testing (R-201, 6 Oct 2026; every module R-361, 7 Oct 2026).
 *
 * Pardeep: staging looked "wiped" because it is an empty copy by design (no customer data
 * leaves live), and the tester asked for a "Generate Dummy Data" button. R-201 made 6
 * customers + 10 deals. R-361 (tester, 6 Oct: "one click → realistic data in every module")
 * adds the rest of the money spine and the daily pages, so Today, Renewals, Dunning, Quotes,
 * Invoices, Payments, Tasks, Catalogue, Vendors, Bills and Expenses all have something to show:
 *
 *   catalogue items · vendors · customers · deals (every stage) · quotes (every status)
 *   · subscriptions (renewing in 5 / 25 days, one past its date, two far out)
 *   · invoices (paid, overdue 15 and 40 days, not yet due) · payments (full + part)
 *   · tasks (overdue, today, upcoming, done) · vendor bills (paid / unpaid) · expenses
 *
 * EVERY row carries "DEMO · " in one named column (DEMO_TAG_COLUMN), and ids the app mints
 * itself start with "DEMO-", so the clear action finds exactly these rows and nothing else.
 *
 * NOTHING HERE CAN REACH A REAL PERSON. Every email is on `example.invalid` (RFC 2606 — a
 * name that can never resolve, and sendEmail refuses it before the provider:
 * lib/email/reserved-address.ts), and no phone number is set anywhere, so WhatsApp
 * reminders and call loops have nobody to reach.
 *
 * Money in whole rupees (CLAUDE.md §13), GST 18% on SaaS (SAC 998313), the CGST/SGST vs
 * IGST split decided by the workspace's own state. Pure: the route inserts what this returns.
 */
export const DEMO_PREFIX = "DEMO · ";
/** Ids the app mints itself (quotes, invoices, items, bills, expenses) start with this. */
export const DEMO_ID_PREFIX = "DEMO-";
/** RFC 2606 reserved TLD — mail to it can never be delivered. */
export const DEMO_EMAIL_DOMAIN = "example.invalid";

/** Only where test data belongs. Production builds have NEXT_PUBLIC_APP_ENV "" — refused. */
export function demoDataAllowed(appEnv: string | undefined): boolean {
  return appEnv === "staging" || appEnv === "local";
}

const GST_RATE = 18;
const SAC = "998313";

// ── Row shapes (the columns this file writes; everything else takes its default) ──────

export interface DemoItem {
  id: string; name: string; vendor: "google" | "microsoft" | "zoho"; hsn: string;
  msrp: number; wholesale: number; item_type: "subscription"; kind: "main"; is_active: boolean;
}
export interface DemoVendor {
  id: string; name: string; contact_name: string; contact_email: string; contact_phone: null;
  gstin: string | null; state: string | null; city: string; default_category: string;
}
export interface DemoCustomer {
  id: string; name: string; contact_name: string; contact_email: string; contact_phone: null;
  city: string; state: string | null; state_code: string | null; gstin: string | null; country: string;
}
export interface DemoLead {
  id: string; company: string; contact_name: string; contact_email: string; contact_phone: null;
  stage: "new" | "contact" | "demo" | "trial" | "quote" | "won" | "lost";
  plan: string | null; seats: number | null; value: number | null;
  priority: "low" | "medium" | "high"; source: string; enquiry_type: "subscription" | "project";
  expected_close_date: string | null;
}
export interface DemoQuoteLine {
  id: string; item_id: string; name: string; qty: number; rate: number; list_rate: number;
  cost: number; commitment: "annual_yearly"; hsn: string;
}
export interface DemoQuote {
  id: string; customer_id: string; customer_name: string; lead_id: string | null;
  plan: string; seats: number; line_items: DemoQuoteLine[]; subtotal: number; total_cost: number;
  discount_pct: number; tax_rate: number; amount: number; billing_cycle: "yearly";
  status: "draft" | "sent" | "viewed" | "accepted" | "rejected" | "expired";
  payment_status: "none" | "awaiting" | "partial" | "received" | "invoiced";
  created_date: string; expires_date: string; notes: string;
}
export interface DemoSubscription {
  id: string; customer_id: string; customer_name: string; quote_id: string | null;
  plan: string; vendor: "google" | "microsoft" | "zoho"; seats: number; used: number; mrr: number;
  start_date: string; renewal_date: string; billing_cycle: "yearly"; term_months: number;
  status: "active"; auto_renew: boolean; outstanding_amount: number;
}
export interface DemoInvoice {
  id: string; customer_id: string; customer_name: string; quote_id: string | null;
  amount: number; taxable_value: number; tax_amount: number; tax_rate: number; inter_state: boolean;
  status: "pending" | "paid" | "overdue"; invoice_date: string; due_date: string;
  paid_date: string | null; paid_amount: number; overdue_days: number; line_items: DemoQuoteLine[];
}
export interface DemoPayment {
  id: string; quote_id: string; customer_id: string; amount: number;
  method: "bank_transfer" | "upi"; status: "received"; received_at: string; reference: string; notes: string;
}
export interface DemoTask {
  id: string; title: string; kind: "call" | "email" | "meeting" | "followup";
  due_at: string; status: "pending" | "done"; completed_at: string | null;
  customer_id: string | null; lead_id: string | null; notes: string;
}
export interface DemoVendorBill {
  id: string; vendor_id: string; vendor_name: string; vendor_gstin: string | null; bill_no: string;
  bill_date: string; due_date: string; category: string; subtotal: number;
  cgst: number; sgst: number; igst: number; total: number; status: "paid" | "unpaid"; paid_amount: number; notes: string;
}
export interface DemoExpense {
  id: string; vendor_id: string | null; vendor_name: string; category: string; description: string;
  expense_date: string; amount: number; gst_paid: number; cgst: number; sgst: number; igst: number;
  bill_type: "gst" | "none"; paid: boolean; paid_date: string | null; payment_method: string | null;
}

export interface DemoBundle {
  items: DemoItem[]; vendors: DemoVendor[]; customers: DemoCustomer[]; leads: DemoLead[];
  quotes: DemoQuote[]; subscriptions: DemoSubscription[]; invoices: DemoInvoice[];
  payments: DemoPayment[]; tasks: DemoTask[]; vendor_bills: DemoVendorBill[]; expenses: DemoExpense[];
}
export type DemoTable = keyof DemoBundle | "contacts";

/**
 * The column on each table that starts with DEMO_PREFIX — what the clear action matches on.
 * `contacts` is never written here: the leads trigger (trg_leads_autolink_contact) makes one
 * per demo deal with the deal's company, so it carries the tag too.
 */
export const DEMO_TAG_COLUMN: Record<DemoTable, string> = {
  items: "name", vendors: "name", customers: "name", leads: "company", quotes: "customer_name",
  subscriptions: "customer_name", invoices: "customer_name", payments: "notes", tasks: "title",
  vendor_bills: "vendor_name", expenses: "vendor_name", contacts: "company",
};

/** Parents before children — every foreign key points at a row already written. */
export const DEMO_INSERT_ORDER: (keyof DemoBundle)[] = [
  "items", "vendors", "customers", "leads", "quotes", "subscriptions",
  "payments", "invoices", "tasks", "vendor_bills", "expenses",
];

/**
 * Children before parents. customers.id is ON DELETE RESTRICT from quotes, subscriptions
 * and invoices, so those go first.
 *  - `invoices`: the demo_data_clear_invoices RPC (no DELETE policy, and an issued invoice
 *    is guarded by trg_invoices_block_delete_issued — the RPC is limited to DEMO-INV- rows).
 *  - `payments`: no DELETE policy either; they go with their demo quote
 *    (payments.quote_id ON DELETE CASCADE). Listed so the plan names every table written.
 *  - everything else: through the person's own login (RLS).
 */
export const DEMO_CLEAR_ORDER: DemoTable[] = [
  "invoices", "tasks", "quotes", "payments", "subscriptions", "leads", "contacts",
  "customers", "vendor_bills", "expenses", "vendors", "items",
];
/** Cleared by something other than a direct DELETE through the person's login. */
export const DEMO_CLEARED_INDIRECTLY: Partial<Record<DemoTable, "rpc" | "cascade">> = {
  invoices: "rpc", payments: "cascade",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addYears(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}
/** A wall-clock time in India on an IST date, as an ISO instant. */
function istAt(iso: string, hhmm: string): string {
  return new Date(`${iso}T${hhmm}:00+05:30`).toISOString();
}
function demoEmail(local: string): string {
  return `${local}@${DEMO_EMAIL_DOMAIN}`;
}
/** 18% on a whole-rupee taxable value: tax rounded once, total = taxable + tax. */
export function gstOn(taxable: number): { tax: number; total: number } {
  const tax = Math.round((taxable * GST_RATE) / 100);
  return { tax, total: taxable + tax };
}
/** Intra-state → CGST + SGST (halves, the odd rupee on SGST); otherwise IGST. */
function splitGst(tax: number, interState: boolean): { cgst: number; sgst: number; igst: number } {
  if (interState) return { cgst: 0, sgst: 0, igst: tax };
  const cgst = Math.floor(tax / 2);
  return { cgst, sgst: tax - cgst, igst: 0 };
}

// ── Fixed content ──────────────────────────────────────────────────────────────

/** Per seat per MONTH, like the seed catalogue (GW Starter 136 / 110). */
const ITEMS = [
  { code: "GWS-STARTER",  name: "Google Workspace Business Starter",  vendor: "google",    msrp: 136, wholesale: 110 },
  { code: "GWS-STANDARD", name: "Google Workspace Business Standard", vendor: "google",    msrp: 736, wholesale: 620 },
  { code: "M365-BASIC",   name: "Microsoft 365 Business Basic",       vendor: "microsoft", msrp: 145, wholesale: 125 },
  { code: "ZOHO-STD",     name: "Zoho Workplace Standard",            vendor: "zoho",      msrp: 120, wholesale: 95 },
] as const;
type ItemCode = (typeof ITEMS)[number]["code"];

const CUSTOMERS: Omit<DemoCustomer, "id" | "name">[] = [
  { contact_name: "Rohit Mehra", contact_email: demoEmail("rohit.delhi"),   contact_phone: null, city: "New Delhi", state: "Delhi",       state_code: "07", gstin: "07AABCD1234E1Z5", country: "India" },
  { contact_name: "Sneha Patil", contact_email: demoEmail("sneha.pune"),    contact_phone: null, city: "Pune",      state: "Maharashtra", state_code: "27", gstin: "27AABCP4321F1Z2", country: "India" },
  { contact_name: "Arjun Reddy", contact_email: demoEmail("arjun.blr"),     contact_phone: null, city: "Bengaluru", state: "Karnataka",   state_code: "29", gstin: null,              country: "India" },
  { contact_name: "Priya Nair",  contact_email: demoEmail("priya.kochi"),   contact_phone: null, city: "Kochi",     state: "Kerala",      state_code: "32", gstin: null,              country: "India" },
  { contact_name: "Vikas Gupta", contact_email: demoEmail("vikas.nostate"), contact_phone: null, city: "",          state: null,          state_code: null, gstin: null,              country: "India" },
  { contact_name: "Emma Clarke", contact_email: demoEmail("emma.uk"),       contact_phone: null, city: "London",    state: null,          state_code: null, gstin: null,              country: "United Kingdom" },
];
const CUSTOMER_NAMES = ["Delhi Traders Pvt Ltd", "Pune Software LLP", "Bengaluru Retail Co", "Kochi Exports", "No-State Enterprises", "London Consulting Ltd"];

const STAGES: DemoLead["stage"][] = ["new", "new", "contact", "demo", "trial", "quote", "quote", "won", "won", "lost"];
const PLANS = ["Google Workspace Business Starter", "Google Workspace Business Standard", "Microsoft 365 Business Basic", "Zoho Workplace Standard"];

export interface DemoOptions {
  /** IST date (YYYY-MM-DD) everything is placed around. */
  today: string;
  /** Makes ids unique per run (Date.now()). */
  stamp: number;
  /** The workspace's own GST state code — decides CGST+SGST vs IGST. Null → IGST. */
  tenantStateCode: string | null;
  /** UUID maker for uuid-keyed tables (crypto.randomUUID in the route; a counter in tests). */
  newId: () => string;
}

export function demoRows(o: DemoOptions): DemoBundle {
  const { today, stamp, tenantStateCode, newId } = o;
  const tag = stamp.toString(36).toUpperCase();
  const did = (kind: string, n: number) => `${DEMO_ID_PREFIX}${kind}-${tag}-${n}`;

  // Catalogue
  const items: DemoItem[] = ITEMS.map((it) => ({
    id: `${DEMO_ID_PREFIX}${it.code}-${tag}`, name: `${DEMO_PREFIX}${it.name}`, vendor: it.vendor,
    hsn: SAC, msrp: it.msrp, wholesale: it.wholesale, item_type: "subscription", kind: "main", is_active: true,
  }));
  const item = (code: ItemCode) => {
    const i = ITEMS.findIndex((x) => x.code === code);
    return { row: items[i], spec: ITEMS[i] };
  };

  // Vendors
  const vendors: DemoVendor[] = [
    { id: newId(), name: `${DEMO_PREFIX}Cloud Distributor India Pvt Ltd`, contact_name: "Accounts Desk", contact_email: demoEmail("billing.distributor"), contact_phone: null, gstin: "29AAACD9876K1Z3", state: "Karnataka", city: "Bengaluru", default_category: "COGS-Workspace" },
    { id: newId(), name: `${DEMO_PREFIX}Office Space Landlord`, contact_name: "Mr. Kapoor", contact_email: demoEmail("landlord"), contact_phone: null, gstin: null, state: "Delhi", city: "New Delhi", default_category: "Office Rent" },
  ];

  // Customers
  const customers: DemoCustomer[] = CUSTOMERS.map((c, i) => ({ ...c, id: newId(), name: `${DEMO_PREFIX}${CUSTOMER_NAMES[i]}` }));
  const cust = (i: number) => customers[i];
  const interStateFor = (c: DemoCustomer) =>
    !tenantStateCode || !c.state_code || c.country !== "India" ? true : c.state_code !== tenantStateCode;

  // Deals — one in every stage (as R-201, minus the phone numbers)
  const leads: DemoLead[] = STAGES.map((stage, i) => {
    const seats = [5, 12, 25, 8, 50, 15, 3, 20, 10, 6][i];
    const isProject = i === 6;
    const plan = isProject ? null : PLANS[i % PLANS.length];
    const value = stage === "new" ? null : isProject ? 250000 : seats * 1500 * 12;
    return {
      id: `L-DEMO-${tag}-${i + 1}`,
      company: `${DEMO_PREFIX}Prospect ${i + 1} (${stage})`,
      contact_name: `Demo Contact ${i + 1}`,
      contact_email: demoEmail(`prospect${i + 1}`),
      contact_phone: null,
      stage, plan, seats: isProject ? null : seats, value,
      priority: (["high", "medium", "low"] as const)[i % 3],
      source: "Demo data",
      enquiry_type: isProject ? "project" : "subscription",
      expected_close_date: stage === "new" || stage === "contact" ? null : addDays(today, 7 + i * 3),
    };
  });

  // Quotes — one per status. Annual lines: rate = ₹ per seat per YEAR (msrp × 12).
  const line = (code: ItemCode, qty: number, n: number): DemoQuoteLine => {
    const { row, spec } = item(code);
    return {
      id: `line-${tag}-${n}`, item_id: row.id, name: spec.name, qty,
      rate: spec.msrp * 12, list_rate: spec.msrp * 12, cost: spec.wholesale * 12,
      commitment: "annual_yearly", hsn: SAC,
    };
  };
  const quoteSpecs: {
    c: number; code: ItemCode; seats: number; status: DemoQuote["status"];
    pay: DemoQuote["payment_status"]; age: number; lead: number | null;
  }[] = [
    { c: 1, code: "GWS-STANDARD", seats: 25, status: "accepted", pay: "received", age: 25, lead: 7 }, // paid in full
    { c: 2, code: "GWS-STARTER",  seats: 30, status: "accepted", pay: "partial",  age: 6,  lead: 8 }, // half paid
    { c: 0, code: "GWS-STARTER",  seats: 12, status: "sent",     pay: "none",     age: 3,  lead: 5 },
    { c: 3, code: "ZOHO-STD",     seats: 15, status: "viewed",   pay: "none",     age: 2,  lead: 6 },
    { c: 4, code: "M365-BASIC",   seats: 8,  status: "draft",    pay: "none",     age: 0,  lead: null },
    { c: 5, code: "M365-BASIC",   seats: 10, status: "rejected", pay: "none",     age: 20, lead: 9 },
    { c: 0, code: "GWS-STANDARD", seats: 5,  status: "expired",  pay: "none",     age: 40, lead: null },
  ];
  const quotes: DemoQuote[] = quoteSpecs.map((q, i) => {
    const l = line(q.code, q.seats, i + 1);
    const subtotal = l.qty * l.rate;
    const created = addDays(today, -q.age);
    return {
      id: did("Q", i + 1), customer_id: cust(q.c).id, customer_name: cust(q.c).name,
      lead_id: q.lead === null ? null : leads[q.lead].id,
      plan: l.name, seats: q.seats, line_items: [l], subtotal, total_cost: l.qty * l.cost,
      discount_pct: 0, tax_rate: GST_RATE, amount: gstOn(subtotal).total, billing_cycle: "yearly",
      status: q.status, payment_status: q.pay, created_date: created, expires_date: addDays(created, 30),
      notes: `${DEMO_PREFIX}test quotation — not a real offer.`,
    };
  });

  // Subscriptions — renewals due in 5 and 25 days, one 3 days past its date, two far out.
  const subSpecs: { c: number; code: ItemCode; seats: number; renewIn: number; quote: number | null }[] = [
    { c: 0, code: "GWS-STARTER",  seats: 10, renewIn: 5,   quote: null },
    { c: 1, code: "GWS-STANDARD", seats: 25, renewIn: 25,  quote: 0 },
    { c: 2, code: "GWS-STARTER",  seats: 30, renewIn: 120, quote: 1 },
    { c: 3, code: "ZOHO-STD",     seats: 15, renewIn: -3,  quote: null },
    { c: 5, code: "M365-BASIC",   seats: 12, renewIn: 200, quote: null },
  ];
  const subscriptions: DemoSubscription[] = subSpecs.map((s) => {
    const { spec } = item(s.code);
    const renewal = addDays(today, s.renewIn);
    return {
      id: newId(), customer_id: cust(s.c).id, customer_name: cust(s.c).name,
      quote_id: s.quote === null ? null : quotes[s.quote].id,
      plan: spec.name, vendor: spec.vendor, seats: s.seats, used: Math.max(1, s.seats - 2),
      mrr: s.seats * spec.msrp, start_date: addYears(renewal, -1), renewal_date: renewal,
      billing_cycle: "yearly", term_months: 12, status: "active", auto_renew: true, outstanding_amount: 0,
    };
  });

  // Invoices — paid, overdue 15 / 40 days, not yet due. Never a GST series number: the ids
  // are DEMO-INV-…, so the real Rule 46 series is not touched.
  const invSpecs: {
    c: number; code: ItemCode; seats: number; issuedAgo: number; dueIn: number;
    status: DemoInvoice["status"]; quote: number | null;
  }[] = [
    { c: 1, code: "GWS-STANDARD", seats: 25, issuedAgo: 20, dueIn: -5,  status: "paid",    quote: 0 },
    { c: 0, code: "GWS-STARTER",  seats: 10, issuedAgo: 45, dueIn: -15, status: "overdue", quote: null },
    { c: 3, code: "ZOHO-STD",     seats: 15, issuedAgo: 70, dueIn: -40, status: "overdue", quote: null },
    { c: 2, code: "GWS-STARTER",  seats: 6,  issuedAgo: 3,  dueIn: 12,  status: "pending", quote: null },
  ];
  const invoices: DemoInvoice[] = invSpecs.map((v, i) => {
    const c = cust(v.c);
    const l = line(v.code, v.seats, 100 + i);
    const taxable = l.qty * l.rate;
    const { tax, total } = gstOn(taxable);
    const paid = v.status === "paid";
    return {
      id: did("INV", i + 1), customer_id: c.id, customer_name: c.name,
      quote_id: v.quote === null ? null : quotes[v.quote].id,
      amount: total, taxable_value: taxable, tax_amount: tax, tax_rate: GST_RATE, inter_state: interStateFor(c),
      status: v.status, invoice_date: addDays(today, -v.issuedAgo), due_date: addDays(today, v.dueIn),
      paid_date: paid ? addDays(today, -10) : null, paid_amount: paid ? total : 0,
      overdue_days: v.status === "overdue" ? -v.dueIn : 0, line_items: [l],
    };
  });
  // A customer with an overdue invoice owes it on the subscription too, so the pages agree.
  for (const s of subscriptions) {
    const owed = invoices.find((v) => v.customer_id === s.customer_id && v.status === "overdue");
    if (owed) s.outstanding_amount = owed.amount;
  }

  // Payments — the paid quote in full by bank transfer, the part-paid one half by UPI.
  const payments: DemoPayment[] = [
    { id: newId(), quote_id: quotes[0].id, customer_id: quotes[0].customer_id, amount: quotes[0].amount,
      method: "bank_transfer", status: "received", received_at: istAt(addDays(today, -10), "12:30"),
      reference: `DEMO-UTR-${tag}-1`, notes: `${DEMO_PREFIX}test payment — no money moved.` },
    { id: newId(), quote_id: quotes[1].id, customer_id: quotes[1].customer_id, amount: Math.round(quotes[1].amount / 2),
      method: "upi", status: "received", received_at: istAt(addDays(today, -2), "16:05"),
      reference: `DEMO-UPI-${tag}-2`, notes: `${DEMO_PREFIX}test part payment — no money moved.` },
  ];

  // Tasks — one link each (tasks_one_link_only): overdue, two today, upcoming, one done.
  const taskSpecs: { title: string; kind: DemoTask["kind"]; day: number; at: string; c: number | null; l: number | null; done: boolean }[] = [
    { title: "Call about the overdue invoice",  kind: "call",     day: -1, at: "11:00", c: 0,    l: null, done: false },
    { title: "Send renewal quote",              kind: "email",    day: 0,  at: "11:30", c: 0,    l: null, done: false },
    { title: "Product demo",                    kind: "meeting",  day: 0,  at: "16:00", c: null, l: 3,    done: false },
    { title: "Follow up on the sent quote",     kind: "followup", day: 1,  at: "10:00", c: null, l: 5,    done: false },
    { title: "Check seat usage before renewal", kind: "call",     day: 3,  at: "15:00", c: 1,    l: null, done: false },
    { title: "Collect GST certificate",         kind: "email",    day: -2, at: "12:00", c: 2,    l: null, done: true },
  ];
  const tasks: DemoTask[] = taskSpecs.map((t) => ({
    id: newId(), title: `${DEMO_PREFIX}${t.title}`, kind: t.kind,
    due_at: istAt(addDays(today, t.day), t.at),
    status: t.done ? "done" : "pending", completed_at: t.done ? istAt(addDays(today, t.day), "13:00") : null,
    customer_id: t.c === null ? null : cust(t.c).id, lead_id: t.l === null ? null : leads[t.l].id,
    notes: "Demo task — safe to tick or delete.",
  }));

  // Vendor bills — the distributor's Workspace cost (inter-state unless the workspace is in
  // Karnataka), one paid last month, one due in 10 days.
  const dist = vendors[0];
  const distInter = !tenantStateCode || tenantStateCode !== "29";
  const billSpecs = [
    { subtotal: 15500 * 12, issuedAgo: 35, dueIn: -5, paid: true },
    { subtotal: 3300 * 12,  issuedAgo: 4,  dueIn: 10, paid: false },
  ];
  const vendor_bills: DemoVendorBill[] = billSpecs.map((b, i) => {
    const { tax, total } = gstOn(b.subtotal);
    return {
      id: did("BILL", i + 1), vendor_id: dist.id, vendor_name: dist.name, vendor_gstin: dist.gstin,
      bill_no: `DEMO-DIST-${tag}-${i + 1}`, bill_date: addDays(today, -b.issuedAgo), due_date: addDays(today, b.dueIn),
      category: "COGS-Workspace", subtotal: b.subtotal, ...splitGst(tax, distInter), total,
      status: b.paid ? "paid" : "unpaid", paid_amount: b.paid ? total : 0,
      notes: "Demo bill — no money owed.",
    };
  });

  // Expenses — amount is EX-GST with the GST beside it (how expenses hold value).
  const landlord = vendors[1];
  const gstCols = (taxable: number, withGst: boolean) => {
    if (!withGst) return { gst_paid: 0, cgst: 0, sgst: 0, igst: 0, bill_type: "none" as const };
    const { tax } = gstOn(taxable);
    return { gst_paid: tax, ...splitGst(tax, false), bill_type: "gst" as const };
  };
  const expenseSpecs: { vendor: DemoVendor | null; name: string; category: string; desc: string; amount: number; gst: boolean; ago: number; paid: boolean }[] = [
    { vendor: landlord, name: landlord.name, category: "Office Rent", desc: "Office rent", amount: 25000, gst: false, ago: 6, paid: true },
    { vendor: null, name: `${DEMO_PREFIX}Broadband Provider`, category: "Internet & Phone", desc: "Office broadband", amount: 1000, gst: true, ago: 9, paid: true },
    { vendor: null, name: `${DEMO_PREFIX}Design Tool SaaS`, category: "Software", desc: "Design tool licence", amount: 2500, gst: true, ago: 2, paid: false },
    { vendor: null, name: `${DEMO_PREFIX}Travel Desk`, category: "Travel", desc: "Client visit — cab and train", amount: 3450, gst: false, ago: 12, paid: true },
  ];
  const expenses: DemoExpense[] = expenseSpecs.map((e, i) => ({
    id: did("EXP", i + 1), vendor_id: e.vendor?.id ?? null, vendor_name: e.name, category: e.category,
    description: `${DEMO_PREFIX}${e.desc}`, expense_date: addDays(today, -e.ago), amount: e.amount,
    ...gstCols(e.amount, e.gst), paid: e.paid, paid_date: e.paid ? addDays(today, -e.ago) : null,
    payment_method: e.paid ? "bank_transfer" : null,
  }));

  return { items, vendors, customers, leads, quotes, subscriptions, invoices, payments, tasks, vendor_bills, expenses };
}
