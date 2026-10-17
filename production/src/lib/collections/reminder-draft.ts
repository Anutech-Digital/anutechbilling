/**
 * R-1518 — the payment reminder a PERSON sends from /collections ("Remind").
 *
 * DECISION (Pardeep, 17 Oct, R-1514): a human sends every reminder; the AI only drafts.
 * Nothing in this file or its routes sends on its own — the draft comes back to the screen,
 * the person edits it and presses "Open WhatsApp" or "Send email".
 *
 * Pure, no "use client" and no server imports: the draft route builds the context and the
 * plain template here, the dialog uses the WhatsApp / email target rules and the note line,
 * and the tests run them on fixtures.
 *
 * MONEY (§13): every figure is whole rupees, formatted with rupee(). The AI draft is checked
 * against `reminderAllowedAmounts` (lib/ai/money-guard) — a draft that names any other amount
 * is thrown away and the template below is used instead.
 *
 * TONE: the same as the app's WhatsApp reminder starters (lib/marketing/whatsapp-reminders.ts)
 * and the dunning mail — "Hi <name>, invoice X for ₹Y was due on Z and is still unpaid. Please
 * arrange payment, or reply here if something is wrong. — <company> team". Plain English that
 * reads fine on WhatsApp and in email.
 */
import { rupee, formatDate } from "@/lib/utils";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { dialable } from "@/lib/leads/call-queue";
import { quoteAcceptUrl } from "@/lib/quotes/accept-link";
import { upiPayLink } from "@/lib/invoices/pay-link";
import { daysBetweenISO } from "@/lib/dates/ist";

// ─── Raw rows the server reads (only the columns used) ───────────────────────

export interface ReminderInvoiceRow {
  id: string;
  amount: number | null;
  net_payable: number | null;
  paid_amount: number | null;
  status: string;
  invoice_date: string | null;
  due_date: string | null;
  quote_id: string | null;
}

export interface ReminderSubscriptionRow {
  id: string;
  plan: string | null;
  domain: string | null;
  quote_id: string | null;
  outstanding_amount: number | null;
  payment_due_date: string | null;
  created_at: string | null;
}

export interface ReminderPromiseRow {
  promised_on: string | null;
  promised_amount: number | null;
}

export interface ReminderRaw {
  customerName: string;
  /** The primary contact's name — who the message greets. */
  contactName: string | null;
  sellerName: string;
  invoices: readonly ReminderInvoiceRow[];
  /** Subscriptions with a balance (outstanding_amount > 0, not written off). */
  subscriptions: readonly ReminderSubscriptionRow[];
  /** Quote ids that already have an invoice — their subscription balance is the invoice's (R-1516). */
  invoicedQuoteIds: ReadonlySet<string>;
  /** quotes.public_token by quote id, for the customer's view / pay link. */
  quoteTokens: ReadonlyMap<string, string>;
  /** The newest follow-up that carried a promise date, if any. */
  lastPromise: ReminderPromiseRow | null;
  upiVpa: string | null;
  upiPayeeName: string | null;
  /** The app's public origin (trustedOrigin) — null means no links. */
  origin: string | null;
}

// ─── What the draft is made from ─────────────────────────────────────────────

export interface ReminderLine {
  kind: "invoice" | "subscription";
  id: string;
  /** Invoice number, or the subscription's plan / domain. */
  label: string;
  quoteId: string | null;
  amountDue: number;
  dueDate: string | null;
  daysOverdue: number;
  /** The customer's quote view / pay page, when the quote has a public link. */
  link: string | null;
}

export interface ReminderContext {
  customerName: string;
  /** Who the message greets: the contact, else the customer. */
  greetName: string;
  sellerName: string;
  lines: ReminderLine[];
  /** Whole rupees, the sum of the lines. */
  amountDue: number;
  /** Of the oldest line; 0 or less = not yet due. */
  daysOverdue: number;
  /** upi://pay for the whole balance, when the company has a UPI id on file. */
  payLink: string | null;
  lastPromise: { on: string; amount: number | null; broken: boolean } | null;
}

