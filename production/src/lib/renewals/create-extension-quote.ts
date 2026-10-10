/**
 * createExtensionQuote — issue a "top-up" quote that adds N more years
 * to an existing active subscription's term.
 *
 * Same machinery as a renewal quote (`is_renewal = true`, linked via
 * `subscriptions.renewal_quote_id`) so the record_payment roll-forward
 * branch fires automatically. The difference is `extension_months`:
 *
 *   - Renewal (cron-generated): extension_months = 12, fires when the
 *     current term is ending. Sub renewal_date += 12 months.
 *   - Extension (operator-triggered): extension_months = 12 / 24 / 36 etc.
 *     Sub renewal_date += that many months.
 *
 * Why not refund-and-rebuy?
 *   • GST invoices are immutable (CGST §31) — can't modify the original.
 *   • Refund + new invoice = credit note paperwork + ITC reconciliation.
 *   • Two clean GST invoices = customer gets two valid ITC entries.
 *
 * Idempotency:
 *   If the subscription already has a renewal_quote_id (e.g., cron just
 *   created a renewal), this function refuses with `code: "already_open"`.
 *   Operator must finalize/cancel the existing quote before issuing an
 *   extension to avoid two open quotes on the same subscription.
 *
 * Server-only — uses service-role client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, QuoteLineItem } from "@/lib/supabase/database.types";
import { istToday, formatIstDate } from "@/lib/dates/ist";
import { extensionQuoteExpiry } from "@/lib/quotes/quote-validity";
import { composeQuoteNotes } from "@/lib/quotes/customer-notes";
import { addDaysISO } from "@/lib/billing/schedule";
import { followingTermStart } from "@/lib/billing/subscription-schedule";
import {
  extensionCharge, extensionLabel, extensionLengthError, extensionMonths, extensionRenewalDate,
  type ExtensionLength,
} from "./extension-term";

type SupabaseAdmin = SupabaseClient<Database>;

export interface CreateExtensionQuoteInput {
  supabase:        SupabaseAdmin;
  subscriptionId:  string;
  tenantId:        string;
  customerId:      string | null;
  customerName:    string;
  plan:            string;
  seats:           number;
  mrr:             number;
  /** Current subscription.renewal_date — caps the quote expiry (R-820) */
  renewalDate:     string;
  /** Not used for the expiry since R-820 (30 days, capped at renewalDate). */
  graceDays:       number;
  /** How many years the customer wants to add (1, 2, 3, …). Ignored when `months` is set. */
  years?:          number;
  /** R-805: how many MONTHS to add instead (1–11). */
  months?:         number;
  /** R-805: for the new renewal date in the quote note (both stored date shapes). */
  startDate?:      string | null;
  termMonths?:     number | null;
  /** R-834: subscriptions.domain — named in the quote note. */
  domain?:         string | null;
  /** Optional override note for the quote */
  notes?:          string;
}

/**
 * R-834 — the note an extension quote is saved with.
 *
 * It used to read "1-year extension for subscription 129f0d2b-…", and the staff quote page
 * prints notes as stored. Now the readable part names what is extended — plan · domain ·
 * the dates the extension covers — and the subscription id moves to the staff-only part
 * (R-813 marker): the Renewals page still finds an open quote by "subscription <id>" in
 * its notes (renewals/open-renewal-quotes.ts), and the staff page hides the id on display.
 */
export function extensionQuoteNotes(args: {
  subscriptionId: string;
  plan:           string | null | undefined;
  domain:         string | null | undefined;
  len:            ExtensionLength;
  renewalDate:    string;
  startDate:      string | null;
  termMonths:     number | null;
}): string {
  const shape = { renewal_date: args.renewalDate, start_date: args.startDate, term_months: args.termMonths ?? 12 };
  const newEnd = extensionRenewalDate(shape, args.len);
  const title = extensionTitleCase(args.len);
  const what = [args.plan?.trim(), args.domain?.trim()].filter((s): s is string => !!s).join(" · ");

  let span = "";
  if (newEnd && /^\d{4}-\d{2}-\d{2}/.test(args.renewalDate)) {
    const from = followingTermStart(shape);
    /* A month extension's date is always an inclusive last day. A year extension keeps the
       row's shape: on an anniversary row (from === renewal date) the term ends the day before. */
    const anniversary = from === args.renewalDate.slice(0, 10);
    const to = args.len.unit === "years" && anniversary ? addDaysISO(newEnd, -1) : newEnd;
    span = `${formatIstDate(from)} to ${formatIstDate(to)}`;
  }

  const head = [title, [what, span].filter(Boolean).join(" · ")].filter(Boolean).join(": ");
  const tail = newEnd
    ? ` On payment the renewal date moves by ${extensionLabel(args.len)}, to ${formatIstDate(newEnd)}.`
    : ` On payment the renewal date moves by ${extensionLabel(args.len)}.`;
  return composeQuoteNotes(`${head}.${tail}`, `Raised from Extend term for subscription ${args.subscriptionId}.`);
}

