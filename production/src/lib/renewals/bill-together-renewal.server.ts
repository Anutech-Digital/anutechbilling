/**
 * R-2849 (R-2809c) — "Bill together" for YEARLY subscriptions: ONE renewal quote renewing 2+ yearly subscriptions of one
 * customer, a line per subscription's next term, made by R-2847's create_renewal_quote_together (paid in full, R-2848's
 * record_payment renews each one by its own term). The DATABASE half; the pure rules (which can join, the lines, the
 * total) are in ./bill-together-preview.ts, the route is /api/renewals/bill-together.
 *
 * Pricing: each subscription's renewal is priced by priceRenewalQuote (./create-renewal-quote.ts) — the ONE renewal
 * pricing the cron, Send now and Review renewal quote use (catalogue price, R-2583 scheduled seat cut, export 0%, cost) —
 * never a second copy. The RPC re-checks every money fact it can and computes the quote's total and GST itself.
 *
 * Clients, on purpose:
 * - READS of the subscriptions / their renewal quotes go through the signed-in (cookie) client, company-filtered.
 * - Pricing reads (tenant GST registration, customer country, catalogue, seat cuts) use the actor-stamped admin client,
 *   as Generate / Review renewal quote do — only for subscriptions the cookie read already found in the company.
 * - create_renewal_quote_together is called through the signed-in client: the RPC checks the role and the company.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { followingTermStart } from "@/lib/billing/subscription-schedule";
import { lineServicePeriod } from "@/lib/quotes/service-period";
import { renewalIsSettled, firstReminderDaysOut } from "./cadence";
import { priceRenewalQuote, type PricedRenewal } from "./create-renewal-quote";
import type { BillTogetherLine } from "./bill-together";
import type { TogetherRenewalFacts } from "./bill-together-preview";
import { rpcRefusal, type TogetherReadFact, type TogetherSubRow } from "./bill-together.server";

/** A read fact plus (yearly) the renewal facts and the priced `quote` the RPC takes for it. */
export type RenewalReadFact = TogetherReadFact & { renewal?: TogetherRenewalFacts | null; renewalQuote?: Record<string, unknown> | null };

/** The yearly renewal can be priced at all (the preview names any other reason without pricing it). */
function priceable(s: TogetherSubRow): boolean {
  return s.status === "active" && s.auto_renew !== false && !!s.renewal_date && s.billing_cycle === "yearly" && (s.term_months ?? 12) === 12;
}

/** "Already renewed — …" (Generate renewal quote's own words, R-1562), or null. */
function settledText(s: TogetherSubRow, now: Date): string | null {
  if (!renewalIsSettled(s.renewal_state, s.renewal_date, s.term_months, now)) return null;
  return `Already renewed — the next term's renewal quote opens ${firstReminderDaysOut(s.term_months)} days before ${s.renewal_date!.slice(0, 10)}.`;
}

/**
 * The period one renewal line covers — the SAME rule the quote page / PDF print (lineServicePeriod with billing's
 * followingTermStart, R-2727) and R-2848's invoice stamp uses: an app-made subscription's next term starts ON its
 * renewal date, a last-day (imported) one the day after; 12 months.
 */
export function renewalLinePeriod(s: Pick<TogetherSubRow, "renewal_date" | "start_date" | "term_months">): { start: string; end: string } | null {
  const rtd = s.renewal_date?.slice(0, 10);
  if (!rtd) return null;
  const renewalStart = s.start_date ? followingTermStart({ term_months: s.term_months ?? 12, start_date: s.start_date, renewal_date: rtd }) : null;
  const p = lineServicePeriod({ commitment: "annual_yearly" }, { isRenewal: true, extensionMonths: 12, renewalTermDate: rtd, ...(renewalStart ? { renewalStart } : {}) });
  return p ? { start: p.from, end: p.to } : null;
}

/** The dialog's line for a priced renewal (₹ — the RPC stores whole rupees; GST per line shown, the total's GST is on the sum). */
export function renewalLineOf(priced: PricedRenewal, period: { start: string; end: string }): BillTogetherLine {
  const tax = Math.round((priced.subtotal * priced.taxRate) / 100);
  return {
    seats: priced.seats, seatRate: priced.perSeatRate, periodStart: period.start, periodEnd: period.end,
    taxable: priced.subtotal, taxRate: priced.taxRate, tax, gross: priced.subtotal + tax,
  };
}

