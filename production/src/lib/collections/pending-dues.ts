/**
 * R-1526 — "Pending dues" statement: ONE document with everything a customer still owes, the
 * total, the bank details and ONE UPI QR for the total (Pardeep, 17 Oct — R-1524 2/3).
 *
 * DECISION (R-1524): issued GST invoices are NEVER merged into a new invoice. This is a
 * STATEMENT OF ACCOUNT — it lists the open tax invoices and asks for their sum; it has no
 * number of its own and never touches the GST series (§17a). When the customer pays the total,
 * staff record it with R-1525's multi-invoice dialog (oldest first, rest → advance).
 *
 * WHAT IS "OWED" — the same set and the same sum as /collections (R-1516) and Customer Aging:
 *   • invoices in pending / overdue with invoiceAmountDue > 0;
 *   • subscriptions with outstanding_amount > 0, not written off, whose quote has NO invoice
 *     (once invoiced, the invoice is the claim — never ask for the same money twice).
 * The test proves the total equals buildCollectionRows' amountDue for the same rows.
 *
 * SENDING (R-1514): a person sends it — by email (through lib/messaging, PDF attached) or by
 * opening WhatsApp with the text below. Nothing here sends anything.
 *
 * Pure: no "use client", no server imports. Money is whole rupees (§13).
 */
import { rupee, formatDate } from "@/lib/utils";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { daysBetweenISO } from "@/lib/dates/ist";
import { UPI_SETTINGS_HREF } from "@/lib/pdf/quote-template";
import { buildUpiIntent } from "@/lib/payments/upi";

// ─── Raw rows (only the columns used) ────────────────────────────────────────

export interface DuesInvoiceRow {
  id: string;
  amount: number | null;
  net_payable: number | null;
  paid_amount: number | null;
  status: string;
  invoice_date: string | null;
  due_date: string | null;
  quote_id: string | null;
  /** Billing currency (books stay ₹). Anything but INR → no UPI QR on the statement. */
  currency: string | null;
}

export interface DuesSubscriptionRow {
  id: string;
  plan: string | null;
  domain: string | null;
  quote_id: string | null;
  outstanding_amount: number | null;
  payment_due_date: string | null;
  created_at: string | null;
}

export interface DuesTenant {
  name: string | null;
  gstin: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  upi_vpa: string | null;
  upi_payee_name: string | null;
  logo_url: string | null;
  remit_bank_name: string | null;
  remit_account_name: string | null;
  remit_account_number: string | null;
  remit_ifsc: string | null;
  remit_branch: string | null;
}

export interface DuesCustomer {
  id: string;
  name: string;
  display_name: string | null;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
}

export interface PendingDuesRaw {
  customer: DuesCustomer;
  tenant: DuesTenant | null;
  invoices: readonly DuesInvoiceRow[];
  /** Subscriptions with a balance (outstanding_amount > 0, not written off). */
  subscriptions: readonly DuesSubscriptionRow[];
  /** Quote ids that already have an invoice (any status) — their subscription balance is the invoice's. */
  invoicedQuoteIds: ReadonlySet<string>;
}

// ─── The statement ───────────────────────────────────────────────────────────

export interface DuesLine {
  kind: "invoice" | "subscription";
  id: string;
  /** Invoice number, or the subscription's plan / domain. */
  label: string;
  quoteId: string | null;
  /** YYYY-MM-DD — the invoice date (subscriptions: when it started). */
  date: string | null;
  /** YYYY-MM-DD — due date (falls back to the invoice date). */
  dueDate: string | null;
  /** Whole IST days past due; 0 or less = not yet due. */
  daysOverdue: number;
  /** Whole rupees still owed on this line. */
  amountDue: number;
}

export interface PendingDuesStatement {
  customerId: string;
  customerName: string;
  /** YYYY-MM-DD (IST) — "as on". */
  asOn: string;
  lines: DuesLine[];
  /** Whole rupees — the sum of the lines. */
  total: number;
  /** Every open invoice is billed in INR (subscriptions are always ₹). */
  allInr: boolean;
}

const day = (d: string | null | undefined): string | null => (d ? d.slice(0, 10) : null);

