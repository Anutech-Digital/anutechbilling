/**
 * /api/renewals/bill-together — R-2807 (R-2805 "Bill together", Pratik: ITBUZZ's Business Standard + Business
 * Starter were on ONE bill last cycle, now two "Bill next part" buttons). The contract the Renewals screen
 * (R-2808) codes against is src/lib/renewals/bill-together.ts:
 *
 *   GET            → 400 { error }                 the screen's "is it there?" probe (404 = not deployed)
 *   GET ?ids=a,b   → 200 BillTogetherPreview       each sub's next part line or why it cannot join; never 404
 *   POST {ids}     → 200 BillTogetherCreated       lays each sub's next part (R-2735 renew-on-paid mark), then
 *                                                  ONE bill_parts_together (R-2810) → ONE proforma
 *                  → 4xx { error, reasons? }       plain words (§24)
 *
 * Money roles only (owner / manager / accountant / billing). The company is the signed-in profile's — the body
 * carries only subscription ids. Reads + the RPC run as the signed-in user; only laying a part uses the
 * actor-stamped admin client (see bill-together.server.ts for why).
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { MONEY_RECORD_ROLES } from "@/lib/auth/roles";
import { createAdminClientFor } from "@/lib/supabase/server";
import { istToday } from "@/lib/dates/ist";
import type { BillTogetherCreated } from "@/lib/renewals/bill-together";
import { buildTogetherPreview, existingTogetherBill, parseTogetherIds, MAX_TOGETHER_IDS, type TogetherReason } from "@/lib/renewals/bill-together-preview";
import { readTogetherFacts, fillNextParts, layTogetherPart, billPartsTogether, billTogetherReady, rpcRefusal, TogetherRefusal } from "@/lib/renewals/bill-together.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROLE_HINT = "Only an owner, manager, accountant or billing user can bill subscriptions together.";
/** BillTogetherError, with R-2807's extra "not_billable" code (bill-together-preview.ts). */
type TogetherError = { error: string; reasons?: Array<{ subscriptionId: string } & TogetherReason> };
const err = (status: number, body: TogetherError) => NextResponse.json(body, { status });

function idsOrError(ids: string[], min: number): string | null {
  if (ids.length < min) return min > 1 ? "Tick at least two subscriptions of one customer to bill them together." : "Pick the subscriptions to bill together.";
  if (ids.length > MAX_TOGETHER_IDS) return `Bill at most ${MAX_TOGETHER_IDS} subscriptions together at a time.`;
  return null;
}

export const GET = withRoute({ route: "api/renewals/bill-together#preview", roles: MONEY_RECORD_ROLES, roleHint: ROLE_HINT },
  async ({ req, supabase, tenantId }) => {
    const ids = parseTogetherIds(req.nextUrl.searchParams.get("ids") ?? "");
    const bad = idsOrError(ids, 1);
    if (bad) return err(400, { error: bad });
    const db = supabase as unknown as SupabaseClient;
    const facts = await fillNextParts(db, await readTogetherFacts(db, tenantId, ids));
    return NextResponse.json(buildTogetherPreview(facts, istToday()));
  });

export const POST = withRoute({ route: "api/renewals/bill-together", roles: MONEY_RECORD_ROLES, roleHint: ROLE_HINT },
  async ({ req, supabase, tenantId, user }) => {
    let body: unknown;
    try { body = await req.json(); } catch { return err(400, { error: "Could not read the request — refresh the page and try again." }); }
    const ids = parseTogetherIds((body as { ids?: unknown } | null)?.ids);
    const bad = idsOrError(ids, 2);
    if (bad) return err(400, { error: bad });
    const db = supabase as unknown as SupabaseClient;
    const today = istToday();
    const read = await readTogetherFacts(db, tenantId, ids);

    /* A second click / retry after the first went through: the same proforma, nothing laid again. */
    const existing = existingTogetherBill(read);
    if (existing) {
      return NextResponse.json({ quoteId: existing, href: `/quotes/${existing}`, alreadyExisted: true,
        subscriptionIds: read.map((f) => f.sub!.id) } satisfies BillTogetherCreated);
    }

    const facts = await fillNextParts(db, read);
    const preview = buildTogetherPreview(facts, today);
    const refused = preview.subs.filter((s) => s.reasons.length > 0);
    if (refused.length > 0) {
      return err(409, {
        error: refused.length === 1 ? "One subscription cannot be billed with the others — untick it or fix it first." : `${refused.length} subscriptions cannot be billed together — untick them or fix them first.`,
        reasons: refused.flatMap((s) => s.reasons.map((r) => ({ subscriptionId: s.subscriptionId, ...r }))),
      });
    }

    /* Nothing is laid on a server without R-2810's RPC (the lay would be left with no proforma). */
    if (!(await billTogetherReady(db))) {
      return err(503, { error: "Bill together is not ready on this server yet — bill each part with Bill next part for now." });
    }

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
    return NextResponse.json({
      quoteId: data.quote_id,
      href: `/quotes/${data.quote_id}`,
      alreadyExisted: data.already_existed === true,
      subscriptionIds: Array.isArray(data.subscription_ids) && data.subscription_ids.length > 0 ? data.subscription_ids : facts.map((f) => f.sub!.id),
    } satisfies BillTogetherCreated);
  });
