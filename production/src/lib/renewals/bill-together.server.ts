/**
 * R-2807 — the DATABASE half of /api/renewals/bill-together (pure rules: ./bill-together-preview.ts).
 *
 * Clients, on purpose:
 * - READS go through the signed-in (cookie) client and are filtered to the caller's company — an id of another
 *   company is simply not found (reason "not_found"), never an error.
 * - bill_parts_together (R-2810) is called through the signed-in client: the RPC checks the role and the
 *   company from the login itself (SECURITY DEFINER), and stamps the proforma with that user.
 * - LAYING a part (subscription_billings insert + its R-2735 renews_from/to mark) needs the service role — that
 *   table has a select policy only (as Bill next part / the billing job lay it). It is done ONLY for a
 *   subscription the cookie read already found in the caller's company, with the actor-stamped admin client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingCycle } from "@/lib/supabase/database.types";
import { billNextPreview, type BillNextSub } from "./bill-next.server";
import { nextTermRenewalDate } from "./split-billed-renewal";
import { followingTermStart } from "@/lib/billing/subscription-schedule";
import { isSplitBilled } from "@/lib/billing/instalments";
import { syncSubscriptionInstalments, readQuotePaymentFacts, unbilledPartPrice, INSTALMENT_SUB_SELECT, type InstalmentSub } from "@/lib/billing/sync-instalments.server";
import type { TermRoll } from "./pay-to-renew";
import type { TogetherFact, TogetherSaleFacts } from "./bill-together-preview";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TOGETHER_SUB_SELECT =
  "id, tenant_id, customer_id, customer_name, plan, seats, mrr, billing_cycle, term_months, term_amount, start_date, renewal_date, renewal_quote_id, status, auto_renew, billed_externally_until, quote_id, "
  /* R-2849: what a yearly renewal is priced from (priceRenewalQuote) and the already-renewed check */
  + "item_id, vendor, domain, renewal_state";

export interface TogetherSubRow extends BillNextSub {
  customer_name: string | null;
  plan: string | null;
  renewal_quote_id: string | null;
  status: string | null;
  auto_renew: boolean | null;
  quote_id: string | null;
  /* R-2849 (yearly renewal pricing) */
  item_id?: string | null;
  vendor?: string | null;
  domain?: string | null;
  renewal_state?: string | null;
}

/** A fact plus what POST needs to lay the part (the subscription row as read). */
export type TogetherReadFact = TogetherFact & { row: TogetherSubRow | null };

interface LiveQuote { id: string; status: string; subscription_billing_id: string | null; line_items: unknown }

/** The billing ids a part request names: its lead part and every line's billing_id. */
export function requestBillingIds(q: Pick<LiveQuote, "subscription_billing_id" | "line_items">): string[] {
  const out = new Set<string>();
  if (q.subscription_billing_id) out.add(q.subscription_billing_id);
  if (Array.isArray(q.line_items)) {
    for (const l of q.line_items as Array<{ billing_id?: unknown }>) {
      if (typeof l?.billing_id === "string" && l.billing_id) out.add(l.billing_id);
    }
  }
  return [...out];
}

/**
 * The subscriptions and the live together proformas their unbilled parts are on, read with the signed-in client,
 * for the asked ids in their order. `next` is NOT filled here (fillNextParts) — POST first checks a double
 * submit from this cheap read.
 */