/** The context of one customer's reminder. Same balance rules as /collections (R-1516). */
export function buildReminderContext(raw: ReminderRaw, today: string): ReminderContext {
  const linkFor = (quoteId: string | null): string | null => {
    if (!quoteId) return null;
    const token = raw.quoteTokens.get(quoteId);
    return token ? quoteAcceptUrl(raw.origin, quoteId, token) : null;
  };
  const overdue = (date: string | null) => (date ? daysBetweenISO(date.slice(0, 10), today) : 0);

  const lines: ReminderLine[] = [];
  for (const inv of raw.invoices) {
    if (inv.status !== "pending" && inv.status !== "overdue") continue;
    const due = Math.round(invoiceAmountDue(inv));
    if (due <= 0) continue;
    const dueDate = (inv.due_date ?? inv.invoice_date)?.slice(0, 10) ?? null;
    lines.push({
      kind: "invoice", id: inv.id, label: inv.id, quoteId: inv.quote_id,
      amountDue: due, dueDate, daysOverdue: overdue(dueDate), link: linkFor(inv.quote_id),
    });
  }
  for (const s of raw.subscriptions) {
    const due = Math.max(0, Math.round(s.outstanding_amount ?? 0));
    if (due <= 0) continue;
    if (s.quote_id && raw.invoicedQuoteIds.has(s.quote_id)) continue;   // the invoice is the claim
    const dueDate = (s.payment_due_date ?? s.created_at)?.slice(0, 10) ?? null;
    lines.push({
      kind: "subscription",
      id: s.id,
      label: [s.plan, s.domain].filter((x) => x && x.trim()).join(" · ") || "Subscription",
      quoteId: s.quote_id,
      amountDue: due, dueDate, daysOverdue: overdue(dueDate), link: linkFor(s.quote_id),
    });
  }
  lines.sort((a, b) => b.daysOverdue - a.daysOverdue || b.amountDue - a.amountDue || a.id.localeCompare(b.id));

  const amountDue = lines.reduce((s, l) => s + l.amountDue, 0);
  const daysOverdue = lines.length ? Math.max(...lines.map((l) => l.daysOverdue)) : 0;
  const promisedOn = raw.lastPromise?.promised_on?.slice(0, 10) ?? null;

  return {
    customerName: raw.customerName.trim() || "there",
    greetName: raw.contactName?.trim() || raw.customerName.trim() || "there",
    sellerName: raw.sellerName.trim() || "our",
    lines,
    amountDue,
    daysOverdue,
    payLink: upiPayLink({
      upiVpa: raw.upiVpa,
      payeeName: raw.upiPayeeName ?? raw.sellerName,
      amountDue,
      invoiceId: lines.find((l) => l.kind === "invoice")?.id ?? raw.customerName,
    }),
    lastPromise: promisedOn
      ? {
          on: promisedOn,
          amount: raw.lastPromise?.promised_amount != null ? Math.round(raw.lastPromise.promised_amount) : null,
          broken: promisedOn < today && amountDue > 0,
        }
      : null,
  };
}

/** The only rupee figures a draft may name (money-guard). */
export function reminderAllowedAmounts(ctx: ReminderContext): number[] {
  const out = new Set<number>([ctx.amountDue, ...ctx.lines.map((l) => l.amountDue)]);
  if (ctx.lastPromise?.amount) out.add(ctx.lastPromise.amount);
  return [...out];
}

export interface ReminderDraft {
  subject: string;
  message: string;
}

function lineText(l: ReminderLine): string {
  const what = l.kind === "invoice" ? `Invoice ${l.label}` : l.label;
  const when = l.dueDate
    ? l.daysOverdue > 0 ? ` — due ${formatDate(l.dueDate)}, ${l.daysOverdue} ${l.daysOverdue === 1 ? "day" : "days"} overdue` : ` — due ${formatDate(l.dueDate)}`
    : "";
  return `• ${what}: ${rupee(l.amountDue)}${when}${l.link ? `\n  ${l.link}` : ""}`;
}

/**
 * The plain reminder — used when there is no Gemini key, the AI is down, or its draft named
 * an amount it was not given. Built only from the context, so its figures cannot be wrong.
 * The FIRST line says who, how much and how late: it becomes the follow-up note.
 */
