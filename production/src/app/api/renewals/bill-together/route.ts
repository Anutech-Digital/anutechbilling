/**
 * /api/renewals/bill-together — R-2807 (R-2805 "Bill together", Pratik: ITBUZZ's Business Standard + Business
 * Starter were on ONE bill last cycle, now two "Bill next part" buttons). The contract the Renewals screen
 * (R-2808) codes against is src/lib/renewals/bill-together.ts:
 *
 *   GET            → 400 { error }                 the screen's "is it there?" probe (404 = not deployed)
 *   GET ?ids=a,b   → 200 BillTogetherPreview       each sub's next part line or why it cannot join; never 404
 *   POST {ids}     → 200 BillTogetherCreated       lays each sub's next part (R-2735 renew-on-paid mark), then
 *                                                  ONE bill_parts_together (R-2810) → ONE proforma; R-2831: + action
 *                                                  ("request" | "invoice") and invoiceId — a group the pool already
 *                                                  paid is invoiced at once, href = /invoices/<id>; a retry of that
 *                                                  answer within 15 min gets the same invoice, never the next month
 *                  → 4xx { error, reasons? }       plain words (§24)
 *
 * R-2849 (R-2809c): when the first ticked subscription is renewed once a year, the bill is ONE renewal quote
 * (kind "renewal"): the preview shows each yearly subscription's next term priced by priceRenewalQuote (the one
 * renewal pricing), POST calls create_renewal_quote_together (R-2847) → action "renewal_quote", href /quotes/<id>;
 * paid in full, record_payment renews each subscription by its own term (R-2848). Split and yearly never mix.
 *
 * Money roles only (owner / manager / accountant / billing). The company is the signed-in profile's — the body
 * carries only subscription ids. Reads + the RPCs run as the signed-in user; only laying a part and the renewal
 * pricing reads use the actor-stamped admin client (see bill-together.server.ts / bill-together-renewal.server.ts).
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { MONEY_RECORD_ROLES } from "@/lib/auth/roles";
import { createAdminClientFor } from "@/lib/supabase/server";
import { istToday } from "@/lib/dates/ist";
import type { BillTogetherCreated, BillTogetherError, BillTogetherPreview } from "@/lib/renewals/bill-together";
import { buildTogetherPreview, existingTogetherBill, existingTogetherRenewal, parseTogetherIds, parseTogetherPeriods, periodsChanged, togetherKind,
  MAX_TOGETHER_IDS } from "@/lib/renewals/bill-together-preview";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { readTogetherFacts, fillNextParts, layTogetherPart, billPartsTogether, billTogetherReady, rpcRefusal, TogetherRefusal,
  findInvoicedTogether, quoteInvoiceId, type TogetherReadFact } from "@/lib/renewals/bill-together.server";
import { fillRenewalLines, createRenewalQuoteTogether, renewalTogetherReady, renewalRpcRefusal } from "@/lib/renewals/bill-together-renewal.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROLE_HINT = "Only an owner, manager, accountant or billing user can bill subscriptions together.";
/** The contract's answer; this route always sets R-2831's action / invoiceId (a pool-paid group is invoiced at once, href = the invoice). */
type TogetherCreated = BillTogetherCreated & Required<Pick<BillTogetherCreated, "action" | "invoiceId">>;
/* R-2845: the invoice link through invoiceHref — a document-series number with "/" (ANU/26-27/001) stays one segment */
const created = (quoteId: string, invoiceId: string | null, alreadyExisted: boolean, subscriptionIds: string[]): TogetherCreated => ({
  quoteId, href: invoiceId ? invoiceHref(invoiceId) : `/quotes/${quoteId}`, alreadyExisted, subscriptionIds,
  action: invoiceId ? "invoice" : "request", invoiceId,
});
/* R-2849: ONE renewal quote for yearly subscriptions — opened on the quote page, not sent yet. */
const renewalCreated = (quoteId: string, alreadyExisted: boolean, subscriptionIds: string[]): TogetherCreated => ({
  quoteId, href: `/quotes/${encodeURIComponent(quoteId)}`, alreadyExisted, subscriptionIds, action: "renewal_quote", invoiceId: null,
});
const err = (status: number, body: BillTogetherError) => NextResponse.json(body, { status });

function idsOrError(ids: string[], min: number): string | null {
  if (ids.length < min) return min > 1 ? "Tick at least two subscriptions of one customer to bill them together." : "Pick the subscriptions to bill together.";
  if (ids.length > MAX_TOGETHER_IDS) return `Bill at most ${MAX_TOGETHER_IDS} subscriptions together at a time.`;
  return null;
}

