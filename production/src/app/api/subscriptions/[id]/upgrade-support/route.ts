/**
 * POST /api/subscriptions/[id]/upgrade-support — R-2073, decision D5 (29 Oct 2026).
 *
 * "Upgrade plan" on a support subscription (SKU SUP-…). Makes a DRAFT quote for the customer
 * with one line: the new tier for the days left in this term, less the old tier for the same
 * days (lib/support/pro-rata-upgrade.ts). GST is the quote's normal rate. The renewal date
 * does not move. Downgrades are refused — they take effect at renewal.
 *
 * Same path as Extend term (api/subscriptions/[id]/extend): the quote is linked through
 * subscriptions.renewal_quote_id, so record_payment finds it; extension_months = 0 and the
 * SUP- line make record_payment change the plan instead of moving the date
 * (migration 20261029005703_r2073_support_upgrade_pro_rata).
 *
 * Body: { to_tier: "standard" | "enterprise" }   Returns: { quoteId, amount, amountExGst }
 * Roles: ACTION_ROLES["seats.change"] (owner / manager / billing) — the Extend / Add seats gate.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { ACTION_ROLES, forbiddenMessage } from "@/lib/auth/action-roles";
import { withRoute } from "@/lib/api/with-route";
import { istToday } from "@/lib/dates/ist";
import { grossAmount } from "@/lib/quotes/amounts";
import { quoteStartTaxRate } from "@/lib/quotes/bill-of-supply";
import { readTenantGstRegistration } from "@/lib/compliance/gst-registration-server";
import { extensionQuoteExpiry } from "@/lib/quotes/quote-validity";
import { buildSupportUpgrade } from "@/lib/support/upgrade-quote";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({ to_tier: z.enum(["standard", "enterprise"]) });

export const POST = withRoute(
  {
    route: "api/subscriptions/upgrade-support",
    input: bodySchema,
    roles: ACTION_ROLES["seats.change"],
    roleHint: forbiddenMessage("seats.change"),
  },
  async ({ input, params, user, tenantId }) => {
    const supabase = createAdminClientFor(user.id); // R-051: audit log names the caller
    const { data: sub, error: subErr } = await supabase
      .from("subscriptions")
      .select("id, tenant_id, customer_id, customer_name, plan, item_id, status, billing_cycle, term_months, start_date, renewal_date, renewal_quote_id, domain")
      .eq("id", params.id)
      .single();
    if (subErr || !sub) return NextResponse.json({ error: "subscription not found" }, { status: 404 });
    if (sub.tenant_id !== tenantId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const { data: items, error: itemsErr } = await supabase
      .from("items")
      .select("id, name, msrp, prices")
      .eq("tenant_id", tenantId)
      .like("id", "SUP-%");
    if (itemsErr) return NextResponse.json({ error: "Could not read the catalogue." }, { status: 500 });

    const today = istToday();
    const built = buildSupportUpgrade({ sub, items: items ?? [], toTier: input.to_tier, today });
    if (!built.ok) return NextResponse.json({ error: built.reason }, { status: 400 });
    const { plan } = built;

    const taxRatePct = quoteStartTaxRate(await readTenantGstRegistration(supabase, tenantId));
    const subtotal = plan.calc.amountExGst;
    const amount = grossAmount(subtotal, taxRatePct);

    const { data: nextNumber, error: numErr } = await supabase.rpc("next_document_number", {
      p_doc_type: "quote", p_tenant_id: tenantId,
    });
    if (numErr || !nextNumber) return NextResponse.json({ error: "Could not allocate a quote number." }, { status: 500 });
    const quoteId = nextNumber as unknown as string;

    const { error: insertErr } = await supabase.from("quotes").insert({
      id:               quoteId,
      tenant_id:        tenantId,
      customer_id:      sub.customer_id,
      customer_name:    sub.customer_name,
      plan:             plan.toRow.name,
      seats:            1,
      amount,
      status:           "draft",
      payment_status:   "awaiting",
      owner_id:         null,
      created_date:     today,
      expires_date:     extensionQuoteExpiry(today, plan.to),
      line_items:       [plan.line],
      subtotal,
      total_cost:       0,
      discount_pct:     0,
      tax_rate:         taxRatePct,
      is_renewal:       true,   // like an extension: no new subscription, Invoice now files none
      is_extension:     false,
      extension_months: 0,      // R-2073: buys no time — record_payment keeps the renewal date
      domain:           sub.domain,
      notes:            plan.notes,
    });
    if (insertErr) return NextResponse.json({ error: "Could not save the quote." }, { status: 500 });

    /* Link so record_payment finds it — only while nothing else is linked (two clicks, or a
       renewal quote made in between, must not overwrite each other). */
    const { data: linked } = await supabase
      .from("subscriptions")
      .update({ renewal_quote_id: quoteId })
      .eq("id", sub.id).eq("tenant_id", tenantId).is("renewal_quote_id", null)
      .select("id");
    if (!linked || linked.length === 0) {
      await supabase.from("quotes").delete().eq("id", quoteId).eq("tenant_id", tenantId).eq("status", "draft");
      return NextResponse.json({ error: "This subscription already has an open quote. Finish or delete it first." }, { status: 409 });
    }

    return { quoteId, amount, amountExGst: subtotal, subscriptionId: sub.id };
  },
);