export async function readTogetherFacts(db: SupabaseClient, tenantId: string, ids: readonly string[]): Promise<TogetherReadFact[]> {
  const uuids = ids.filter((id) => UUID.test(id));
  const { data: subRows, error } = uuids.length > 0
    ? await db.from("subscriptions").select(TOGETHER_SUB_SELECT).eq("tenant_id", tenantId).in("id", uuids)
    : { data: [], error: null };
  if (error) throw new Error(error.message);
  const subs = new Map(((subRows ?? []) as TogetherSubRow[]).map((s) => [s.id, s]));

  /* Each asked subscription's oldest part with no tax invoice — what a double submit's proforma would hold. */
  const earliestOpen = new Map<string, string>();
  if (subs.size > 0) {
    const { data: open, error: oErr } = await db.from("subscription_billings").select("subscription_id, period_start")
      .eq("tenant_id", tenantId).in("subscription_id", [...subs.keys()]).is("invoice_id", null);
    if (oErr) throw new Error(oErr.message);
    for (const r of (open ?? []) as Array<{ subscription_id: string; period_start: string }>) {
      const had = earliestOpen.get(r.subscription_id);
      if (!had || r.period_start < had) earliestOpen.set(r.subscription_id, r.period_start);
    }
  }

  /* Live together proformas of these customers: a live part request naming 2+ parts (R-2810's shape). */
  const customers = [...new Set([...subs.values()].map((s) => s.customer_id).filter((c): c is string => !!c))];
  const togetherOf = new Map<string, Array<{ quote: LiveQuote; subscriptionIds: string[]; partPeriodStart: string }>>();
  if (customers.length > 0) {
    const { data: qs, error: qErr } = await db.from("quotes")
      .select("id, status, subscription_billing_id, line_items")
      .eq("tenant_id", tenantId).in("customer_id", customers)
      .not("subscription_billing_id", "is", null)
      .is("cancelled_at", null).is("invoice_id", null).is("superseded_by", null)
      .not("status", "in", "(rejected,expired)");
    if (qErr) throw new Error(qErr.message);
    const together = ((qs ?? []) as LiveQuote[]).map((q) => ({ q, parts: requestBillingIds(q) })).filter((x) => x.parts.length >= 2)
      .sort((a, b) => a.q.id.localeCompare(b.q.id));
    const partIds = [...new Set(together.flatMap((x) => x.parts))];
    if (partIds.length > 0) {
      const { data: parts, error: pErr } = await db.from("subscription_billings")
        .select("id, subscription_id, invoice_id, period_start").eq("tenant_id", tenantId).in("id", partIds);
      if (pErr) throw new Error(pErr.message);
      const partOf = new Map(((parts ?? []) as Array<{ id: string; subscription_id: string; invoice_id: string | null; period_start: string }>)
        .filter((p) => p.invoice_id == null).map((p) => [p.id, p]));
      for (const { q, parts: ps } of together) {
        const onIt = ps.map((p) => partOf.get(p)).filter((p): p is NonNullable<typeof p> => !!p);
        const subIds = [...new Set(onIt.map((p) => p.subscription_id))];
        for (const p of onIt) {
          const list = togetherOf.get(p.subscription_id) ?? [];
          list.push({ quote: q, subscriptionIds: subIds, partPeriodStart: p.period_start });
          togetherOf.set(p.subscription_id, list);
        }
      }
    }
  }
  const otherSubIds = [...new Set([...togetherOf.values()].flat().flatMap((t) => t.subscriptionIds))].filter((s) => !subs.has(s));
  const planOf = new Map([...subs.values()].map((s) => [s.id, s.plan]));
  if (otherSubIds.length > 0) {
    const { data: others, error: oErr } = await db.from("subscriptions").select("id, plan").eq("tenant_id", tenantId).in("id", otherSubIds);
    if (oErr) throw new Error(oErr.message);
    for (const o of (others ?? []) as Array<{ id: string; plan: string | null }>) planOf.set(o.id, o.plan);
  }

  return ids.map((id) => {
    const s = subs.get(id) ?? null;
    if (!s) return { id, sub: null, next: null, togetherBills: [], row: null };
    const togetherBills = (togetherOf.get(s.id) ?? []).map((t) => ({
      quoteId: t.quote.id, status: t.quote.status, subscriptionIds: t.subscriptionIds, partPeriodStart: t.partPeriodStart,
      earliestOpen: earliestOpen.get(s.id) === t.partPeriodStart,
      withPlans: t.subscriptionIds.filter((x) => x !== s.id).map((x) => planOf.get(x) ?? "another subscription"),
    }));
    return { id, sub: s, next: null, togetherBills, row: s };
  });
}

interface SaleSubRow { id: string; plan: string | null; quote_id: string | null; status: string | null; billing_cycle: string | null;
  start_date: string | null; mrr: number | null; billed_externally_until: string | null }

const day = (d: string | null | undefined) => (d ? d.slice(0, 10) : null);