interface LinkedQuote { id: string; status: string | null; cancelled_at: string | null; superseded_by: string | null }

/** Each asked subscription's renewal_quote_id → is that quote still open, and which subscriptions it renews together. */
async function readLinkedRenewals(db: SupabaseClient, tenantId: string, subs: readonly TogetherSubRow[]):
  Promise<Map<string, NonNullable<TogetherRenewalFacts["linked"]>>> {
  const out = new Map<string, NonNullable<TogetherRenewalFacts["linked"]>>();
  const quoteIds = [...new Set(subs.map((s) => s.renewal_quote_id).filter((q): q is string => !!q))];
  if (quoteIds.length === 0) return out;
  const [{ data: qs, error: qErr }, { data: links, error: lErr }] = await Promise.all([
    db.from("quotes").select("id, status, cancelled_at, superseded_by").eq("tenant_id", tenantId).in("id", quoteIds),
    db.from("renewal_quote_subscriptions").select("quote_id, subscription_id").eq("tenant_id", tenantId).in("quote_id", quoteIds).is("released_at", null),
  ]);
  if (qErr) throw new Error(qErr.message);
  /* the link table is R-2847's — a server without it has no together quote (every link is a single quote) */
  if (lErr && !/renewal_quote_subscriptions/i.test(lErr.message)) throw new Error(lErr.message);
  const members = new Map<string, string[]>();
  for (const l of ((lErr ? [] : links) ?? []) as Array<{ quote_id: string; subscription_id: string }>) {
    members.set(l.quote_id, [...(members.get(l.quote_id) ?? []), l.subscription_id]);
  }
  const others = [...new Set([...members.values()].flat())].filter((id) => !subs.some((s) => s.id === id));
  const planOf = new Map(subs.map((s) => [s.id, s.plan]));
  if (others.length > 0) {
    const { data: o, error } = await db.from("subscriptions").select("id, plan").eq("tenant_id", tenantId).in("id", others);
    if (error) throw new Error(error.message);
    for (const r of (o ?? []) as Array<{ id: string; plan: string | null }>) planOf.set(r.id, r.plan);
  }
  const quoteOf = new Map(((qs ?? []) as LinkedQuote[]).map((q) => [q.id, q]));
  for (const s of subs) {
    if (!s.renewal_quote_id) continue;
    const q = quoteOf.get(s.renewal_quote_id);
    /* not readable = treated as open (the RPC decides; never offered as free on an unknown) */
    const live = !q || (q.cancelled_at == null && q.superseded_by == null && !["rejected", "expired"].includes(q.status ?? ""));
    const ids = members.get(s.renewal_quote_id) ?? [];
    out.set(s.id, {
      quoteId: s.renewal_quote_id, live, subscriptionIds: ids,
      withPlans: ids.filter((id) => id !== s.id).map((id) => planOf.get(id) ?? "another subscription"),
    });
  }
  return out;
}

/**
 * Each yearly subscription's renewal: the renewal quote it is already linked to, whether it is already renewed, and —
 * when it could join — its price (priceRenewalQuote) and line. `admin` = the actor-stamped admin client (pricing reads).
 * A price that cannot be worked out says why in plain words (the raw text stays in the server log).
 */