/** Everything the customer still owes, oldest due first. Same rules as /collections. */
export function buildPendingDuesStatement(raw: PendingDuesRaw, today: string): PendingDuesStatement {
  const lines: DuesLine[] = [];
  let allInr = true;
  const overdue = (d: string | null) => (d ? daysBetweenISO(d, today) : 0);

  for (const inv of raw.invoices) {
    if (inv.status !== "pending" && inv.status !== "overdue") continue;
    const due = Math.round(invoiceAmountDue(inv));
    if (due <= 0) continue;
    if ((inv.currency ?? "INR").trim().toUpperCase() !== "INR") allInr = false;
    const dueDate = day(inv.due_date ?? inv.invoice_date);
    lines.push({
      kind: "invoice", id: inv.id, label: inv.id, quoteId: inv.quote_id,
      date: day(inv.invoice_date), dueDate, daysOverdue: overdue(dueDate), amountDue: due,
    });
  }
  for (const s of raw.subscriptions) {
    const due = Math.max(0, Math.round(s.outstanding_amount ?? 0));
    if (due <= 0) continue;
    if (s.quote_id && raw.invoicedQuoteIds.has(s.quote_id)) continue;   // the invoice is the claim
    const dueDate = day(s.payment_due_date ?? s.created_at);
    lines.push({
      kind: "subscription",
      id: s.id,
      label: [s.plan, s.domain].filter((x) => x && x.trim()).join(" · ") || "Subscription",
      quoteId: s.quote_id,
      date: day(s.created_at),
      dueDate,
      daysOverdue: overdue(dueDate),
      amountDue: due,
    });
  }
  // Oldest due first (what the customer — and R-1525's FIFO allocation — settles first).
  lines.sort((a, b) =>
    (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.id.localeCompare(b.id));

  const c = raw.customer;
  return {
    customerId: c.id,
    customerName: c.display_name?.trim() || c.name?.trim() || "Customer",
    asOn: today,
    lines,
    total: lines.reduce((s, l) => s + l.amountDue, 0),
    allInr,
  };
}

// ─── Pay QR: shown, or why not (§24) ─────────────────────────────────────────

/** How long the WhatsApp statement link works. Short: it opens a customer's dues without a login. */
export const STATEMENT_LINK_TTL_DAYS = 7;

/** Printed on every statement — it is not a tax invoice and must never be taken for one. */
export const STATEMENT_NOTICE = "This is a statement of account, not a tax invoice.";

export interface StatementQrNotice {
  reason: "no-upi" | "non-inr" | "nothing-due";
  text: string;
  action?: { label: string; href: string };
}

/**
 * Why the statement will carry NO scan-to-pay QR, in words the person can act on. Null → a QR
 * for the total will be printed. Non-INR first: adding a UPI ID would not help a dollar bill.
 */
export function statementQrNotice(args: { upiVpa: string | null | undefined; allInr: boolean; total: number }): StatementQrNotice | null {
  if (!(args.total > 0)) return { reason: "nothing-due", text: "Nothing is owed — the statement has no pay QR." };
  if (!args.allInr) {
    return { reason: "non-inr", text: "UPI sirf INR par — is customer ke kuch invoices doosri currency me hain, isliye statement me pay QR nahi aayega." };
  }
  if (!args.upiVpa || !args.upiVpa.trim()) {
    return {
      reason: "no-upi",
      text: "Pay QR ke liye Settings me UPI ID daalo — tab statement me poori rakam ka scan-karke-pay QR aayega.",
      action: { label: "Settings kholo", href: UPI_SETTINGS_HREF },
    };
  }
  return null;
}

/**
 * The `upi://pay` intent for the WHOLE total, or null whenever statementQrNotice says no QR
 * (nothing due, a non-INR bill, no / malformed UPI ID). Same strictness as invoiceUpiIntent:
 * a statement exists to ask for an amount, so an open-amount QR is never printed.
 */
export function statementUpiUri(args: {
  vpa: string | null | undefined;
  payeeName: string | null | undefined;
  customerName: string;
  total: number;
  allInr: boolean;
}): string | null {
  if (statementQrNotice({ upiVpa: args.vpa, allInr: args.allInr, total: args.total })) return null;
  const r = buildUpiIntent({
    vpa: args.vpa ?? "",
    payeeName: args.payeeName?.trim() || "Payee",
    amount: Math.round(args.total),
    note: `Dues ${args.customerName}`,
  });
  return r.ok ? r.uri : null;
}

// ─── Words around it ─────────────────────────────────────────────────────────

/** Attachment / download name: Pending-dues-<customer>-<YYYY-MM-DD>.pdf (safe characters only). */
export function pendingDuesFileName(customerName: string, asOn: string): string {
  const slug = customerName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "customer";
  return `Pending-dues-${slug}-${asOn}.pdf`;
}

export function pendingDuesSubject(st: Pick<PendingDuesStatement, "customerName" | "total" | "asOn">, sellerName: string): string {
  const from = sellerName.trim() ? ` — ${sellerName.trim()}` : "";
  return `Statement of pending dues: ${rupee(st.total)} as on ${formatDate(st.asOn)}${from}`;
}

function lineText(l: DuesLine): string {
  const what = l.kind === "invoice" ? `Invoice ${l.label}` : l.label;
  const late = l.daysOverdue > 0 ? `, ${l.daysOverdue} ${l.daysOverdue === 1 ? "day" : "days"} overdue` : "";
  return `• ${what}: ${rupee(l.amountDue)}${l.dueDate ? ` (due ${formatDate(l.dueDate)}${late})` : ""}`;
}

/**
 * Email body (the PDF is attached). FIRST line says who, how much, how many bills — it becomes
 * the follow-up note (reminderNote).
 */
export function pendingDuesEmailText(st: PendingDuesStatement, opts: { greetName: string | null; sellerName: string }): string {
  const greet = opts.greetName?.trim() || st.customerName;
  const seller = opts.sellerName.trim() || "our";
  const n = st.lines.length;
  return [
    `Hi ${greet}, please find attached the statement of pending dues from ${seller}: ${rupee(st.total)} across ${n} ${n === 1 ? "bill" : "bills"} for ${st.customerName}.`,
    "",
    ...st.lines.map(lineText),
    "",
    `Total due: ${rupee(st.total)}`,
    "",
    "You can pay the total in one go — the bank details and a UPI QR for the full amount are on the attached statement (if your company has set them up).",
    "Please ignore this if already paid, or reply here if anything is wrong.",
    "",
    `— ${seller} team`,
  ].join("\n");
}

/** Short WhatsApp text: the total, the bills, and the statement link only when a signed one exists. */
export function pendingDuesWhatsappText(
  st: PendingDuesStatement,
  opts: { greetName: string | null; sellerName: string; pdfUrl: string | null; upiLink: string | null },
): string {
  const greet = opts.greetName?.trim() || st.customerName;
  const seller = opts.sellerName.trim() || "our";
  const n = st.lines.length;
  const out = [
    `Hi ${greet}, statement of pending dues from ${seller}: ${rupee(st.total)} across ${n} ${n === 1 ? "bill" : "bills"} as on ${formatDate(st.asOn)}.`,
    "",
    ...st.lines.slice(0, 10).map(lineText),
  ];
  if (n > 10) out.push(`…and ${n - 10} more (see the statement).`);
  out.push("", `Total due: ${rupee(st.total)}`);
  if (opts.pdfUrl) out.push("", `Statement (PDF, bank details + UPI QR): ${opts.pdfUrl}`);
  if (opts.upiLink) out.push("", `Pay the total by UPI (open on your phone): ${opts.upiLink}`);
  out.push("", "Please ignore this if already paid, or reply here if anything is wrong.", "", `— ${seller} team`);
  return out.join("\n");
}

/** What the follow-up entry points at: the oldest open bill. */
export function pendingDuesAbout(st: Pick<PendingDuesStatement, "lines">): { invoiceId: string | null; subscriptionId: string | null; quoteId: string | null } {
  const oldest = st.lines[0];
  return {
    invoiceId: oldest?.kind === "invoice" ? oldest.id : null,
    subscriptionId: oldest?.kind === "subscription" ? oldest.id : null,
    quoteId: oldest?.quoteId ?? null,
  };
}