/**
 * R-2831 — what bill_parts_together's sale-quote refusals read (R-2810 §2), for each billable subscription sold on
 * a sale quote, at the next part the preview found: that part as laid (first part of a sale), the sub's earliest
 * term, and the other subscriptions of the sale quote with their unbilled parts' starts (R-2092 "tick it too") and,
 * for the ones the RPC counts (same cycle, active, not yearly, started, MRR > 0), whether any part is laid. Signed-in
 * client, company-filtered. Every read is bounded: the parts AT the next periods, one earliest-term row per sub, the
 * siblings' UNBILLED parts, and a one-row existence check only for a counted sibling with no unbilled part.
 */
async function readSaleFacts(db: SupabaseClient, tenantId: string, facts: readonly TogetherReadFact[]): Promise<Map<string, TogetherSaleFacts>> {
  const out = new Map<string, TogetherSaleFacts>();
  const sold = facts.filter((f) => !!f.row?.quote_id && !!f.next).map((f) => ({ row: f.row!, start: f.next!.periodStart }));
  if (sold.length === 0) return out;
  const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

  const { data: sibRows, error: sErr } = await db.from("subscriptions")
    .select("id, plan, quote_id, status, billing_cycle, start_date, mrr, billed_externally_until")
    .eq("tenant_id", tenantId).in("quote_id", [...new Set(sold.map((s) => s.row.quote_id!))]);
  fail(sErr);
  const sameSale = (sibRows ?? []) as SaleSubRow[];
  const soldIds = sold.map((s) => s.row.id);
  const sibIds = sameSale.map((s) => s.id).filter((id) => !soldIds.includes(id));

  const [atNext, open, firstTerms] = await Promise.all([
    db.from("subscription_billings").select("subscription_id, period_start, period_index, term_start, credited_invoice_ids")
      .eq("tenant_id", tenantId).in("subscription_id", soldIds).in("period_start", [...new Set(sold.map((s) => s.start))]),
    db.from("subscription_billings").select("subscription_id, period_start")
      .eq("tenant_id", tenantId).in("subscription_id", [...soldIds, ...sibIds]).is("invoice_id", null),
    Promise.all(sold.map(async (s) => {
      const { data, error } = await db.from("subscription_billings").select("term_start")
        .eq("tenant_id", tenantId).eq("subscription_id", s.row.id).order("term_start", { ascending: true }).limit(1);
      fail(error);
      return [s.row.id, day((data as Array<{ term_start: string | null }> | null)?.[0]?.term_start)] as const;
    })),
  ]);
  fail(atNext.error); fail(open.error);
  const openOf = new Map<string, string[]>();
  for (const p of (open.data ?? []) as Array<{ subscription_id: string; period_start: string }>) {
    openOf.set(p.subscription_id, [...(openOf.get(p.subscription_id) ?? []), day(p.period_start)!]);
  }
  const firstTermOf = new Map(firstTerms);

  /* R-2092 counts a sibling only like the RPC: active, same cycle, billed in parts, started, MRR > 0. */
  const counted = (o: SaleSubRow, me: TogetherSubRow) => o.status === "active" && o.billing_cycle === me.billing_cycle
    && !!o.billing_cycle && o.billing_cycle !== "yearly" && !!o.start_date && (o.mrr ?? 0) > 0;
  const needLaid = [...new Set(sold.flatMap((s) => sameSale.filter((o) => o.id !== s.row.id && o.quote_id === s.row.quote_id
    && counted(o, s.row) && !openOf.has(o.id)).map((o) => o.id)))];
  const laidIds = new Set<string>(openOf.keys());
  await Promise.all(needLaid.map(async (id) => {
    const { data, error } = await db.from("subscription_billings").select("id").eq("tenant_id", tenantId).eq("subscription_id", id).limit(1);
    fail(error);
    if ((data ?? []).length > 0) laidIds.add(id);
  }));

  for (const s of sold) {
    const own = ((atNext.data ?? []) as Array<{ subscription_id: string; period_start: string; period_index: number | null; term_start: string | null;
      credited_invoice_ids: string[] | null }>).find((p) => p.subscription_id === s.row.id && day(p.period_start) === s.start);
    out.set(s.row.id, {
      quoteId: s.row.quote_id!,
      startDate: day(s.row.start_date),
      termMonths: s.row.term_months ?? 12,
      firstTermStart: firstTermOf.get(s.row.id) ?? null,
      atNext: own ? { periodIndex: own.period_index, termStart: day(own.term_start), credited: (own.credited_invoice_ids ?? []).length > 0 } : null,
      siblings: sameSale.filter((o) => o.id !== s.row.id && o.quote_id === s.row.quote_id).map((o) => ({
        id: o.id, plan: o.plan, counted: counted(o, s.row), billedExternallyUntil: day(o.billed_externally_until),
        laidAny: laidIds.has(o.id), openPeriodStarts: openOf.get(o.id) ?? [] })),
    });
  }
  return out;
}

