/**
 * Typed calls to the money functions that live in Postgres.
 *
 * The 185 SECURITY DEFINER functions stay in the database on purpose: they hold the rules
 * that must be atomic (gapless invoice numbers per tenant per FY — CGST Rule 46(b), the
 * s.34(2) credit-note window, whole-rupee amounts) and they are already covered by
 * supabase/tests/*.test.sql. Porting them would re-prove all of that for no security gain.
 *
 * Each wrapper takes the `tx` from withTenant(), so current_tenant_id() inside the function
 * sees this request's user — and the function call shares the transaction with whatever else
 * the caller does. Arguments are cast to the exact SQL type so Postgres resolves the right
 * overload and never coerces a float into a rupee column.
 */
import "server-only";
import type { Tx } from "./index";
import { rupees } from "./money";

export interface RecordPaymentArgs {
  quoteId: string;
  /** Whole rupees. */
  amount: number;
  method: string;
  reference: string;
  notes?: string | null;
}

/** public.record_payment(text, integer, text, text, text) → jsonb. The spine of the money flow. */
export async function recordPayment(tx: Tx, a: RecordPaymentArgs): Promise<unknown> {
  const rows = await tx.$queryRaw<{ result: unknown }[]>`
    select public.record_payment(
      ${a.quoteId}::text, ${rupees(a.amount)}::integer, ${a.method}::text,
      ${a.reference}::text, ${a.notes ?? null}::text) as result`;
  return rows[0]?.result;
}

/** public.next_document_number(text) — the only way a GST document gets its number (CLAUDE.md §17a). */
export async function nextDocumentNumber(tx: Tx, docType: string): Promise<string> {
  const rows = await tx.$queryRaw<{ n: string }[]>`select public.next_document_number(${docType}::text) as n`;
  const n = rows[0]?.n;
  if (!n) throw new Error(`next_document_number returned nothing for ${docType}`);
  return n;
}