/** 409 with each refused subscription's reasons — or null when every one can join. */
function refusedOf(preview: BillTogetherPreview): NextResponse | null {
  const refused = preview.subs.filter((s) => s.reasons.length > 0);
  if (refused.length === 0) return null;
  return err(409, {
    error: refused.length === 1 ? "One subscription cannot be billed with the others — untick it or fix it first." : `${refused.length} subscriptions cannot be billed together — untick them or fix them first.`,
    reasons: refused.flatMap((s) => s.reasons.map((r) => ({ subscriptionId: s.subscriptionId, ...r }))),
  });
}

export const GET = withRoute({ route: "api/renewals/bill-together#preview", roles: MONEY_RECORD_ROLES, roleHint: ROLE_HINT },
  async ({ req, supabase, tenantId, user }) => {
    const ids = parseTogetherIds(req.nextUrl.searchParams.get("ids") ?? "");
    const bad = idsOrError(ids, 1);
    if (bad) return err(400, { error: bad });
    const db = supabase as unknown as SupabaseClient;
    const read = await readTogetherFacts(db, tenantId, ids);
    if (togetherKind(read) === "renewal") {
      /* R-2849: yearly — each one's next term, priced as its own renewal quote would be; a server that cannot make a
         together renewal quote yet says so on every line (nothing can be pressed). */
      const ready = await renewalTogetherReady(db, tenantId);
      /* not ready → nothing is priced (every line says so) */
      if (!ready.ok) return NextResponse.json(buildTogetherPreview(read, istToday(), { renewalNotReady: ready.error }));
      const admin = createAdminClientFor(user.id) as unknown as SupabaseClient;
      const facts = await fillRenewalLines(db, admin, tenantId, read);
      return NextResponse.json(buildTogetherPreview(facts, istToday()));
    }
    const facts = await fillNextParts(db, read, tenantId);
    return NextResponse.json(buildTogetherPreview(facts, istToday()));
  });

export const POST = withRoute({ route: "api/renewals/bill-together", roles: MONEY_RECORD_ROLES, roleHint: ROLE_HINT },
  async ({ req, supabase, tenantId, user }) => {
    let body: unknown;
    try { body = await req.json(); } catch { return err(400, { error: "Could not read the request — refresh the page and try again." }); }
    const ids = parseTogetherIds((body as { ids?: unknown } | null)?.ids);
    const bad = idsOrError(ids, 2);
    if (bad) return err(400, { error: bad });
    /* R-2831: the part each subscription bills, as the screen showed it (optional — an older screen sends none). */
    const periods = parseTogetherPeriods((body as { periods?: unknown } | null)?.periods, ids);
    if (periods === "bad") return err(400, { error: "Could not read what was shown — refresh the page and try again." });
    const db = supabase as unknown as SupabaseClient;
    const today = istToday();
    const read = await readTogetherFacts(db, tenantId, ids);
    if (togetherKind(read) === "renewal") return postRenewal(db, tenantId, user.id, read, periods, today);

    /* A second click / retry after the first went through: the same proforma, nothing laid again. */
    const existing = existingTogetherBill(read);
    if (existing) return NextResponse.json(created(existing, null, true, read.map((f) => f.sub!.id)));
    /* R-2831: a retry after an 'invoice' answer (the pool paid the group: its proforma closed, the parts invoiced) —
       that invoice again, never the next month's parts. */
    const invoiced = await findInvoicedTogether(db, tenantId, read, { periods });
    if (invoiced) return NextResponse.json(created(invoiced.quoteId, invoiced.invoiceId, true, invoiced.subscriptionIds));

    const facts = await fillNextParts(db, read, tenantId);
    const preview = buildTogetherPreview(facts, today);
    const refused = refusedOf(preview);
    if (refused) return refused;
    /* R-2831: never bill a part the user did not see (a retry after its parts were billed moves on to the next one). */
    const moved = periods ? periodsChanged(preview, periods) : null;
    if (moved) return err(409, { error: moved });

    /* Nothing is laid on a server without R-2810's RPC (the lay would be left with no proforma). */
    /* … nor for a login the RPC refuses (R-2831: role / no company, before a part is laid with the admin client). */
    const ready = await billTogetherReady(db);
    if (!ready.ok) return err(ready.status, { error: ready.error });

    /* Lay each part the preview showed (its own period — R-2735 mark on a new term's first part). Laying is the
       billing job's own keyed write: a part laid here and then refused by the RPC is an ordinary unbilled part
       (the billing job / Bill next part bill it on its date) — no money, no document. */
    const admin = createAdminClientFor(user.id) as unknown as SupabaseClient;
    const billingIds: string[] = [];
    try {
      for (const f of facts) billingIds.push(await layTogetherPart(admin, tenantId, f.row!, f.next!.periodStart, today));
    } catch (e) {
      if (e instanceof TogetherRefusal) return err(e.status, { error: e.message });
      throw e;
    }

    const { data, error } = await billPartsTogether(db, billingIds);
    if (error) {
      const r = rpcRefusal(error);
      if (r) return err(r.status, { error: r.error });
      throw new RouteError(500, "Could not make the proforma — try again in a little while.", `${error.code ?? ""} ${error.message}`);
    }
    if (!data?.quote_id) throw new RouteError(500, "Could not make the proforma — try again in a little while.", "bill_parts_together returned no quote_id");
    const alreadyExisted = data.already_existed === true;
    /* 'invoice' carries its invoice_id; an already-existing request may have been paid and invoiced since (R-2831). */
    const invoiceId = data.invoice_id ?? (alreadyExisted ? await quoteInvoiceId(db, tenantId, data.quote_id) : null);
    if (data.action === "invoice" && !invoiceId) throw new RouteError(500, "Could not make the proforma — try again in a little while.", "bill_parts_together answered invoice with no invoice_id");
    return NextResponse.json(created(data.quote_id, invoiceId, alreadyExisted,
      Array.isArray(data.subscription_ids) && data.subscription_ids.length > 0 ? data.subscription_ids : facts.map((f) => f.sub!.id)));
  });