export async function fillRenewalLines(db: SupabaseClient, admin: SupabaseClient, tenantId: string, facts: readonly TogetherReadFact[],
  now: Date = new Date()): Promise<RenewalReadFact[]> {
  const rows = facts.map((f) => f.row).filter((r): r is TogetherSubRow => !!r && priceable(r));
  if (rows.length === 0) return facts.map((f) => ({ ...f }));
  const linked = await readLinkedRenewals(db, tenantId, rows);
  const needPrice = rows.filter((r) => !(linked.get(r.id)?.live ?? false) && !settledText(r, now));
  let graceDays = 0;
  if (needPrice.length > 0) {
    const { data: t, error } = await admin.from("tenants").select("grace_period_days").eq("id", tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    graceDays = (t as { grace_period_days?: number | null } | null)?.grace_period_days ?? 0;
  }
  const priced = new Map(await Promise.all(needPrice.map(async (s) => {
    try {
      const r = await priceRenewalQuote({
        supabase: admin as unknown as SupabaseClient<Database>,
        subscriptionId: s.id, tenantId, customerId: s.customer_id ?? null, customerName: s.customer_name ?? "",
        plan: s.plan ?? "", itemId: s.item_id ?? null, vendor: s.vendor ?? null, seats: s.seats ?? 0, mrr: s.mrr ?? 0,
        termMonths: s.term_months ?? null, termAmount: s.term_amount ?? null, renewalDate: s.renewal_date!, graceDays,
      });
      return [s.id, r] as const;
    } catch (e) {
      console.warn(`[bill-together] renewal of ${s.id} not priced: ${e instanceof Error ? e.message : String(e)}`);
      return [s.id, { ok: false as const, reason: "its price data could not be read" }] as const;
    }
  })));

  return facts.map((f) => {
    const s = f.row;
    if (!s || !priceable(s)) return { ...f };
    const p = priced.get(s.id);
    const period = renewalLinePeriod(s);
    const ok = p?.ok ? p : null;
    const renewal: TogetherRenewalFacts = {
      line: ok && period ? renewalLineOf(ok, period) : null,
      priceError: p && !p.ok ? plainPriceError(p.reason) : null,
      settled: settledText(s, now),
      linked: linked.get(s.id) ?? null,
    };
    return { ...f, renewal, renewalQuote: ok ? ok.pQuote : null };
  });
}

/** renewalTerm's / the seat-cut read's reason is for the log; the screen gets a short plain phrase. */
function plainPriceError(reason: string): string {
  if (/seat cut/i.test(reason)) return "its scheduled seat cuts could not be read";
  if (/price data/i.test(reason)) return reason;
  return "its stored price does not match its plan's catalogue price";
}

/** What create_renewal_quote_together (R-2847) answers. */
export interface RenewalTogetherResult {
  quote_id: string;
  created?: boolean;
  already_existed?: boolean;
  relinked?: boolean;
  subscription_ids?: string[];
}

type RpcError = { code?: string; message: string };

/** ONE renewal quote for these parts ([{subscription_id, quote}], the asked order — the first leads the quote's name). */
export async function createRenewalQuoteTogether(db: SupabaseClient, tenantId: string,
  parts: ReadonlyArray<{ subscription_id: string; quote: Record<string, unknown> }>):
  Promise<{ data: RenewalTogetherResult | null; error: RpcError | null }> {
  const { data, error } = await db.rpc("create_renewal_quote_together", { p_tenant_id: tenantId, p_parts: parts });
  return { data: (data as RenewalTogetherResult | null) ?? null, error: error ? { code: error.code, message: error.message } : null };
}

export const RENEWAL_TOGETHER_NOT_READY = "One renewal quote for several yearly subscriptions is not ready on this server yet — make each renewal quote on its own (Review renewal quote on its row) for now.";

/** The RPC's refusal → status + the sentence to show. 0A000 (R-2847's "not ready" gate) and a missing RPC → 503 plain
 *  words; a seat-cut mismatch (check_violation, R-2613) → 409 with the RPC's own sentence; the rest as bill_parts_together. */
export function renewalRpcRefusal(e: RpcError): { status: number; error: string } | null {
  if (e.code === "0A000" || e.code === "42883" || e.code === "PGRST202") return { status: 503, error: RENEWAL_TOGETHER_NOT_READY };
  if (e.code === "23514") return { status: 409, error: e.message };
  return rpcRefusal(e);
}

/**
 * May this login make a together renewal quote on this database? Asked before pricing / creating. An empty list makes
 * the RPC refuse ("pick at least two", 22023) after its login, role and not-ready checks — without writing anything.
 */
export async function renewalTogetherReady(db: SupabaseClient, tenantId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { error } = await createRenewalQuoteTogether(db, tenantId, []);
  if (error && ["0A000", "42883", "PGRST202", "42501", "28000"].includes(error.code ?? "")) {
    const r = renewalRpcRefusal(error);
    if (r) return { ok: false, ...r };
  }
  return { ok: true };
}
