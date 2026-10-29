/**
 * POST /api/public/checkout/support — R-2083 (29 Oct 2026).
 *
 * The order behind /buy/support: a support plan (Standard / Enterprise, monthly / yearly) paid
 * online, the same way /buy/workspace sells Google Workspace (api/public/checkout/workspace):
 *
 *   1. Validate the form (lib/support/public-checkout.ts). Only the plan + term CHOICE comes
 *      from the browser — any amount in the body is ignored.
 *   2. Price it HERE from the price book (getPriceBook → the same figure GET
 *      /api/public/catalog?function=support shows), and link the line to the selling company's
 *      own support catalogue row — record_payment reads the subscription's vendor ('support')
 *      from it, which is what fires trg_queue_support_sync → support_sync_outbox → DSP (R-2067).
 *   3. The customer: `billingCustomerId` (DSP's id: customer_number or uuid) is used ONLY when
 *      that customer is in the selling company, active, AND has this email — otherwise the
 *      order goes through the lead like every website order, and record_payment finds the
 *      customer (match_existing_customer) or creates one. A mismatch is never reported back
 *      (no probing other customers' ids).
 *   4. A lead (stage quote) + a quote (sent, payment awaiting) + a Razorpay order (receipt =
 *      quote id, payment_reference = order id) — keys from loadCheckoutRazorpayKeys, the SAME
 *      keys POST /api/public/checkout/verify checks the signature with.
 *
 * After payment nothing here runs: the buyer's page calls /api/public/checkout/verify (R-1596 —
 * signature, Razorpay's own record, amount from the quote) and Razorpay calls the webhook; both
 * settle through settleCapturedPayment → record_payment (idempotent per payment id) → the GST
 * tax invoice (issueInvoiceForOnlinePayment) → subscription → outbox row.
 *
 * Simulation (a laptop, never a deployment — simulatedPaymentAllowed) records the payment
 * directly so the whole path can be walked without Razorpay, exactly like /buy/workspace.
 */
import { NextResponse, type NextRequest } from "next/server";
import Razorpay from "razorpay";
import { addDaysISO, istToday } from "@/lib/dates/ist";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveStateCode, stateCodeFromName } from "@/lib/gst/gstin-state";
import { GST_STATE_BY_CODE, isValidGstin, rupee } from "@/lib/utils";
import { buyPageTenantId, BuyPageTenantMissingError, simulatedPaymentAllowed } from "@/lib/checkout/live-guards";
import { loadCheckoutRazorpayKeys } from "@/lib/checkout/razorpay-keys.server";
import { issueInvoiceForOnlinePayment } from "@/lib/checkout/online-invoice.server";
import { getPriceBook } from "@/lib/catalog/catalog-prices.server";
import { bookSupportPrice, supportBookSku } from "@/lib/catalog/catalog-prices";
import { turnstileRefusalFor } from "@/lib/security/turnstile-guard";
import { captureFromRequest } from "@/lib/marketing/utm";
import { publicDbError } from "@/app/api/public/_lib/db-error";
import {
  buildSupportOrder, isUuid, sameEmail, supportCheckoutSchema, type SupportBuyPlan, type SupportBuyTerm, type SupportItemRow,
} from "@/lib/support/public-checkout";
import { findSupportSku } from "@/lib/support/tiers";

export const dynamic = "force-dynamic";

type Admin = ReturnType<typeof createAdminClient>;

const NOTHING_CHARGED = "Nothing was charged.";

function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

/**
 * The selling company's active catalogue row for this plan + term: its `sku` (R-1785) first,
 * else the seeded / "Add to catalog" id (SUP-STANDARD-YR-<tenant>, lib/support/catalog-row.ts).
 */
async function supportItem(admin: Admin, tenantId: string, plan: SupportBuyPlan, term: SupportBuyTerm): Promise<SupportItemRow | null> {
  const sku = supportBookSku(plan, term);
  if (!sku) return null;
  const { data, error } = await admin
    .from("items")
    .select("id, name, sku")
    .eq("tenant_id", tenantId)
    .eq("vendor", "support")
    .eq("is_active", true)
    .limit(50);
  if (error) {
    console.error("[checkout/support] catalogue read failed:", error.message);
    return null;
  }
  const rows = (data ?? []) as { id: string; name: string | null; sku: string | null }[];
  const row = rows.find((r) => r.sku === sku) ?? findSupportSku(rows, plan, term);
  return row ? { id: row.id, name: row.name ?? "" } : null;
}