/**
 * Each billable subscription's next part — Bill next part's own preview (one period), all at once — and then
 * (R-2831) the sale-quote facts the RPC refuses on, read at those parts. A failed next part is logged and the sub
 * says so in plain words (the raw database text never reaches the screen).
 */
export async function fillNextParts(db: SupabaseClient, facts: TogetherReadFact[], tenantId: string): Promise<TogetherReadFact[]> {
  const filled = await Promise.all(facts.map(async (f) => {
    const s = f.row;
    if (!s || !isSplitBilled(s.billing_cycle as BillingCycle) || s.status !== "active" || s.auto_renew === false) return f;
    try {
      const pv = await billNextPreview(db, s, 1);
      const p = pv.periods[0];
      if (!p) return { ...f, nextError: "no period to bill" };
      return { ...f, next: { seats: pv.seats, seatRate: pv.seatRate, periodStart: p.start, periodEnd: p.end,
        taxable: pv.amounts.taxable, taxRate: pv.taxRate, tax: pv.amounts.tax, gross: pv.amounts.gross, unpaidEarlier: pv.unpaidEarlier } };
    } catch (e) {
      console.warn(`[bill-together] next part of ${s.id} not worked out: ${e instanceof Error ? e.message : String(e)}`);
      return { ...f, nextError: "its billing data could not be read" };
    }
  }));
  const saleOf = await readSaleFacts(db, tenantId, filled);
  return filled.map((f) => (f.row && saleOf.has(f.row.id) ? { ...f, sale: saleOf.get(f.row.id)! } : f));
}

/** Refusal the route shows as is (status + plain sentence). */
export class TogetherRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "TogetherRefusal"; }
}

/**
 * The roll a part starting `periodStart` carries (R-2735): when it lies in a term after the one renewal_date
 * closes, the subscription is billed AS IF renewed (`renewal_date` = that term's end) and the term's first part
 * is marked renews_from → renews_to; nothing is written to the subscription. Pure. The same walk as
 * firstUnbilledPeriod (bill-next.server.ts) — one term on per step, only forward; the callers have already
 * refused Won't renew and an open renewal quote (R-808), the two holds termToBill knows.
 */
export function virtualTermFor(sub: Pick<InstalmentSub, "billing_cycle" | "term_months" | "start_date" | "renewal_date">, periodStart: string):
  { renewalDate: string | null; roll: TermRoll | null } {
  let at = { ...sub, term_months: sub.term_months ?? 12 };
  let roll: TermRoll | null = null;
  for (let i = 0; i < 24 && at.renewal_date; i++) {
    if (followingTermStart(at) > periodStart) break;
    const to = nextTermRenewalDate(at);
    if (!to || to <= at.renewal_date.slice(0, 10)) break;
    roll = { from: at.renewal_date.slice(0, 10), to };
    at = { ...at, renewal_date: to };
  }
  return { renewalDate: at.renewal_date, roll };
}

/**
 * Lay this subscription's part starting `periodStart` (the one the preview showed — never "the first free one",
 * which after a racing request would be the NEXT period) and return its billing id. Idempotent: an already laid
 * part is returned (a freed part re-synced to today's seats × rate first, as the term run does — the figure the
 * preview showed); laying is keyed (subscription, term, period), so a racing lay is retried once.
 */