/**
 * R-2849 — POST for yearly subscriptions: ONE renewal quote (create_renewal_quote_together). Nothing is written before
 * the RPC: a refusal (here or in the RPC) leaves no quote and no link. The same set again → the same quote.
 */
async function postRenewal(db: SupabaseClient, tenantId: string, userId: string, read: TogetherReadFact[],
  periods: ReadonlyMap<string, string> | null, today: string): Promise<NextResponse> {
  const asked = read.filter((f) => f.sub).map((f) => f.sub!.id);
  /* Not ready on this server (R-2847's gate before R-2848) / missing RPC / role → plain words, nothing priced. */
  const ready = await renewalTogetherReady(db, tenantId);
  if (!ready.ok) return err(ready.status, { error: ready.error });

  /* Each one's linked renewal quote (read first) and price — a subscription already on a live renewal quote is not priced. */
  const admin = createAdminClientFor(userId) as unknown as SupabaseClient;
  const facts = await fillRenewalLines(db, admin, tenantId, read);
  /* A second click / retry after the first went through: every one is linked to the same live together quote that
     renews exactly these → that quote (never refused as "already on renewal quote …"). */
  const existing = existingTogetherRenewal(facts);
  if (existing) return NextResponse.json(renewalCreated(existing, true, asked));

  const preview = buildTogetherPreview(facts, today);
  const refused = refusedOf(preview);
  if (refused) return refused;
  /* The term each line showed (its period start): a renewal date moved since the dialog opened → nothing made. */
  const moved = periods ? periodsChanged(preview, periods) : null;
  if (moved) return err(409, { error: moved });

  const parts = facts.map((f) => ({ subscription_id: f.sub!.id, quote: f.renewalQuote! }));
  if (parts.some((p) => !p.quote)) {
    throw new RouteError(500, "Could not make the renewal quote — try again in a little while.", "a joinable yearly subscription has no priced quote");
  }
  const { data, error } = await createRenewalQuoteTogether(db, tenantId, parts);
  if (error) {
    const r = renewalRpcRefusal(error);
    if (r) return err(r.status, { error: r.error });
    throw new RouteError(500, "Could not make the renewal quote — try again in a little while.", `${error.code ?? ""} ${error.message}`);
  }
  if (!data?.quote_id) throw new RouteError(500, "Could not make the renewal quote — try again in a little while.", "create_renewal_quote_together returned no quote_id");
  const ids = Array.isArray(data.subscription_ids) && data.subscription_ids.length > 0 ? data.subscription_ids : asked;
  return NextResponse.json(renewalCreated(data.quote_id, data.already_existed === true || data.created === false, ids));
}
