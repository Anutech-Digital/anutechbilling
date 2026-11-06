/**
 * R-2519 (Pardeep, 6 Nov 2026 — "Zoho ki tarah proforma bhejna") — what Renewals → "Bill next
 * part" will bill, BEFORE anything is saved (staging BITDECENTRO Q-A378-27-0947 was made in one
 * click at the stored 17 seats). The preview lists the next N periods with seats × the per-seat
 * rate, GST and any proforma a period already has; the owner may change seats / rate / N, then
 * Generate bills them (generate-renewal-quote) and set_part_request_terms writes the change on
 * the new proformas. The subscription itself changes only when a proforma is paid or accepted.
 *
 * Server-only (reads subscription_billings / quotes with the caller's admin client).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingCycle } from "@/lib/supabase/database.types";
import { followingTermStart } from "@/lib/billing/subscription-schedule";
import { addMonthsClamped, CYCLE_MONTHS } from "@/lib/billing/schedule";
import { defaultSeatRate, nextPeriods, partAmounts, partTaxRate, type BillNextPreview } from "@/lib/billing/proforma";
import { repriceUnbilledPart } from "@/lib/billing/sync-instalments.server";
export type { BillNextPreview, PreviewPeriod } from "@/lib/billing/proforma";

export interface BillNextSub {
  id: string;
  tenant_id: string;
  customer_id?: string | null;
  seats: number | null;
  mrr: number | null;
  billing_cycle: BillingCycle | null;
  term_months: number | null;
  term_amount?: number | null;
  start_date: string | null;
  renewal_date: string | null;
  billed_externally_until?: string | null;
}

interface BillingRow {
  id: string; period_start: string; period_end: string; taxable_amount: number; tax_rate: number | null; invoice_id: string | null;
  period_index: number;
}

/** The earliest period of this subscription with no tax invoice and no request — where billing goes on. */
/** `freed` (R-2519b): the row's proforma was cancelled — Bill next part bills that row itself. */
export async function firstUnbilledPeriod(db: SupabaseClient, sub: BillNextSub): Promise<{ start: string; row: BillingRow | null; rows: BillingRow[]; freed: boolean }> {
  const { data, error } = await db.from("subscription_billings")
    .select("id, period_start, period_end, taxable_amount, tax_rate, invoice_id, period_index")
    .eq("subscription_id", sub.id).order("period_start", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as BillingRow[];
  const open = rows.filter((r) => r.invoice_id == null);
  const requested = new Set<string>();
  const cancelledOn = new Set<string>();
  if (open.length > 0) {
    const { data: reqs, error: rErr } = await db.from("quotes").select("subscription_billing_id").in("subscription_billing_id", open.map((r) => r.id));
    if (rErr) throw new Error(rErr.message);
    for (const q of (reqs ?? []) as { subscription_billing_id: string }[]) requested.add(q.subscription_billing_id);
    const { data: gone, error: gErr } = await db.from("quotes").select("cancelled_part_billing_id").in("cancelled_part_billing_id", open.map((r) => r.id));
    if (gErr) throw new Error(gErr.message);
    for (const q of (gone ?? []) as { cancelled_part_billing_id: string }[]) cancelledOn.add(q.cancelled_part_billing_id);
  }
  const free = open.find((r) => !requested.has(r.id));
  if (free) return { start: free.period_start, row: free, rows, freed: cancelledOn.has(free.id) };
  const following = sub.renewal_date ? followingTermStart({ ...sub, term_months: sub.term_months ?? 12 }) : (sub.start_date ?? "");
  /* The current term was never laid (and not billed elsewhere) → it starts there, not after it. */
  const termStart = addMonthsClamped(following, -Math.max(1, sub.term_months ?? 12));
  const laidInTerm = rows.some((r) => r.period_start >= termStart);
  const elsewhere = sub.billed_externally_until && sub.billed_externally_until >= termStart;
  if (!laidInTerm && !elsewhere && rows.length > 0) return { start: termStart, row: null, rows, freed: false };
  return { start: following, row: null, rows, freed: false };
}

/** The preview (writes nothing). */
export async function billNextPreview(db: SupabaseClient, sub: BillNextSub, count: number): Promise<BillNextPreview> {
  const cycle = (sub.billing_cycle ?? "monthly") as BillingCycle;
  const { start, row, rows } = await firstUnbilledPeriod(db, sub);
  const months = CYCLE_MONTHS[cycle];
  const parts = sub.term_months && sub.term_months % months === 0 ? sub.term_months / months : null;
  /* R-2541: the free part at the subscription's CURRENT seats × rate — what Generate and the billing job
     bill it at (repriceUnbilledPart, dry run: nothing written), not the amount stored when it was laid. */
  const repriced = row ? await repriceUnbilledPart(db as Parameters<typeof repriceUnbilledPart>[0], row.id, true) : null;
  const partTaxable = repriced?.to ?? row?.taxable_amount
    ?? (sub.term_amount && parts ? Math.round(sub.term_amount / parts) : Math.round((sub.mrr ?? 0) * months));
  const seats = Math.max(0, sub.seats ?? 0);
  /* The customer's country decides as in bill_subscription_instalment: outside India → 0%. */
  const country = sub.customer_id
    ? ((await db.from("customers").select("country").eq("id", sub.customer_id).maybeSingle()).data as { country?: string | null } | null)?.country ?? null
    : null;
  const taxRate = partTaxRate(country, row?.tax_rate ?? rows[rows.length - 1]?.tax_rate ?? 18);
  const seatRate = defaultSeatRate({ seats, partTaxable });
  const periods = nextPeriods({ cycle, firstStart: start, count });

  /* What each listed period already has (BITDECENTRO: 12 Oct–11 Nov already had Q-0947). */
  const byStart = new Map(rows.map((r) => [r.period_start, r]));
  const rowIds = periods.map((p) => byStart.get(p.start)?.id).filter((x): x is string => !!x);
  const reqOf = new Map<string, { id: string; status: string; amount: number | null }>();
  if (rowIds.length > 0) {
    const { data: reqs, error } = await db.from("quotes").select("id, status, amount, subscription_billing_id").in("subscription_billing_id", rowIds);
    if (error) throw new Error(error.message);
    for (const q of (reqs ?? []) as { id: string; status: string; amount: number | null; subscription_billing_id: string }[]) {
      reqOf.set(q.subscription_billing_id, { id: q.id, status: q.status, amount: q.amount });
    }
  }
  return {
    cycle, seats, seatRate, partTaxable, taxRate,
    amounts: seatRate != null ? partAmounts({ seats, seatRate, taxRate }) : { taxable: partTaxable, tax: Math.round(partTaxable * taxRate / 100), gross: partTaxable + Math.round(partTaxable * taxRate / 100) },
    firstStart: start,
    periods: periods.map((p) => {
      const r = byStart.get(p.start);
      const req = r ? reqOf.get(r.id) : undefined;
      return {
        ...p,
        existing: r?.invoice_id ? { kind: "invoice", id: r.invoice_id, status: "invoiced", amount: null }
          : req ? { kind: "request", ...req } : null,
      };
    }),
  };
}

/** The day the billing run treats as "today" so the first `count` periods are all due: the last one's start (never before today). */
export function billThroughDay(firstStart: string, cycle: BillingCycle, count: number, todayISO: string): string {
  const last = addMonthsClamped(firstStart, Math.max(0, count - 1) * CYCLE_MONTHS[cycle]);
  return last > todayISO ? last : todayISO;
}