/** "1-year extension" / "3-month extension", capitalised. */
function extensionTitleCase(len: ExtensionLength): string {
  const t = `${len.count}-${len.unit === "years" ? "year" : "month"} extension`;
  return `${t[0].toUpperCase()}${t.slice(1)}`;
}

export interface CreateExtensionQuoteResult {
  ok:       true;
  quoteId:  string;
  amount:   number;
  /** Whole years added, or null for a month extension. */
  years:    number | null;
  /** Months added — what the quote stores as extension_months. */
  months:   number;
}

export interface CreateExtensionQuoteError {
  ok:       false;
  code:     "already_open" | "no_doc_number" | "insert_failed" | "invalid_years";
  message:  string;
}

export async function createExtensionQuote(
  input: CreateExtensionQuoteInput,
): Promise<CreateExtensionQuoteResult | CreateExtensionQuoteError> {
  const len: ExtensionLength = input.months != null
    ? { unit: "months", count: input.months }
    : { unit: "years", count: input.years ?? NaN };
  const lenError = Number.isFinite(len.count) ? extensionLengthError(len) : "Years must be between 1 and 5";
  if (lenError) return { ok: false, code: "invalid_years", message: lenError };

  const months = extensionMonths(len);

  // Idempotency guard — refuse if subscription already has an open quote
  const { data: sub } = await input.supabase
    .from("subscriptions")
    .select("renewal_quote_id")
    .eq("id", input.subscriptionId)
    .maybeSingle();
  if (sub?.renewal_quote_id) {
    return {
      ok: false,
      code: "already_open",
      message: `Subscription already has an open renewal/extension quote (${sub.renewal_quote_id}). Finalize or delete it first.`,
    };
  }

  // Allocate quote number
  const { data: nextNumber, error: numErr } = await input.supabase.rpc("next_document_number", {
    p_doc_type:  "quote",
    p_tenant_id: input.tenantId,
  });
  if (numErr || !nextNumber) {
    return { ok: false, code: "no_doc_number", message: numErr?.message ?? "Could not allocate quote number" };
  }
  const newQuoteId = nextNumber as unknown as string;

  /* Build line item. R-834: the charge is built FROM the line — whole-rupee rate per seat
     × seats = subtotal, so rate × qty on every screen equals the subtotal (extension-term.ts). */
  const charge       = extensionCharge({ seats: input.seats, mrr: input.mrr, len });
  const annualAmount = charge.subtotal;   // ex-GST subtotal = perSeat × seats
  const grossAnnual  = charge.total;      // GST-inclusive payable
  const perSeatRate  = charge.perSeat;
  const perSeatCost  = Math.round((annualAmount * 0.83) / Math.max(1, input.seats));
  const yearLabel    = len.unit === "years"
    ? (len.count === 1 ? "1-year extension" : `${len.count}-year extension`)
    : `${len.count}-month extension`;

  const lineItems: QuoteLineItem[] = [{
    id:         "extension-1",
    name:       `${input.plan} · ${yearLabel}`,
    qty:        input.seats,
    rate:       perSeatRate,
    cost:       perSeatCost,
    commitment: "annual_yearly",
  }];

  /* R-820: 30 days from today (DEFAULT_QUOTE_VALIDITY_DAYS), capped at the current renewal
     date — was renewal + grace, which left a quote open ~339 days right after a renewal. */
  const today       = istToday();
  const expiresDate = extensionQuoteExpiry(today, input.renewalDate);

  const { error: insertErr } = await input.supabase.from("quotes").insert({
    id:               newQuoteId,
    tenant_id:        input.tenantId,
    customer_id:      input.customerId,
    customer_name:    input.customerName,
    plan:             input.plan,
    seats:            input.seats,
    amount:           grossAnnual,
    status:           "sent",
    payment_status:   "awaiting",
    owner_id:         null,
    /* R-025: IST date, so a quote raised before 05:30 IST is not dated yesterday. */
    created_date:     today,
    expires_date:     expiresDate,
    line_items:       lineItems,
    subtotal:         annualAmount,
    total_cost:       Math.round(annualAmount * 0.83),
    discount_pct:     0,
    tax_rate:         18,
    is_renewal:       true,    // drives record_payment roll-forward
    is_extension:     true,    // display flag — UI shows "Extension" not "Renewal"
    extension_months: months,
    notes:            input.notes ?? extensionQuoteNotes({
      subscriptionId: input.subscriptionId,
      plan:           input.plan,
      domain:         input.domain ?? null,
      len,
      renewalDate:    input.renewalDate,
      startDate:      input.startDate ?? null,
      termMonths:     input.termMonths ?? null,
    }),
  });
  if (insertErr) {
    return { ok: false, code: "insert_failed", message: insertErr.message };
  }

  // Link back so record_payment finds it
  await input.supabase
    .from("subscriptions")
    .update({ renewal_quote_id: newQuoteId })
    .eq("id", input.subscriptionId);

  return { ok: true, quoteId: newQuoteId, amount: grossAnnual, years: len.unit === "years" ? len.count : null, months };
}