export async function layTogetherPart(admin: SupabaseClient, tenantId: string, read: TogetherSubRow, periodStart: string, todayISO: string): Promise<string> {
  const plan = read.plan ?? "A subscription";
  const find = async () => {
    const { data, error } = await admin.from("subscription_billings").select("id, invoice_id")
      .eq("tenant_id", tenantId).eq("subscription_id", read.id).eq("period_start", periodStart).order("id");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ id: string; invoice_id: string | null }>;
    const invoiced = rows.find((r) => r.invoice_id);
    if (invoiced) throw new TogetherRefusal(409, `${plan}'s part from ${periodStart} already has tax invoice ${invoiced.invoice_id} — refresh Renewals.`);
    if (rows.length > 1) throw new TogetherRefusal(409, `${plan} has two parts laid from ${periodStart} — use Bill next part on its row.`);
    return rows[0]?.id ?? null;
  };

  /* The holds the preview checked, read again right before writing (R-808 renewal quote, Won't renew). */
  const { data: fresh, error: fErr } = await admin.from("subscriptions").select(`${INSTALMENT_SUB_SELECT}, status, auto_renew, renewal_quote_id`)
    .eq("id", read.id).eq("tenant_id", tenantId).maybeSingle();
  if (fErr) throw new Error(fErr.message);
  const sub = fresh as (InstalmentSub & { status: string | null; auto_renew: boolean | null; renewal_quote_id: string | null }) | null;
  if (!sub || sub.status !== "active" || sub.auto_renew === false || sub.renewal_quote_id
      || (sub.renewal_date ?? null) !== (read.renewal_date ?? null)) {
    throw new TogetherRefusal(409, `${plan} changed while billing — reload Renewals and try again.`);
  }

  const had = await find();
  if (had) {
    /* R-2541: a freed part (its proforma cancelled) goes out at today's seats × rate — what the preview showed
       (billNextPreview reprices only a freed part; any other laid part keeps its stored amount there and here). */
    const { data: gone, error: gErr } = await admin.from("quotes").select("id").eq("tenant_id", tenantId).eq("cancelled_part_billing_id", had).limit(1);
    if (gErr) throw new Error(gErr.message);
    /* R-2831: a freed part already on a LIVE request (a line of another together proforma, e.g. a concurrent POST
       with an overlapping id) keeps the amount that request was made for — never repriced under it. The RPC then
       refuses it ("already on proforma …"). part_live_request is the one definition of live (R-2810). */
    let liveRequest: unknown = null;
    if ((gone ?? []).length > 0) {
      const { data: liveId, error: lErr } = await admin.rpc("part_live_request", { p_tenant: tenantId, p_part: had });
      if (lErr) throw new Error(lErr.message);
      liveRequest = liveId ?? null;
    }
    const price = (gone ?? []).length > 0 && !liveRequest ? await unbilledPartPrice(admin as Parameters<typeof unbilledPartPrice>[0], had) : null;
    if (price && price.to !== price.from) {
      const { error } = await admin.from("subscription_billings")
        .update({ taxable_amount: price.to, updated_at: new Date().toISOString() })
        .eq("id", had).is("invoice_id", null).eq("taxable_amount", price.from);
      if (error) throw new Error(error.message);
    }
    return had;
  }

  const term = virtualTermFor(sub, periodStart);
  const facts = sub.quote_id ? await readQuotePaymentFacts(admin as Parameters<typeof readQuotePaymentFacts>[0], sub.quote_id) : undefined;
  const lay = () => syncSubscriptionInstalments({
    supabase: admin as Parameters<typeof syncSubscriptionInstalments>[0]["supabase"],
    sub: { ...sub, renewal_date: term.renewalDate }, quote: facts, todayISO, layOnly: true,
    ...(term.roll ? { termRoll: term.roll } : {}),
  });
  let skip: string | null;
  try {
    skip = (await lay()).skip?.reason ?? null;
  } catch (first) {
    /* A racing lay inserted the same keyed rows — the second pass only reads them. Still failing → the first error. */
    try { skip = (await lay()).skip?.reason ?? null; } catch { throw first; }
  }
  const id = await find();
  if (!id) throw new TogetherRefusal(409, `${plan}'s part from ${periodStart} could not be laid${skip ? ` — ${skip}` : ""}. Use Bill next part on its row.`);
  return id;
}

