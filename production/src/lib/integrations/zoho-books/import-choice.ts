/**
 * R-2406 — "Import from Zoho": choose what comes in.
 *
 * 3 Nov 2026 staging dry run: 806 new customers, 7 new live subscriptions, 261 open invoices
 * (₹14,56,211). The import was all-or-nothing. The open invoices are unpaid in Zoho, but their
 * money is being booked here through bank reconcile (as new sales) — importing them as opening
 * receivables counts the same money twice and Payment Follow-up chases customers who paid.
 *
 * So the owner ticks the parts: Customers / Subscriptions / Open invoices (open invoices OFF by
 * default, the reason said on screen). Customers can be limited to those with a Zoho invoice in
 * the last N months, so dead Zoho contacts do not flood the customer list. A customer that a
 * chosen subscription or open invoice belongs to always comes in (it cannot exist without one).
 *
 * PURE. The route builds the plan, applies the choice here and sends only the chosen rows to
 * zoho_books_import_begin — a part that is not ticked is an empty list, so the database writes
 * nothing for it (no receivable at all when Open invoices is off).
 */
import { utcDateISO } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";
import type {
  CustomerPayload, ImportPlan, InvoicePayload, SubscriptionPayload, ZohoInvoiceRec,
} from "./import-plan";

export interface ImportChoice {
  customers: boolean;
  subscriptions: boolean;
  invoices: boolean;
  /** Only customers with a Zoho invoice in the last N months; null = every Zoho customer. */
  customerMonths: number | null;
}

/** "Only customers with an invoice in the last …" — offered on screen. */
export const CUSTOMER_MONTHS = [6, 12, 24, 36] as const;

export const DEFAULT_CHOICE: ImportChoice = { customers: true, subscriptions: true, invoices: false, customerMonths: 12 };

/** Said next to the Open invoices tick (why it is off by default). */
export const OPEN_INVOICES_OFF_REASON =
  "Off by default: payments for these invoices are booked in this app through bank reconcile. " +
  "Importing them as opening balances would count the same money twice, and Payment Follow-up would chase customers who already paid.";

/** The choice from a request body; anything missing or not understood → the default. */
export function parseChoice(body: Record<string, unknown> | null | undefined): ImportChoice {
  const parts = (body?.parts ?? {}) as Record<string, unknown>;
  const flag = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const raw = body?.customer_months;
  const customerMonths = raw === null || raw === "all" ? null
    : (CUSTOMER_MONTHS as readonly number[]).includes(Number(raw)) ? Number(raw) : DEFAULT_CHOICE.customerMonths;
  return {
    customers: flag(parts.customers, DEFAULT_CHOICE.customers),
    subscriptions: flag(parts.subscriptions, DEFAULT_CHOICE.subscriptions),
    invoices: flag(parts.invoices, DEFAULT_CHOICE.invoices),
    customerMonths,
  };
}

/** today minus N months (YYYY-MM-DD). */
export function monthsBefore(today: string, months: number): string {
  const [y, m, d] = today.split("-").map(Number);
  return utcDateISO(new Date(Date.UTC(y, m - 1 - months, d)));
}

export interface ChosenPlan {
  choice: ImportChoice;
  /** What zoho_books_import_begin gets. */
  contactRows: CustomerPayload[];
  subscriptions: SubscriptionPayload[];
  invoices: InvoicePayload[];
  counts: {
    /** New customers this import creates. */
    customersNew: number;
    /** …of which only because a chosen subscription / open invoice belongs to them. */
    customersForOtherParts: number;
    /** New Zoho customers left out (not ticked, or no invoice in the chosen months). */
    customersLeftOut: number;
    subscriptions: number;
    invoices: number;
  };
  totals: { mrr: number; openBalance: number };
  /** First day an invoice must be on for the "recent" filter (null = no filter). */
  recentSince: string | null;
}

const DEAD = new Set(["void", "draft"]);

export function choosePlan(
  plan: ImportPlan,
  input: { invoices: readonly ZohoInvoiceRec[]; today: string },
  choice: ImportChoice,
): ChosenPlan {
  const subscriptions = choice.subscriptions ? plan.subscriptions : [];
  const invoices = choice.invoices ? plan.invoices : [];

  /* Zoho contacts the chosen subscriptions / invoices belong to — and, when that contact is the
     "same as" an earlier one of this import, that earlier one too (it creates the customer). */
  const needed = new Set<string>();
  const need = (zohoId: string) => {
    needed.add(zohoId);
    const m = plan.matches[zohoId];
    if (m?.kind === "same_as") needed.add(m.zohoId);
  };
  for (const s of subscriptions) need(s.zoho_customer_id);
  for (const i of invoices) need(i.zoho_customer_id);

  const recentSince = choice.customerMonths == null ? null : monthsBefore(input.today, choice.customerMonths);
  const recent = new Set<string>();
  for (const inv of input.invoices) {
    if (DEAD.has(inv.status.toLowerCase()) || !inv.date) continue;
    if (recentSince == null || inv.date >= recentSince) recent.add(inv.zohoCustomerId);
  }
  const wanted = (zohoId: string) => choice.customers && (recentSince == null || recent.has(zohoId));

  const contactRows = plan.contactRows.filter((c) => needed.has(c.zoho_id) || wanted(c.zoho_id));
  const sent = new Set(contactRows.map((c) => c.zoho_id));
  let customersNew = 0, customersForOtherParts = 0, customersLeftOut = 0;
  for (const c of plan.customers) {
    if (!sent.has(c.zoho_id)) { customersLeftOut++; continue; }
    customersNew++;
    if (!wanted(c.zoho_id)) customersForOtherParts++;
  }

  return {
    choice,
    contactRows,
    subscriptions,
    invoices,
    counts: {
      customersNew, customersForOtherParts, customersLeftOut,
      subscriptions: subscriptions.length, invoices: invoices.length,
    },
    totals: {
      mrr: subscriptions.reduce((s, x) => s + x.mrr, 0),
      openBalance: invoices.reduce((s, x) => s + x.balance, 0),
    },
    recentSince,
  };
}

/** The dry run's "what you chose" block, as the screen shows it. */
export function summariseChoice(plan: ImportPlan, chosen: ChosenPlan) {
  return {
    choice: chosen.choice,
    chosen: chosen.counts,
    chosenTotals: chosen.totals,
    recentSince: chosen.recentSince,
    paidInApp: {
      count: plan.paidInApp.length,
      balance: plan.totals.paidInAppBalance,
      examples: plan.paidInApp.slice(0, 20).map((p) =>
        `${p.number} · ${p.customerName} · ${rupee(p.balance)} — ${p.by === "zoho_number" ? `booked here as ${p.appInvoice}` : `same customer and amount as ${p.appInvoice} (paid)`}`),
    },
  };
}
export type ChoiceSummary = ReturnType<typeof summariseChoice>;