export function buildReminderTemplate(ctx: ReminderContext): ReminderDraft {
  const late = ctx.daysOverdue > 0 ? `, ${ctx.daysOverdue} ${ctx.daysOverdue === 1 ? "day" : "days"} overdue` : "";
  const out: string[] = [
    `Hi ${ctx.greetName}, a gentle reminder from ${ctx.sellerName}: ${rupee(ctx.amountDue)} is pending for ${ctx.customerName}${late}.`,
    "",
    ...ctx.lines.map(lineText),
  ];
  if (ctx.lastPromise) {
    const amt = ctx.lastPromise.amount ? ` ${rupee(ctx.lastPromise.amount)}` : "";
    out.push("", ctx.lastPromise.broken
      ? `You had mentioned paying${amt} by ${formatDate(ctx.lastPromise.on)} — could you let us know when we can expect it?`
      : `Thank you for confirming payment${amt} by ${formatDate(ctx.lastPromise.on)}.`);
  }
  if (ctx.payLink) out.push("", `Pay by UPI (open on your phone): ${ctx.payLink}`);
  out.push("", "Please ignore this if already paid, or reply here if anything is wrong.", "", `— ${ctx.sellerName} team`);
  return {
    subject: `Payment reminder: ${rupee(ctx.amountDue)} pending — ${ctx.customerName}`,
    message: out.join("\n"),
  };
}

/** What the AI is told — facts only, every amount already formatted. */
export function reminderFactsForAi(ctx: ReminderContext): string {
  const f: string[] = [
    `Company sending (us): ${ctx.sellerName}`,
    `Customer: ${ctx.customerName}`,
    `Greet: ${ctx.greetName}`,
    `Total pending: ${rupee(ctx.amountDue)}`,
    `Most overdue: ${ctx.daysOverdue > 0 ? `${ctx.daysOverdue} days` : "not yet due"}`,
    "Items (use these lines exactly, links unchanged):",
    ...ctx.lines.map(lineText),
  ];
  if (ctx.lastPromise) {
    f.push(`Last promise from customer: pay${ctx.lastPromise.amount ? ` ${rupee(ctx.lastPromise.amount)}` : ""} by ${formatDate(ctx.lastPromise.on)} — ${ctx.lastPromise.broken ? "date passed, NOT paid" : "date still ahead"}`);
  }
  if (ctx.payLink) f.push(`UPI pay link (include unchanged): ${ctx.payLink}`);
  return f.join("\n");
}

export const REMINDER_AI_SYSTEM =
  "You draft a short, polite payment reminder for an Indian IT reseller to send to its customer. " +
  "A person reads and edits it before sending. Plain English (a light Hinglish touch is fine), warm and firm, no threats, no legal language. " +
  "The FIRST line must greet the person and state the total pending and how overdue, e.g. 'Hi Rahul, a gentle reminder: ₹45,000 is pending, 12 days overdue.' " +
  "Then list the items, mention the last promise if given, include the pay link if given, ask them to reply if anything is wrong, and sign off as '— <company> team'. " +
  "Under 900 characters. CRITICAL: use ONLY the amounts, dates and links given, exactly as written — never invent, round or change any figure. " +
  'Return ONLY JSON: {"subject": string, "message": string}.';

// ─── Where it can go ─────────────────────────────────────────────────────────

export type Target = { ok: true; to: string } | { ok: false; reason: string };

export const NO_PHONE =
  "No mobile number for this customer — add one to the primary contact on the customer page to send on WhatsApp.";
export const NO_EMAIL =
  "No billing email for this customer — add one to the primary contact on the customer page to send by email.";

/** WhatsApp number (digits with 91) or why WhatsApp is off. */
export function whatsappTarget(phone: string | null | undefined): Target {
  const n = dialable(phone);
  return n ? { ok: true, to: n } : { ok: false, reason: NO_PHONE };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function emailTarget(email: string | null | undefined): Target {
  const e = (email ?? "").trim();
  return EMAIL_RE.test(e) ? { ok: true, to: e } : { ok: false, reason: NO_EMAIL };
}

/** wa.me link with the message filled in — WhatsApp opens; the person presses send there. */
export function waMeUrl(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

/** The follow-up note: the message's first non-empty line, at most 300 characters. */
export function reminderNote(text: string): string {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.length > 300 ? `${first.slice(0, 299)}…` : first;
}