/** What bill_parts_together (R-2810) answers. */
export interface BillPartsTogetherResult {
  quote_id: string;
  already_existed?: boolean;
  subscription_ids?: string[];
  action?: string;
  invoice_id?: string | null;
}

type RpcError = { code?: string; message: string };

/** ONE call for all the parts (the RPC locks per customer and answers the same proforma for the same parts). */
export async function billPartsTogether(db: SupabaseClient, billingIds: readonly string[]):
  Promise<{ data: BillPartsTogetherResult | null; error: RpcError | null }> {
  const { data, error } = await db.rpc("bill_parts_together", { p_billing_ids: [...billingIds] });
  return { data: (data as BillPartsTogetherResult | null) ?? null, error: error ? { code: error.code, message: error.message } : null };
}

/**
 * May this login bill together on this database? Asked BEFORE any part is laid. An empty list makes the RPC
 * refuse ("pick at least two", 22023) without writing — after its login and role checks. So "no such function"
 * = not deployed (503), and R-2831: 42501 (role) / 28000 (no company on the login) refuse here too, before a
 * part is laid with the admin client. Anything else = ready (the real call decides).
 */
export async function billTogetherReady(db: SupabaseClient): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { error } = await billPartsTogether(db, []);
  if (error && ["42883", "PGRST202", "42501", "28000"].includes(error.code ?? "")) {
    const r = rpcRefusal(error);
    if (r) return { ok: false, ...r };
  }
  return { ok: true };
}

/** An invoiced together request a retry may answer with (R-2831). */
export interface InvoicedTogether { quoteId: string; invoiceId: string; subscriptionIds: string[] }

/** Without the periods the screen showed (an older screen), how long after an 'invoice' answer a POST for the same
 *  subscriptions is taken as its retry — later it is a new bill (the next part). */
export const INVOICED_RETRY_MINUTES = 15;

type ClosedQuote = LiveQuote & { invoice_id: string | null; created_at: string };

/**
 * R-2831 — retry after an 'invoice' answer. When the pool already paid a started together group,
 * bill_parts_together invoices it at once: the proforma closes and the parts carry that invoice. A retry then no
 * longer sees a live together proforma (existingTogetherBill) and would move on to the NEXT period.
 *
 * - `periods` given (subscription → the part start the screen showed and the user confirmed): those exact parts,
 *   all invoiced by ONE invoice, named by one request (2+ parts, not cancelled / superseded) that holds exactly the
 *   asked subscriptions → that request + invoice, however long ago. (The route refuses a POST whose periods no
 *   longer match the preview, so a stale screen never bills the next month either.)
 * - no `periods` (an older screen): a Bill together request ("Billed together: …") of these subscriptions' customer
 *   made in the last INVOICED_RETRY_MINUTES whose parts were all invoiced by one invoice, holding exactly the asked
 *   subscriptions. Newest first.
 * Closed by its invoice = invoice_id set (a paid request) or 'expired' (bill_subscription_instalment closes a
 * pool-paid / invoice-on-due-date request that way, R-2527 body) — both count.
 */
