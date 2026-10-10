/**
 * Add-seats flow — mid-term seat expansion with pro-rata billing.
 *
 * Customer is mid-way through their term and wants to add N seats.
 * We can't bill the full annual rate for the new seats — only the
 * remaining portion until renewal_date. Pro-rata math:
 *
 *   pro_rata_factor = days_remaining / 365
 *   pro_rata_amount = annual_rate × additional_seats × pro_rata_factor
 *
 * Two writes happen atomically:
 *   1. subscription.seats += additional_seats
 *      subscription.mrr is recomputed (proportional bump)
 *   2. quotes row created — sent, awaiting payment, NOT a renewal/extension
 *
 * The quote is marked `is_add_seats=true` so record_payment SKIPS all
 * subscription handling for it (migration 0052). Without that flag record_payment
 * step 8a would treat the annual pro-rata quote as a new sale and create a
 * DUPLICATE subscription (audit bug #3/#4). The existing sub is already updated
 * above; the pro-rata payment just records into the ledger. This flow creates
 * its own draft PO below.
 *
 * Server-only (service-role client).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, QuoteLineItem } from "@/lib/supabase/database.types";
import { prorate, rupeesToPaise, paiseToRupees, daysBetweenDates } from "./proration";
import { seatIncreaseCharge } from "./seat-increase-charge";
import { buildPlanIndex, matchPlan, type PlanIndex, type CatalogRow } from "./plan-match";
import { istToday, utcDateISO } from "@/lib/dates/ist";

type SupabaseAdmin = SupabaseClient<Database>;

/**
 * Where the vendor cost on the quote line and the draft PO came from.
 *
 * This is carried, not thrown away, because the PO goes to a distributor. A PO whose
 * cost was invented has to SAY it was invented — the note records the source, so
 * nobody reconciles a guess against a real invoice and concludes the invoice is wrong.
 */
export type CostSource = "catalog" | "heuristic";

export interface SeatCost {
  /** ₹/seat/month. */
  costPerSeatMonth: number;
  source:           CostSource;
}

/**
 * The 17% that used to be the only answer. Kept ONLY as a last resort, and now it
 * announces itself instead of passing for a measurement.
 *
 * How wrong it is, measured against this tenant's real catalog (₹/seat/month):
 *     Business Starter    guess 224   real  110   — 104% too high
 *     Business Standard   guess 717   real  620   —  16% too high
 *     Business Plus       guess 1145  real 1150   —   0%
 *     M365 Premium        guess 1577  real 1620   —   3% too low
 * It happens to be close on the products whose real margin is near 17%, and doubles
 * the cost on Starter. That is the shape of a guess: right where you don't need it.
 */
const HEURISTIC_MARGIN = 0.83;

/**
 * Vendor cost per seat per month for a plan, from the catalog when it can be found
 * and from the old heuristic when it cannot.
 *
 * Pure on purpose — the DB read happens in the caller — so the resolution rule is
 * testable without a Supabase mock, which is why the old rule never had a test.
 */
export function resolveSeatCost(args: {
  index:         PlanIndex;
  vendor:        string;
  plan:          string;
  /** ₹/seat/year the customer pays, for the fallback only. */
  annualPerSeat: number;
  /** The subscription's stored catalog link, and the cost of every catalog row by id. */
  itemId?:       string | null;
  costsById?:    ReadonlyMap<string, number>;
}): SeatCost {
  /* The stored link wins. It is exact, it survives a catalog rename, and the FK
     guarantees the row belongs to this tenant (0248 is composite on tenant_id). */
  if (args.itemId && args.costsById?.has(args.itemId)) {
    return { costPerSeatMonth: args.costsById.get(args.itemId)!, source: "catalog" };
  }

  const hit = matchPlan(args.index, args.vendor, args.plan);
  /* A catalog cost of 0 is accepted as real. For hosting/support/own services it IS
     zero, and substituting the heuristic there would invent a cost for work that has
     none — inflating the PO and understating the margin on the most profitable lines. */
  if (hit.matched) return { costPerSeatMonth: hit.costPerSeatMonth, source: "catalog" };

  return {
    costPerSeatMonth: Math.round((args.annualPerSeat * HEURISTIC_MARGIN) / 12),
    source:           "heuristic",
  };
}

