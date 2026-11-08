/**
 * POST /api/subscriptions/[id]/change-plan — R-2227 (Zoho Billing A3): change a licence
 * subscription's plan in the middle of its term (e.g. Business Starter → Business Standard).
 *
 * Body: { to_item_id, seats, preview? }
 *   preview: true → returns the calculation only (the dialog's preview) — nothing is saved.
 *   otherwise     → saves ONE draft quote: the new plan for the rest of the term / current part,
 *                   less the unused old plan, credited only up to what the part's bill still asks
 *                   for + what was received (R-2255 splitChangeCredit, money read HERE from the
 *                   books — change-plan-money.server.ts). Linked through renewal_quote_id with
 *                   extension_months = 0 like R-2073's support upgrade; record_payment (migration
 *                   20261108013612) moves the subscription to the new plan / seats / MRR when it
 *                   is paid in full. The renewal date does not move.
 * Preview and save run the SAME buildPlanChange() on the same server-read inputs (R-803 rule).
 *
 * Roles: ACTION_ROLES["seats.change"] (owner / manager / billing) — the Extend / Add seats gate.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { ACTION_ROLES, forbiddenMessage } from "@/lib/auth/action-roles";
import { withRoute } from "@/lib/api/with-route";
import { istToday } from "@/lib/dates/ist";
import { quoteStartTaxRate } from "@/lib/quotes/bill-of-supply";
import { readTenantGstRegistration } from "@/lib/compliance/gst-registration-server";
import { isZeroRatedSupply } from "@/lib/gst/place-of-supply";
import { extensionQuoteExpiry } from "@/lib/quotes/quote-validity";
import { composeQuoteNotes } from "@/lib/quotes/customer-notes";
import { subscriptionProducts } from "@/lib/subscriptions/catalog-options";
import { buildPlanChange } from "@/lib/subscriptions/change-plan";
import { readPlanChangeMoney } from "@/lib/subscriptions/change-plan-money.server";
import type { Item } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  to_item_id: z.string().min(1).max(200),
  seats: z.number().int().min(1).max(100_000),
  preview: z.boolean().optional(),
});

export const POST = withRoute(
  {
    route: "api/subscriptions/change-plan",
    input: bodySchema,
    roles: ACTION_ROLES["seats.change"],
    roleHint: forbiddenMessage("seats.change"),
  },
  async ({ input, params, user, tenantId }) => {
    const supabase = createAdminClientFor(user.id); // R-051: audit log names the caller
    const { data: sub, error: subErr } = await supabase
      .from("subscriptions")
      .select("id, tenant_id, customer_id, customer_name, plan, item_id, vendor, status, seats, mrr, billing_cycle, term_months, term_amount, start_date, renewal_date, renewal_quote_id, quote_id, domain, vendor_cost_per_seat_month, external_source, billed_externally_until")
      .eq("id", params.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    /* R-2091: another company's subscription answers exactly like an unknown id. */
    if (subErr || !sub || sub.tenant_id !== tenantId) {
      return NextResponse.json({ error: "subscription not found" }, { status: 404 });
    }

    const { data: items, error: itemsErr } = await supabase
      .from("items").select("*").eq("tenant_id", tenantId).eq("id", input.to_item_id).eq("is_active", true);
    if (itemsErr) return NextResponse.json({ error: "Could not read the catalogue." }, { status: 500 });
    const target = subscriptionProducts((items ?? []) as Item[])[0];
    if (!target) return NextResponse.json({ error: "That plan is not in your catalogue." }, { status: 400 });

    const today = istToday();
    let money;
    try {
      money = await readPlanChangeMoney(supabase, tenantId, sub, today);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the money for this term." }, { status: 500 });
    }
    let taxRatePct = quoteStartTaxRate(await readTenantGstRegistration(supabase, tenantId));
    if (sub.customer_id) {
      const { data: cust } = await supabase
        .from("customers").select("country, gst_treatment").eq("id", sub.customer_id).eq("tenant_id", tenantId).maybeSingle();
      if (isZeroRatedSupply({ country: cust?.country, treatment: cust?.gst_treatment })) taxRatePct = 0; // R-2515: export / SEZ
    }
    const built = buildPlanChange({ sub, target, newSeats: input.seats, today, taxRatePct, money });
    if (!built.ok) return NextResponse.json({ error: built.reason }, { status: 400 });
    const { plan } = built;

    if (input.preview) {
      return { preview: true, calc: plan.calc, noteText: plan.noteText, taxRatePct };
    }

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
      plan:             target.name,
      seats:            plan.calc.newSeats,
      amount:           plan.calc.total,
      status:           "draft",
      payment_status:   "awaiting",
      owner_id:         null,
      created_date:     today,
      expires_date:     extensionQuoteExpiry(today, plan.calc.to),
      line_items:       [plan.line] as never,
      subtotal:         plan.calc.net,
      total_cost:       0,
      discount_pct:     0,
      tax_rate:         taxRatePct,
      billing_cycle:    "yearly",  // one invoice for this charge — never split into instalments
      is_renewal:       true,      // like an extension: no new subscription
      is_extension:     false,
      extension_months: 0,         // R-2227: buys no time — record_payment keeps the renewal date
      domain:           sub.domain,
      notes:            composeQuoteNotes(plan.noteText, `Raised from Change plan for subscription ${sub.id}.`),
    });
    if (insertErr) return NextResponse.json({ error: "Could not save the quote." }, { status: 500 });

    /* Link so record_payment finds it — only while nothing else is linked. */
    const { data: linked } = await supabase
      .from("subscriptions")
      .update({ renewal_quote_id: quoteId })
      .eq("id", sub.id).eq("tenant_id", tenantId).is("renewal_quote_id", null)
      .select("id");
    if (!linked || linked.length === 0) {
      await supabase.from("quotes").delete().eq("id", quoteId).eq("tenant_id", tenantId).eq("status", "draft");
      return NextResponse.json({ error: "This subscription already has an open quote. Finish or delete it first." }, { status: 409 });
    }

    return { quoteId, amount: plan.calc.total, amountExGst: plan.calc.net, subscriptionId: sub.id };
  },
);