export async function findInvoicedTogether(db: SupabaseClient, tenantId: string, facts: readonly TogetherReadFact[],
  opts: { periods?: ReadonlyMap<string, string> | null; nowMs?: number } = {}): Promise<InvoicedTogether | null> {
  if (facts.length < 2 || facts.some((f) => !f.sub)) return null;
  const customers = [...new Set(facts.map((f) => f.sub!.customer_id ?? null))];
  if (customers.length !== 1 || !customers[0]) return null;
  const asked = facts.map((f) => f.sub!.id);
  const periods = opts.periods ?? null;

  let candidates: ClosedQuote[];
  if (periods) {
    if (asked.some((id) => !periods.has(id))) return null;
    const { data: shown, error } = await db.from("subscription_billings").select("id, subscription_id, period_start, invoice_id")
      .eq("tenant_id", tenantId).in("subscription_id", asked).in("period_start", [...new Set(periods.values())]);
    if (error) throw new Error(error.message);
    const mine = ((shown ?? []) as Array<{ id: string; subscription_id: string; period_start: string; invoice_id: string | null }>)
      .filter((p) => periods.get(p.subscription_id) === p.period_start.slice(0, 10));
    if (mine.length !== asked.length || mine.some((p) => !p.invoice_id)) return null;
    const { data: qs, error: qErr } = await db.from("quotes")
      .select("id, status, invoice_id, subscription_billing_id, line_items, created_at")
      .eq("tenant_id", tenantId).in("subscription_billing_id", mine.map((p) => p.id))
      .is("cancelled_at", null).is("superseded_by", null);
    if (qErr) throw new Error(qErr.message);
    candidates = (qs ?? []) as ClosedQuote[];
  } else {
    const since = new Date((opts.nowMs ?? Date.now()) - INVOICED_RETRY_MINUTES * 60_000).toISOString();
    const { data: qs, error } = await db.from("quotes")
      .select("id, status, invoice_id, subscription_billing_id, line_items, created_at")
      .eq("tenant_id", tenantId).eq("customer_id", customers[0])
      .not("subscription_billing_id", "is", null)
      .is("cancelled_at", null).is("superseded_by", null)
      .like("notes", "Billed together:%")
      .gte("created_at", since)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    candidates = (qs ?? []) as ClosedQuote[];
  }
  const closed = candidates.filter((q) => q.invoice_id != null || q.status === "expired")
    .map((q) => ({ q, parts: requestBillingIds(q) })).filter((x) => x.parts.length >= 2);
  if (closed.length === 0) return null;
  const { data: parts, error: pErr } = await db.from("subscription_billings")
    .select("id, subscription_id, invoice_id").eq("tenant_id", tenantId).in("id", [...new Set(closed.flatMap((x) => x.parts))]);
  if (pErr) throw new Error(pErr.message);
  const partOf = new Map(((parts ?? []) as Array<{ id: string; subscription_id: string; invoice_id: string | null }>).map((p) => [p.id, p]));
  const askedSet = new Set(asked);
  for (const { q, parts: ps } of closed) {
    const rows = ps.map((p) => partOf.get(p));
    /* every part invoiced, all by ONE invoice — the request's own when it carries one */
    const invoiceId = q.invoice_id ?? rows[0]?.invoice_id ?? null;
    if (!invoiceId || rows.some((r) => !r || r.invoice_id !== invoiceId)) continue;
    const subIds = new Set(rows.map((r) => r!.subscription_id));
    if (subIds.size === askedSet.size && [...subIds].every((id) => askedSet.has(id))) return { quoteId: q.id, invoiceId, subscriptionIds: asked };
  }
  return null;
}

/** The tax invoice a request already has (null = none) — for an already_existed answer that carries no invoice_id. */
export async function quoteInvoiceId(db: SupabaseClient, tenantId: string, quoteId: string): Promise<string | null> {
  const { data, error } = await db.from("quotes").select("invoice_id").eq("tenant_id", tenantId).eq("id", quoteId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { invoice_id: string | null } | null)?.invoice_id ?? null;
}

/** Postgres's own wording (not a sentence the RPC wrote) — never shown as it is (§24). */
const RAW_DB_TEXT = /^(permission denied|duplicate key|new row violates|null value|insert or update|function .* does not exist|could not find)/i;

/** The RPC's refusal → status + the sentence to show (its own plain words). Null = not a refusal (a fault). */
export function rpcRefusal(e: RpcError): { status: number; error: string } | null {
  if (e.code === "42883" || e.code === "PGRST202") {
    return { status: 503, error: "Bill together is not ready on this server yet — bill each part with Bill next part for now." };
  }
  const raw = RAW_DB_TEXT.test(e.message);
  switch (e.code) {
    case "42501":
      return { status: 403, error: raw ? "Your login may not bill subscriptions together — ask the workspace owner." : e.message };
    case "28000":
      return { status: 401, error: raw ? "You are not signed in — sign in again and try again." : e.message };
    /* R-2810's refusals; its one-live-request-per-part guard says it in plain words with 23505. */
    case "22023": case "P0001": case "P0002": case "23505":
      return raw ? null : { status: 409, error: e.message };
    default: return null;
  }
}