/** DSP's customer, only when it is this company's, active, and the same email. Else null. */
async function attachableCustomer(admin: Admin, tenantId: string, billingCustomerId: string, email: string) {
  if (!billingCustomerId) return null;
  const q = admin.from("customers").select("id, name, contact_email, is_active").eq("tenant_id", tenantId);
  /* The id is [A-Za-z0-9-] only (schema), so it is safe inside the or() filter. */
  const { data, error } = await (isUuid(billingCustomerId)
    ? q.or(`id.eq.${billingCustomerId},customer_number.eq.${billingCustomerId}`)
    : q.eq("customer_number", billingCustomerId)
  ).limit(2);
  if (error) {
    console.error("[checkout/support] customer lookup failed:", error.message);
    return null;
  }
  const rows = (data ?? []) as { id: string; name: string | null; contact_email: string | null; is_active: boolean }[];
  return rows.find((c) => c.is_active && sameEmail(c.contact_email, email)) ?? null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const bot = await turnstileRefusalFor(request, body);
    if (bot) return bot;
    const parsed = supportCheckoutSchema.safeParse(body);
    if (!parsed.success) {
      return fail(400, "Please check your details: " + parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ") + `. ${NOTHING_CHARGED}`);
    }
    const input = parsed.data;
    const email = input.email.toLowerCase();
    const fullName = input.fullName.trim();
    const companyName = input.companyName?.trim() || fullName;

    let tenantId: string;
    try {
      tenantId = buyPageTenantId();
    } catch (e) {
      if (e instanceof BuyPageTenantMissingError) {
        console.error("[checkout/support] BUY_PAGE_TENANT_ID is not set");
        return fail(503, `Online payment isn't available right now. ${NOTHING_CHARGED} Please contact us and we'll set up your plan.`);
      }
      throw e;
    }

    /* GST place of supply — asked BEFORE anything is saved (R-173): an entered state wins, a
       checksum-valid GSTIN is the fallback, nothing is guessed. */
    const cleanGstin = (input.gstin ?? "").trim().toUpperCase();
    const validGstin = cleanGstin && isValidGstin(cleanGstin) ? cleanGstin : null;
    if (cleanGstin && !validGstin) return fail(400, `The GSTIN doesn't look right — check it, or leave it empty for a B2C invoice. ${NOTHING_CHARGED}`, { field: "gstin" });
    const stateCode = resolveStateCode({ stateCode: stateCodeFromName(input.stateCode), gstin: validGstin });
    if (!stateCode) {
      return fail(400, `Please choose your state. It decides whether your GST invoice shows CGST + SGST or IGST. ${NOTHING_CHARGED}`, { needState: true, field: "stateCode" });
    }
    const stateName = GST_STATE_BY_CODE[stateCode] ?? null;

    const admin = createAdminClient();

    /* ── Payment mode (the /buy/workspace gates) ─────────────────────────────── */
    const keys = await loadCheckoutRazorpayKeys(admin, tenantId);
    const isSimulation = input.simulate === true;
    if (isSimulation && !simulatedPaymentAllowed({ razorpayKeyId: keys?.keyId ?? "" })) {
      return fail(400, `Test payments are switched off here. ${NOTHING_CHARGED}`);
    }
    if (!isSimulation && !keys) {
      return fail(503, `Online payment isn't set up yet. ${NOTHING_CHARGED} Please contact us and we'll send you a GST quote.`);
    }

    /* ── The price: the server's book, never the browser ─────────────────────── */
    const book = await getPriceBook(tenantId);
    const price = bookSupportPrice(book, input.plan, input.term);
    const item = await supportItem(admin, tenantId, input.plan, input.term);
    const order = item ? buildSupportOrder({ plan: input.plan, term: input.term, price, item }) : null;
    if (!order) {
      console.error(`[checkout/support] ${input.plan}/${input.term} not sellable: price ${price}, catalogue row ${item ? item.id : "missing"}`);
      return fail(503, `This plan can't be bought online right now. ${NOTHING_CHARGED} Please contact us and we'll set it up for you.`);
    }

    /* ── The customer ─────────────────────────────────────────────────────────── */
    const customer = await attachableCustomer(admin, tenantId, input.billingCustomerId ?? "", email);
    if (customer) {
      /* One paid support plan at a time: a second one would bill twice for the same desk. A
         change of plan is the desk's pro-rata upgrade (R-2073), not a second purchase. */
      const { data: current } = await admin
        .from("subscriptions")
        .select("id, plan, renewal_date")
        .eq("tenant_id", tenantId)
        .eq("customer_id", customer.id)
        .eq("vendor", "support")
        .eq("status", "active")
        .limit(1);
      const cur = (current ?? [])[0] as { plan: string | null; renewal_date: string | null } | undefined;
      if (cur) {
        return fail(409,
          `You already have ${cur.plan ?? "a support plan"}${cur.renewal_date ? `, paid until ${cur.renewal_date}` : ""}. ${NOTHING_CHARGED} ` +
          "To change plans, contact us — we'll move you over and credit the unused part.",
          { alreadySubscribed: true });
      }
    }

    /* ── Lead (stage quote) ───────────────────────────────────────────────────── */
    const leadId = "L-" + Date.now().toString(36).toUpperCase();
    const attribution = captureFromRequest(request, (body ?? {}) as Record<string, unknown>);
    const { error: leadErr } = await admin.from("leads").insert({
      id: leadId,
      tenant_id: tenantId,
      company: companyName,
      contact_name: fullName,
      contact_email: email,
      contact_phone: input.phone.trim(),
      plan: order.planLabel,
      seats: 1,
      value: order.subtotal,
      stage: "quote",
      source: isSimulation ? "buy-support-direct-sim" : "buy-support-direct",
      ...attribution,
      notes: [
        isSimulation ? "[SIMULATION] Test buy — no real payment" : "DIRECT BUY · support plan · proceeding to Razorpay",
        `Plan: ${order.tierName}`,
        `Total: ${rupee(order.amount)} (incl 18% GST)`,
        customer ? `Existing customer (from the support desk): ${customer.name ?? customer.id}` : null,
        validGstin ? `GSTIN: ${validGstin}` : null,
      ].filter(Boolean).join("\n"),
      state_code: stateCode,
      state: stateName,
      gstin: validGstin,
      ...(customer ? { customer_id: customer.id } : {}),
    });
    if (leadErr) {
      console.error("[checkout/support] lead insert failed:", leadErr.message);
      return fail(500, `Could not start checkout. ${NOTHING_CHARGED} Please try again.`);
    }

    /* ── Quote ────────────────────────────────────────────────────────────────── */
    const { data: qid, error: numErr } = await admin.rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: tenantId });
    if (numErr || !qid) {
      console.error("[checkout/support] next_document_number failed:", numErr?.message);
      return fail(500, `Could not start checkout. ${NOTHING_CHARGED} Please try again.`);
    }
    const quoteId = qid as string;
    const createdDate = istToday();
    const { data: inserted, error: qErr } = await admin.from("quotes").insert({
      id: quoteId,
      tenant_id: tenantId,
      customer_id: customer?.id ?? null,
      customer_name: customer?.name?.trim() || companyName,
      lead_id: leadId,
      plan: order.planLabel,
      seats: 1,
      line_items: [order.line],
      subtotal: order.subtotal,
      total_cost: 0,
      discount_pct: 0,
      tax_rate: 18,
      amount: order.amount,
      status: "sent",
      payment_status: "awaiting",
      owner_id: null,
      created_date: createdDate,
      expires_date: addDaysISO(createdDate, 7),
      notes: isSimulation ? "[SIMULATION] Test buy from /buy/support." : "Ordered online.",
      ...attribution,
      /* Monthly is one month of a monthly subscription — its invoice is the subscription's
         instalment, like the Workspace monthly order (R-1967 / R-1974). */
      ...(input.term === "monthly" ? { billing_cycle: "monthly" } : {}),
    }).select("public_token").single();
    if (qErr || !inserted?.public_token) {
      console.error("[checkout/support] quote insert failed:", qErr?.message ?? "no public_token");
      return fail(500, `Could not save your order. ${NOTHING_CHARGED} Please try again.`);
    }
    const publicToken = inserted.public_token as string;

    if (isSimulation) {
      const { error: rpcErr } = await admin.rpc("record_payment", {
        p_quote_id: quoteId,
        p_amount: order.amount,
        p_method: "razorpay",
        p_reference: `SIM-${quoteId}-${Date.now().toString(36).toUpperCase()}`,
        p_notes: `[SIMULATION] Test payment for ${order.tierName}`,
      });
      if (rpcErr) {
        const e = publicDbError("checkout/support", rpcErr, `The test payment could not be recorded. ${NOTHING_CHARGED} Please try again.`);
        return fail(e.status, e.message);
      }
      await issueInvoiceForOnlinePayment(admin, { quoteId, tenantId, logTag: "[checkout/support] simulated" });
      return NextResponse.json({ success: true, simulated: true, quoteId, publicToken, tierName: order.tierName, totalRupees: order.amount });
    }

    const rz = keys!;
    const razorpay = new Razorpay({ key_id: rz.keyId, key_secret: rz.keySecret });
    const rzOrder = await razorpay.orders.create({
      amount: order.amount * 100,
      currency: "INR",
      receipt: quoteId,
      notes: {
        quoteId, leadId,
        company: companyName, contact: fullName, email, phone: input.phone.trim(),
        tierName: order.tierName, seats: "1", domain: "",
      },
    });
    const { error: refErr } = await admin.from("quotes").update({ payment_reference: rzOrder.id }).eq("id", quoteId).eq("tenant_id", tenantId);
    if (refErr) {
      /* Without the reference verify cannot find the order — do not open a payment window for it. */
      console.error("[checkout/support] payment_reference not saved:", refErr.message);
      return fail(500, `Could not start the payment. ${NOTHING_CHARGED} Please try again.`);
    }

    return NextResponse.json({
      success: true,
      orderId: rzOrder.id,
      amount: order.amount * 100,
      currency: "INR",
      razorpayKeyId: rz.keyId,
      razorpayMode: rz.mode,
      quoteId,
      publicToken,
      tierName: order.tierName,
      totalRupees: order.amount,
    });
  } catch (err) {
    console.error("[/api/public/checkout/support] crashed:", err instanceof Error ? err.message : "unknown");
    return fail(500, `Something went wrong. ${NOTHING_CHARGED} Please try again.`);
  }
}