/**
 * Read the tenant's catalog once and index it two ways: by id, for the stored link,
 * and by normalised name + vendor, for rows that predate the link.
 *
 * Scoped to the tenant and NOT to the vendor. The cross-vendor bug this replaces —
 * `.ilike("name", plan).limit(1)`, where a plan named just "Standard" could take the
 * hosting row's ₹0 and write a ₹0 PO for a Google seat — is closed by vendor being
 * part of the match KEY, not by filtering the query. Loading every vendor keeps the
 * by-id map complete, which a vendor filter would silently hole if a subscription's
 * stored item_id ever pointed outside its own vendor.
 */
async function loadCatalog(
  supabase: SupabaseAdmin, tenantId: string,
): Promise<{ index: PlanIndex; costsById: Map<string, number> }> {
  const { data } = await supabase
    .from("items")
    .select("id, name, vendor, prices, wholesale")
    .eq("tenant_id", tenantId);

  const costOf = (it: { prices: unknown; wholesale: number | null }) => {
    const annual = (it.prices as { annual?: { wholesale?: number } } | null)?.annual?.wholesale;
    return typeof annual === "number" && annual > 0 ? annual : (it.wholesale ?? 0);
  };

  const rows: CatalogRow[] = (data ?? []).map((it) => ({
    name: it.name, vendor: String(it.vendor), costPerSeatMonth: costOf(it),
  }));
  return {
    index:     buildPlanIndex(rows),
    costsById: new Map((data ?? []).map((it) => [it.id, costOf(it)])),
  };
}

export interface AddSeatsInput {
  supabase:           SupabaseAdmin;
  subscriptionId:     string;
  tenantId:           string;
  customerId:         string | null;
  customerName:       string;
  plan:               string;
  vendor:             "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  /**
   * The subscription's stored catalog link (migration 0248). When set it decides the
   * cost outright — the plan-text match is only for rows written before the column
   * existed, and a stored id cannot be broken by renaming a catalog row.
   */
  itemId?:            string | null;
  domain:             string | null;
  currentSeats:       number;
  currentMrr:         number;     // ₹/month per existing sub
  additionalSeats:    number;     // N
  renewalDate:        string;     // ISO / YYYY-MM-DD — drives pro-rata
  graceDays:          number;     // tenant.grace_period_days
  /**
   * GST percent for THIS customer. 18 domestic, 0 for a zero-rated export.
   *
   * REQUIRED, with no default, deliberately. This used to be a hardcoded `× 1.18`,
   * so an export customer was billed ₹2,135 of GST on a ₹11,836 seat expansion
   * that must not carry any — while isExportSupply() sat unused in lib/gst. A
   * default here would let the next caller reintroduce that silently.
   */
  taxRatePct:         number;
  /** R-389 (F9): "IGST 18%" / "CGST 9% + SGST 9%" for the quote note; falls back to "GST <rate>%". */
  taxLabel?:          string;
  /**
   * Length of the WHOLE current term in days — 365, 366 in a leap year, 730 for a
   * two-year deal. Also required, for the same reason: this was hardcoded to 365
   * and remaining days clamped to [0,365], so a two-year term with 400 days left
   * billed as a full year (₹21,600 instead of ₹11,836).
   */
  termDays:           number;
  /**
   * R-801: the EXCLUSIVE end of the term (first unpaid day) — seatTermEnd() in
   * seat-charge-window.ts. renewalDate is the INCLUSIVE last covered day on rows written
   * since 11 Sep 2026, so counting to it dropped the last day and refused the renewal day
   * itself as "term ended". Absent = renewalDate (the old reading, right for anniversary rows).
   */
  termEnd?:           string | null;
  /**
   * R-527: a split-billed subscription is paid only to the end of its CURRENT instalment, so
   * the new seats are charged to that date, not to renewal (lib/subscriptions/seat-charge-
   * window.ts). Absent = charge to the renewal date, exactly as before. The draft PO still
   * runs to renewal: the vendor commitment for the seats is the whole remaining term.
   */
  chargeWindow?:      { remainingDays: number; chargeTo: string } | null;
  /**
   * R-800: the date the seats were actually provisioned (YYYY-MM-DD), already validated by
   * checkSeatEffectiveDate — never in the future, never before the term start. Absent =
   * today, as before. The pro-rata charge runs FROM this date; with a chargeWindow, the
   * caller has already measured remainingDays from it.
   */
  effectiveDate?:     string;
  /** R-800: who chose a backdated effective date — written into the quote note. */
  effectiveDateSetBy?: string | null;
  /** Today (IST, YYYY-MM-DD). Injected for tests; defaults to istToday(). */
  todayISO?:          string;
}

