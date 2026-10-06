/**
 * R-220: reads the owner digest's facts for ONE tenant (the owner's), service-role.
 * Every read is filtered by tenant_id — the admin client bypasses RLS, so that filter is
 * the only tenant boundary here. Lists are paged (fetchAllRows): PostgREST stops at 1000
 * rows without saying so.
 */
import { addDaysISO, istDayStartUtc, istToday } from "@/lib/dates/ist";
import { fetchAllRows, type PageQuery } from "@/lib/ops/fetch-all";
import {
  heldSince, type DigestHeld, type DigestInvoice, type DigestPayment, type DigestProjectPayment,
  type DigestSub, type OwnerDigestInput,
} from "./owner-digest";

/** The slice of supabase-js used here (real client or lib/ops/fake-postgrest in tests). */
interface Q<T> extends PageQuery<T> {
  select(cols: string, o?: { count?: "exact"; head?: boolean }): Q<T>;
  eq(col: string, v: unknown): Q<T>;
  in(col: string, vs: readonly unknown[]): Q<T>;
  gte(col: string, v: string): Q<T>;
  lt(col: string, v: string): Q<T>;
  order(col: string, o?: { ascending?: boolean }): Q<T>;
  range(from: number, to: number): Q<T>;
}
export interface DigestDb {
  from<T = Record<string, unknown>>(table: string): Q<T>;
}

export async function loadOwnerDigestFacts(db: DigestDb, tenantId: string, now: Date): Promise<OwnerDigestInput> {
  const today = istToday(now);
  const yesterday = addDaysISO(today, -1);
  const fromInstant = istDayStartUtc(yesterday).toISOString();
  const toInstant = istDayStartUtc(today).toISOString();
  const heldFrom = istDayStartUtc(heldSince(now)).toISOString();

  const [payments, projectPayments, invoices, held, subscriptions, quotes] = await Promise.all([
    fetchAllRows<DigestPayment>((a, b) => db.from<DigestPayment>("payments")
      .select("status, amount, received_at")
      .eq("tenant_id", tenantId).eq("status", "received")
      .gte("received_at", fromInstant).lt("received_at", toInstant)
      .order("id", { ascending: true }).range(a, b)),
    fetchAllRows<DigestProjectPayment>((a, b) => db.from<DigestProjectPayment>("project_payments")
      .select("amount, received_at")
      .eq("tenant_id", tenantId)
      .gte("received_at", yesterday).lt("received_at", today)
      .order("id", { ascending: true }).range(a, b)),
    fetchAllRows<DigestInvoice>((a, b) => db.from<DigestInvoice>("invoices")
      .select("status, due_date, amount, net_payable, paid_amount")
      .eq("tenant_id", tenantId).in("status", ["pending", "overdue"])
      .order("id", { ascending: true }).range(a, b)),
    fetchAllRows<DigestHeld>((a, b) => db.from<DigestHeld>("ai_action_log")
      .select("created_at, reason")
      .eq("tenant_id", tenantId).eq("outcome", "held")
      .gte("created_at", heldFrom)
      .order("created_at", { ascending: false }).range(a, b)),
    fetchAllRows<DigestSub>((a, b) => db.from<DigestSub>("subscriptions")
      .select("status, renewal_date, mrr")
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true }).range(a, b)),
    db.from("quotes").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("approval_status", "pending") as unknown as PromiseLike<{ count: number | null; error: unknown }>,
  ]);
  if (quotes.error) throw quotes.error;

  return {
    now, payments, projectPayments, invoices, held, subscriptions,
    quotesAwaitingApproval: quotes.count ?? 0,
  };
}
