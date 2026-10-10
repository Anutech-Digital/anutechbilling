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
import { istToday, utcDateISO, formatIstDate } from "@/lib/dates/ist";
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
  /** Current subscription.renewal_date — quote expiry uses this + grace */
  renewalDate:     string;
  graceDays:       number;
  /** How many years the customer wants to add (1, 2, 3, …). Ignored when `months` is set. */
  years?:          number;
  /** R-805: how many MONTHS to add instead (1–11). */
  months?:         number;
  /** R-805: for the new renewal date in the quote note (both stored date shapes). */
  startDate?:      string | null;
  termMonths?:     number | null;
  /** Optional override note for the quote */
  notes?:          string;
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

  /* Build line item. Years: annual rate × N years (unchanged). R-805 months: annual price
     per seat × seats × months / 12 through the R-803 paise engine — see extension-term.ts. */
  const charge       = extensionCharge({ seats: input.seats, mrr: input.mrr, len });
  const annualAmount = charge.subtotal;   // ex-GST subtotal
  const grossAnnual  = charge.total;      // GST-inclusive payable
  const perSeatRate  = charge.perSeat;
  const perSeatCost  = Math.round((annualAmount * 0.83) / Math.max(1, input.seats));
  const yearLabel    = len.unit === "years"
    ? (len.count === 1 ? "1-year extension" : `${len.count}-year extension`)
    : `${len.count}-month extension`;
  const newEnd = extensionRenewalDate(
    { renewal_date: input.renewalDate, start_date: input.startDate ?? null, term_months: input.termMonths ?? null },
    len,
  );

  const lineItems: QuoteLineItem[] = [{
    id:         "extension-1",
    name:       `${input.plan} · ${yearLabel}`,
    qty:        input.seats,
    rate:       perSeatRate,
    cost:       perSeatCost,
    commitment: "annual_yearly",
  }];

  const renewalAt   = new Date(input.renewalDate);
  const validUntil  = new Date(renewalAt.getTime() + (input.graceDays ?? 7) * 86400000);

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
    /* R-025. UTC, so an extension quote raised before 05:30 IST was dated YESTERDAY and
       its validity window ran a day short. `validUntil` is the renewal date (a
       YYYY-MM-DD parsed as UTC midnight) plus whole days, so its UTC parts already ARE
       the calendar date — `utcDateISO` says that out loud rather than shifting twice. */
    created_date:     istToday(),
    expires_date:     utcDateISO(validUntil),
    line_items:       lineItems,
    subtotal:         annualAmount,
    total_cost:       Math.round(annualAmount * 0.83),
    discount_pct:     0,
    tax_rate:         18,
    is_renewal:       true,    // drives record_payment roll-forward
    is_extension:     true,    // display flag — UI shows "Extension" not "Renewal"
    extension_months: months,
    notes:            input.notes
      ?? `${yearLabel} for subscription ${input.subscriptionId}. On payment the renewal date advances by ${extensionLabel(len)}${newEnd ? ` (to ${formatIstDate(newEnd)})` : ""}.`,
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
