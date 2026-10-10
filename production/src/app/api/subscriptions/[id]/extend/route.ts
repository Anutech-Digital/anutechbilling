/**
 * POST /api/subscriptions/[id]/extend
 *
 * Operator-initiated subscription extension. Customer says "I want N
 * more years on this sub" — this issues a fresh quote (separate from
 * the original 1-year invoice) for the extension amount. When paid,
 * the existing subscription's renewal_date advances by N × 12 months.
 *
 * Body: { years: 1 | 2 | 3 | 4 | 5 }  or (R-805) { months: 1 … 11 }
 *
 * Returns: { quoteId, amount, years, months }
 *
 * Workflow:
 *   1. Operator clicks "Extend" on a subscription
 *   2. Picks 1 / 2 / 3 years in the dialog
 *   3. This route creates an extension quote (is_renewal=true,
 *      extension_months = years × 12) linked via renewal_quote_id
 *   4. Operator sends the quote to customer via existing "Send quote" flow
 *   5. Customer pays → record_payment rolls renewal_date forward by
 *      extension_months
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { ACTION_ROLES, forbiddenMessage } from "@/lib/auth/action-roles";
import { withRoute } from "@/lib/api/with-route";
import { createExtensionQuote } from "@/lib/renewals/create-extension-quote";
import { MAX_EXTENSION_MONTHS, MAX_EXTENSION_YEARS, extensionBlockedReason } from "@/lib/renewals/extension-term";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* R-805: whole years (as before) OR months 1–11 — exactly one of the two. */
const bodySchema = z
  .object({
    years:  z.coerce.number().int().min(1).max(MAX_EXTENSION_YEARS).optional(),
    months: z.coerce.number().int().min(1).max(MAX_EXTENSION_MONTHS).optional(),
  })
  .refine((b) => (b.years == null) !== (b.months == null), { message: "Send either years or months" });

/* R-217 (R-051): withRoute() does sign-in, tenant, the role gate (ACTION_ROLES
   "seats.change" = owner/manager/billing) and the zod body in one place. */
export const POST = withRoute(
  {
    route: "api/subscriptions/extend",
    input: bodySchema,
    roles: ACTION_ROLES["seats.change"],
    roleHint: forbiddenMessage("seats.change"),
  },
  async ({ input, params, user, tenantId }) => {
  const { years, months } = input;

  // 3. Load subscription + tenant scope
  const supabase = createAdminClientFor(user.id); // R-051: audit log names the caller
  const { data: sub, error: subErr } = await supabase
    .from("subscriptions")
    .select(
      `id, tenant_id, customer_id, customer_name, plan, seats, mrr,
       renewal_date, status, renewal_quote_id, start_date, term_months, billing_cycle, domain`
    )
    .eq("id", params.id)
    .single();
  if (subErr || !sub) {
    return NextResponse.json({ error: "subscription not found" }, { status: 404 });
  }
  if (sub.tenant_id !== tenantId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (sub.status !== "active") {
    return NextResponse.json(
      { error: `cannot extend — subscription is ${sub.status}` },
      { status: 400 }
    );
  }
  if (!sub.renewal_date) {
    return NextResponse.json({ error: "subscription has no renewal_date" }, { status: 400 });
  }

  /* R-807 (was R-805 months-only): a monthly / quarterly / half-yearly billed subscription is
     invoiced per period by the billing cron. A paid extension quote — years OR months — is
     invoiced in full AND the cron raises the same year's instalments again as unpaid (proven
     on the local DB, see extensionBlockedReason). So no extension at all on these. */
  const blocked = extensionBlockedReason(sub.billing_cycle);
  if (blocked) {
    return NextResponse.json({ error: blocked, code: "split_billed" }, { status: 400 });
  }

  // 4. Tenant grace days for quote expiry
  const { data: tenant } = await supabase
    .from("tenants")
    .select("grace_period_days")
    .eq("id", sub.tenant_id)
    .single();

  // 5. Issue extension quote
  const result = await createExtensionQuote({
    supabase,
    subscriptionId:  sub.id,
    tenantId:        sub.tenant_id,
    customerId:      sub.customer_id,
    customerName:    sub.customer_name,
    plan:            sub.plan,
    seats:           sub.seats,
    mrr:             sub.mrr ?? 0,
    renewalDate:     sub.renewal_date,
    graceDays:       tenant?.grace_period_days ?? 7,
    years,
    months,
    startDate:       sub.start_date,
    termMonths:      sub.term_months,
    domain:          sub.domain, // R-834: named in the quote note
  });

  if (!result.ok) {
    const status = result.code === "already_open" ? 409 : 500;
    return NextResponse.json({ error: result.message, code: result.code }, { status });
  }

  return {
    quoteId:        result.quoteId,
    amount:         result.amount,
    years:          result.years,
    months:         result.months,
    subscriptionId: sub.id,
  };
  },
);