export interface AddSeatsResult {
  ok:           true;
  quoteId:      string;
  amount:       number;            // pro-rata GST-incl ₹
  proRataDays:  number;
  /** R-800: the date the charge runs from (today unless backdated). */
  effectiveDate: string;
  newSeats:     number;
  newMrr:       number;
  /** Newly created draft Purchase Order for the additional seats (null if catalog/vendor info missing) */
  poId:         string | null;
}

export interface AddSeatsError {
  ok:       false;
  code:     "invalid_seats" | "invalid_effective_date" | "no_renewal_date" | "term_ended" | "no_doc_number" | "insert_failed" | "sub_update_failed";
  message:  string;
}


export async function addSeats(input: AddSeatsInput): Promise<AddSeatsResult | AddSeatsError> {
  if (!Number.isFinite(input.additionalSeats) || input.additionalSeats < 1 || input.additionalSeats > 5000) {
    return { ok: false, code: "invalid_seats", message: "Additional seats must be between 1 and 5000" };
  }
  if (!input.renewalDate) {
    return { ok: false, code: "no_renewal_date", message: "Subscription has no renewal_date — extend or renew first" };
  }

  /* Days between a calendar date and renewal_date — by date, not by elapsed hours
     (daysBetweenDates), and no longer clamped to 365: prorate() clamps to the ACTUAL term,
     which is the whole point — clamping to a year made a two-year term bill as annual. */
  const today = (input.todayISO ?? istToday()).slice(0, 10);
  const effective = (input.effectiveDate ?? today).slice(0, 10);
  /* The term has ended when TODAY is past renewal — a backdated effective date does not
     reopen a closed term. 0 or less → can't pro-rate, the operator should renew instead. */
  const termEnd = (input.termEnd ?? input.renewalDate).slice(0, 10);
  if (daysBetweenDates(today, termEnd) <= 0) {
    return { ok: false, code: "term_ended", message: "Term has ended — issue a renewal quote instead" };
  }
  if (effective > today) {
    return { ok: false, code: "invalid_effective_date", message: "Effective date can't be in the future." };
  }
  /* R-800: the seats were in use from `effective`, so the remaining term — and the vendor
     commitment on the draft PO — runs from there. */
  const days = daysBetweenDates(effective, termEnd);
  /* R-527: days the CUSTOMER is charged for now — the current instalment on a split-billed
     subscription, else the rest of the term. Both measured from the effective date. */
  const chargeDays = input.chargeWindow ? Math.max(1, input.chargeWindow.remainingDays) : days;
  const chargeTo   = input.chargeWindow?.chargeTo ?? input.renewalDate;

  /* R-803: the charge comes from seatIncreaseCharge() — the same function every preview
     (Add seats dialog, seat-requests card) calls, so a preview cannot disagree with this
     quote. Annual per seat = round(currentMrr × 12 ÷ currentSeats); pro-rata via prorate()
     in integer paise, rounded ONCE, with the tax rate and the term length passed in. What
     changed in rupees is pinned case by case in add-seats-before-after.test.ts. */
  const priced = seatIncreaseCharge({
    currentSeats:    input.currentSeats,
    currentMrr:      input.currentMrr,
    additionalSeats: input.additionalSeats,
    remainingDays:   chargeDays,
    termDays:        input.termDays,
    taxRatePct:      input.taxRatePct,
  });
  const annualPerSeat = priced.annualPerSeat;
  const charge        = priced.proration;
  const subtotalExGst = priced.subtotal;
  const totalInclGst  = priced.total;
  // Per-seat rate for the quote LINE only — the subtotal above is never derived
  // from it. That multiplication is exactly the bug this replaced.
  const proRataPerSeat = priced.perSeat;

  /* The real vendor cost, resolved ONCE and used by both the quote line and the draft
     PO below. Those two used to disagree: the quote line was always `× 0.83` while the
     PO did its own lookup, so the same seat expansion could carry two different costs
     in two records of the same transaction. */
  const catalog = await loadCatalog(input.supabase, input.tenantId);
  const seatCost = resolveSeatCost({
    index: catalog.index, costsById: catalog.costsById, itemId: input.itemId,
    vendor: input.vendor, plan: input.plan, annualPerSeat,
  });

  /* Pro-rata the cost over the same remaining days as the charge, so the quote line's
     cost and rate cover the same period. Cost is ₹/seat/MONTH, so × 12 for the year
     before pro-rating — getting this wrong is a silent 12× on every margin. */
  const wholesalePerSeat = paiseToRupees(
    prorate({
      annualPerSeatPaise: rupeesToPaise(seatCost.costPerSeatMonth * 12),
      seats:              1,
      remainingDays:      chargeDays,
      termDays:           input.termDays,
      taxRatePct:         0,
    }).subtotalPaise,
  );

  // Allocate quote number
  const { data: nextNumber, error: numErr } = await input.supabase.rpc("next_document_number", {
    p_doc_type:  "quote",
    p_tenant_id: input.tenantId,
  });
  if (numErr || !nextNumber) {
    return { ok: false, code: "no_doc_number", message: numErr?.message ?? "Could not allocate quote number" };
  }
  const newQuoteId = nextNumber as unknown as string;

  const lineItems: QuoteLineItem[] = [{
    id:         "add-seats-1",
    /* R-800: the line names the period charged, so the invoice built from this quote says
       which dates the seats are billed for — "from" is the effective date. */
    name:       `${input.plan} · +${input.additionalSeats} seats (pro-rata from ${effective} to ${chargeTo})`,
    qty:        input.additionalSeats,
    rate:       proRataPerSeat,
    cost:       wholesalePerSeat,
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
    seats:            input.additionalSeats,
    amount:           totalInclGst,
    status:           "sent",
    payment_status:   "awaiting",
    owner_id:         null,
    /* R-025 — same UTC trap as the renewal and extension quotes beside it. `validUntil`
       is built from a YYYY-MM-DD at UTC midnight plus whole days, so no shift there. */
    created_date:     istToday(),
    expires_date:     utcDateISO(validUntil),
    line_items:       lineItems,
    subtotal:         subtotalExGst,
    total_cost:       wholesalePerSeat * input.additionalSeats,
    discount_pct:     0,
    // The customer's actual rate, not a hardcoded 18 — a zero-rated export quote
    // must SAY zero, or the PDF and the GST return disagree with the amount.
    tax_rate:         input.taxRatePct,
    is_renewal:       false,
    is_add_seats:     true,   // 0052: record_payment skips sub handling → no duplicate sub
    extension_months: 0,
    // factorPpm is an integer (547945 = 54.7945%), so the note records the exact
    // fraction charged instead of a rounded float that cannot be reconciled.
    notes:            `Add-seats pro-rata for subscription ${input.subscriptionId}. Effective date ${effective}${
      effective < today ? ` (backdated${input.effectiveDateSetBy ? ` by ${input.effectiveDateSetBy}` : ""} on ${today})` : ""
    }${input.chargeWindow ? ` (this instalment, to ${chargeTo}; later instalments carry the new seats)` : ""}. ${charge.chargedDays} of ${input.termDays} days remaining (factor ${(charge.factorPpm / 10_000).toFixed(4)}%). ${input.taxLabel ?? `GST ${input.taxRatePct}%`}.`,
  });
  if (insertErr) {
    return { ok: false, code: "insert_failed", message: insertErr.message };
  }

  // Update subscription seats + MRR immediately — operator has decided
  // to provision the additional seats now. Customer pays via normal quote flow.
  const newSeats = input.currentSeats + input.additionalSeats;
  const newMrr   = priced.newMrr;

  const { error: subErr } = await input.supabase
    .from("subscriptions")
    .update({ seats: newSeats, mrr: newMrr })
    .eq("id", input.subscriptionId);
  if (subErr) {
    return { ok: false, code: "sub_update_failed", message: subErr.message };
  }

  // ── Auto-create draft Purchase Order for the additional seats ─────
  // term_months ≈ days remaining / 30 — gives pro-rata months for Google.
  let poId: string | null = null;
  try {
    /* Uses the SAME resolved cost as the quote line above. It used to run its own
       lookup — `.ilike("name", plan).limit(1)` with no vendor filter, so a plan named
       just "Standard" could take the hosting row's ₹0 and write a ₹0 PO for a Google
       seat. One resolution, one number, both records. */
    const unitCostPm = seatCost.costPerSeatMonth;

    const termMonths     = Math.max(1, Math.round(days / 30));
    const totalCost      = unitCostPm * input.additionalSeats * termMonths;

    const { data: poNumber } = await input.supabase.rpc("next_document_number", {
      p_doc_type:  "purchase_order",
      p_tenant_id: input.tenantId,
    });
    if (poNumber) {
      const newPoId = poNumber as unknown as string;
      const { error: poErr } = await input.supabase.from("purchase_orders").insert({
        id:               newPoId,
        tenant_id:        input.tenantId,
        subscription_id:  input.subscriptionId,
        customer_id:      input.customerId,
        customer_name:    input.customerName,
        domain:           input.domain,
        vendor:           input.vendor,
        plan:             input.plan,
        seats:            input.additionalSeats,
        term_months:      termMonths,
        unit_cost_pm:     unitCostPm,
        total_cost:       totalCost,
        status:           "draft",
        /* The note says where the cost came from. This PO goes to a distributor; if
           the figure was estimated rather than read from the catalog, the person
           reconciling it against the real invoice needs to know that before they
           conclude the invoice is wrong. */
        notes:            `Auto-created for +${input.additionalSeats} seats added mid-term (pro-rata ${days} days). Quote ${newQuoteId}. Unit cost ₹${unitCostPm}/seat/mo ${
          seatCost.source === "catalog"
            ? "from catalog."
            : `ESTIMATED at ${Math.round((1 - HEURISTIC_MARGIN) * 100)}% margin — no catalog price for "${input.plan}", verify before sending.`
        }`,
      });
      if (!poErr) poId = newPoId;
    }
  } catch {
    // PO is best-effort — don't fail the add-seats flow if procurement
    // side has an issue. Operator can manually create a PO from /purchase-orders.
  }

  return {
    ok:          true,
    quoteId:     newQuoteId,
    amount:      totalInclGst,
    proRataDays: chargeDays,
    effectiveDate: effective,
    newSeats,
    newMrr,
    poId,
  };
}
