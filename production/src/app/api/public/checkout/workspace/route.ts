/**
 * POST /api/public/checkout/workspace
 *
 * Public direct-buy endpoint for the /buy/workspace landing page.
 * Triggered when a visitor clicks "Buy now" on a pricing card — skips the
 * Pardeep-in-the-loop quote review and goes straight to Razorpay checkout.
 *
 * Flow:
 *   1. Validate the form (name, company, email, phone, domain, seats, tier, GSTIN optional)
 *   2. Compute the GST-inclusive total
 *   3. Insert a `leads` row with stage='quote' (intent to buy)
 *   4. Insert a `quotes` row (draft, with line_items + tax_rate + payment_status='awaiting')
 *   5. Create a Razorpay Order — store our quote ID in `receipt` for webhook lookup
 *   6. Return { orderId, amount, currency, razorpayKeyId, quoteId, leadId }
 *
 * The client then opens Razorpay.Checkout({ order_id }) and the visitor pays.
 * On success, Razorpay POSTs to /api/webhooks/razorpay — that's where we
 * mark the quote paid and create the customer + subscription.
 *
 * Security:
 *   - Admin client used (bypasses RLS — no session)
 *   - Razorpay key secret never sent to client (only `razorpayKeyId` which is public)
 *   - Webhook signature verification done in the webhook route, not here
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import Razorpay from "razorpay";
import { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

// Razorpay credentials — read from per-tenant `tenant_secrets` first
// (Settings → Integrations → Razorpay), falling back to env for the
// legacy single-tenant dogfood case. Resolution happens inside the
// route handler so it can hit the DB.
const ENV_RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID?.trim() || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() || "";
const ENV_RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim() || "";

// Email config — used for simulated-payment confirmations.
const FROM_EMAIL    = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const PARDEEP_EMAIL = "Pardeep@exceltechnologies.in";

const checkoutSchema = z.object({
  fullName:    z.string().min(2).max(120),
  companyName: z.string().min(2).max(200),
  email:       z.string().email().max(200),
  phone:       z.string().min(10).max(20),
  seats:       z.coerce.number().int().min(1).max(10000),
  domain:      z.string().min(3).max(120),
  tierId:      z.enum(["starter", "standard", "plus", "enterprise"]),
  gstin:       z.string().optional(),
  /** Optional coupon code. Validated + redeemed server-side via the
   *  redeem_coupon RPC AFTER the quote row exists, so the redemption row
   *  carries the quote_id linkage for the audit log. */
  couponCode:  z.string().min(2).max(50).optional(),
  /** When true AND Razorpay isn't configured, the route skips order creation
   *  and instead calls record_payment directly so Pardeep can walk the full
   *  conversion funnel before he has Razorpay keys. Refused when Razorpay
   *  IS configured (would let attackers create free orders). */
  simulate:    z.boolean().optional(),
});

// Last-resort fallback ₹/user/month — used only when the catalog lookup
// returns no row (e.g. SKU was disabled while a visitor was on the page).
// MUST match the seeded catalog MSRP (retail) defaults so a catalog-miss can
// never charge a different price than enquiry/quote (audit fix #10).
// (The enquiry route shares src/lib/pricing/workspace.ts; this in-file copy is
// kept catalog-aligned — TODO: adopt the shared module here too for full DRY.)
const TIER_FALLBACK_MONTHLY: Record<string, number> = {
  starter:    270,
  standard:   864,
  plus:       1380,
  enterprise: 2400,
};

const TIER_DISPLAY_NAME: Record<string, string> = {
  starter:    "Business Starter",
  standard:   "Business Standard",
  plus:       "Business Plus",
  enterprise: "Enterprise",
};

interface QuoteLine {
  id:          string;
  name:        string;
  qty:         number;
  rate:        number;
  cost:        number;
  commitment:  "annual_yearly";
}

interface CatalogPriceRow {
  id:        string;
  name:      string;
  msrp:      number;
  wholesale: number | null;
  prices: {
    annual?:  { msrp: number; wholesale: number };
    monthly?: { msrp: number; wholesale: number };
  } | null;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Fetch the catalog row for a given tier slug. Substring match on
 * `Google Workspace <Tier>` because the catalog stores full SKU names
 * ("Google Workspace Business Standard").
 */
async function fetchCatalogPrice(
  admin: AdminClient,
  tierId: string,
): Promise<CatalogPriceRow | null> {
  const namePart =
    tierId === "starter"    ? "Starter"    :
    tierId === "standard"   ? "Standard"   :
    tierId === "plus"       ? "Plus"       :
    tierId === "enterprise" ? "Enterprise" : null;
  if (!namePart) return null;

  const { data, error } = await admin
    .from("items")
    .select("id, name, msrp, wholesale, prices")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("vendor",    "google")
    .eq("kind",      "main")
    .eq("is_active", true)
    .ilike("name", `Google Workspace ${namePart}%`)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[checkout/workspace] catalog lookup failed:", error);
    return null;
  }
  return (data as CatalogPriceRow | null) ?? null;
}

/**
 * Resolve the ₹/user/month MSRP for a tier. Source of truth = catalog
 * `prices.annual.msrp`, with `items.msrp` and the in-file fallback as
 * defence-in-depth. Returns `0` only if literally nothing is available.
 */
function resolveMonthlyMsrp(row: CatalogPriceRow | null, tierId: string): number {
  if (row) {
    const annualMonthly = row.prices?.annual?.msrp;
    if (Number.isFinite(annualMonthly) && (annualMonthly ?? 0) > 0) return annualMonthly!;
    if (Number.isFinite(row.msrp) && row.msrp > 0) return row.msrp;
  }
  return TIER_FALLBACK_MONTHLY[tierId] ?? 0;
}

/**
 * Compose the quote line items + GST-inclusive total from the (catalog,
 * tierId, seats) tuple. Single source of pricing for the whole route.
 */
function buildLinesFromCatalog(
  row: CatalogPriceRow | null,
  tierId: string,
  seats: number,
) {
  const monthly  = resolveMonthlyMsrp(row, tierId);
  const rate     = monthly * 12;  // ₹/seat/year — what we store on line items
  const tierName = row?.name?.replace(/^Google Workspace\s*/i, "")
                || TIER_DISPLAY_NAME[tierId]
                || "Workspace";
  const items: QuoteLine[] = [{
    id:         globalThis.crypto?.randomUUID() ?? Math.random().toString(36).slice(2),
    name:       row?.name ?? `Google Workspace · ${tierName} (annual)`,
    qty:        seats,
    rate,
    cost:       0,
    commitment: "annual_yearly",
  }];
  const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
  const amount   = Math.round(subtotal * 1.18);
  return { items, subtotal, amount, tierName, monthlyMsrp: monthly };
}

export async function POST(request: NextRequest) {
  try {
    const body   = await request.json();
    const parsed = checkoutSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid checkout: " + parsed.error.issues.map(i => i.message).join(", ") },
        { status: 400 },
      );
    }
    const { fullName, companyName, email, phone, seats, domain, tierId, gstin, simulate, couponCode } = parsed.data;

    // ── Resolve Razorpay credentials ─────────────────────────────────────
    // Precedence: per-tenant `tenant_secrets` (Settings → Integrations)
    // → process.env (legacy single-tenant dogfood) → none (sim mode).
    let rzKeyId:     string = "";
    let rzKeySecret: string = "";
    let rzMode:      "test" | "live" = "test";
    {
      const adminEarly = createAdminClient();
      const { data: secrets } = await adminEarly
        .from("tenant_secrets")
        .select("razorpay_key_id, razorpay_key_secret, razorpay_mode")
        .eq("tenant_id", BUY_PAGE_TENANT_ID)
        .maybeSingle();
      if (secrets?.razorpay_key_id && secrets.razorpay_key_secret) {
        rzKeyId     = secrets.razorpay_key_id;
        rzKeySecret = secrets.razorpay_key_secret;
        rzMode      = secrets.razorpay_mode === "live" ? "live" : "test";
      } else if (ENV_RAZORPAY_KEY_ID && ENV_RAZORPAY_KEY_SECRET) {
        rzKeyId     = ENV_RAZORPAY_KEY_ID;
        rzKeySecret = ENV_RAZORPAY_KEY_SECRET;
        rzMode      = ENV_RAZORPAY_KEY_ID.startsWith("rzp_live_") ? "live" : "test";
      }
    }

    // ── Mode resolution ───────────────────────────────────────────────────
    // Live  : Razorpay configured → create real Order, return widget creds.
    // Sim   : Razorpay NOT configured + client passed simulate=true → run
    //         the full lead/quote/record_payment flow without Razorpay.
    // Else  : Razorpay missing + no simulate flag → return 503 (legacy).
    const razorpayConfigured = Boolean(rzKeyId) && Boolean(rzKeySecret);
    const isSimulation       = simulate === true;

    // Simulated checkout is a preview tool — only when explicitly allowed
    // (non-prod, or ALLOW_SIMULATED_CHECKOUT=1). In production without that
    // flag, a crafted simulate:true must NOT create a fake "paid" customer,
    // even if the UI button is already hidden. Server is the real gate.
    const simulationAllowed =
      process.env.ALLOW_SIMULATED_CHECKOUT === "1" ||
      process.env.NODE_ENV !== "production";

    if (!razorpayConfigured && !isSimulation) {
      return NextResponse.json(
        { error: "Razorpay is not configured yet. Please use the 'Get a quote' option for now." },
        { status: 503 },
      );
    }
    if (isSimulation && !simulationAllowed) {
      return NextResponse.json(
        { error: "Online payment isn't available yet. Please use the 'Get a quote' option." },
        { status: 503 },
      );
    }
    if (razorpayConfigured && isSimulation) {
      // Once live, simulation must be off — otherwise anyone could create
      // free "paid" orders. Defence-in-depth alongside the client gating.
      return NextResponse.json(
        { error: "Simulation is disabled in live mode." },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    // Pricing source of truth = catalog. If Pardeep edits item MSRP, the
    // next checkout immediately reflects it — no re-deploy needed.
    const catalogRow = await fetchCatalogPrice(admin, tierId);
    const built      = buildLinesFromCatalog(catalogRow, tierId, seats);
    const items      = built.items;
    const tierName   = built.tierName;
    let   subtotal   = built.subtotal;
    let   amount     = built.amount;
    // Site-promo + coupon results carried through the response — quote row
    // + lead notes get discount lines so Pardeep sees what was claimed.
    let   sitePromoDiscount: number       = 0;
    let   sitePromoId:       string | null = null;
    let   sitePromoHeadline: string | null = null;
    let   couponDiscount:    number       = 0;
    let   appliedCouponCode: string | null = null;

    if (amount <= 0) {
      return NextResponse.json(
        { error: "Direct purchase isn't available for this tier. Please request a quote." },
        { status: 400 },
      );
    }

    // ── Site promo — auto-applied online sale (no code needed). Direct
    //    table query — service_role bypasses RLS. Applied BEFORE coupon
    //    so coupon stacks on top of the post-promo subtotal.
    {
      const nowIso = new Date().toISOString();
      let q = admin
        .from("site_promos")
        .select("*")
        .eq("tenant_id", BUY_PAGE_TENANT_ID)
        .eq("is_active", true)
        .lte("valid_from", nowIso)
        .or(`applies_to_tier.is.null,applies_to_tier.eq.${tierId}`)
        .lte("min_seats", seats)
        .order("updated_at", { ascending: false })
        .limit(1);
      const { data: promoRow, error: promoErr } = await q.maybeSingle();
      if (promoErr) {
        console.error("[checkout/workspace] site_promo query failed:", promoErr);
      } else if (promoRow) {
        const ok =
          (!promoRow.valid_until || new Date(promoRow.valid_until).getTime() > Date.now()) &&
          (promoRow.max_seats == null || seats <= promoRow.max_seats);
        if (ok) {
          const raw = promoRow.discount_type === "percent"
            ? Math.round(subtotal * promoRow.discount_value / 100)
            : promoRow.discount_value;
          sitePromoDiscount = Math.min(raw, subtotal);
          sitePromoId       = promoRow.id;
          sitePromoHeadline = promoRow.headline;
          subtotal          = Math.max(0, subtotal - sitePromoDiscount);
          amount            = Math.round(subtotal * 1.18);
        }
      }
    }

    // ── Insert lead at stage='quote' (intent to buy = qualified) ──────────
    const cleanDomain = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();
    const leadId      = "L-" + Date.now().toString(36).toUpperCase();
    const planLabel   = `google-workspace-${tierId}`;
    const sourceTag   = isSimulation ? "buy-workspace-direct-sim" : "buy-workspace-direct";
    const leadNotes   = [
      isSimulation ? `[SIMULATION] Test buy — no real payment` : `DIRECT BUY · proceeding to Razorpay`,
      `Domain: ${cleanDomain}`,
      `Plan: Google Workspace ${tierName}`,
      `Seats: ${seats}`,
      `Total: ₹${amount.toLocaleString("en-IN")} (incl 18% GST)`,
      gstin ? `GSTIN: ${gstin}` : null,
    ].filter(Boolean).join("\n");

    const { error: leadErr } = await admin.from("leads").insert({
      id:            leadId,
      tenant_id:     BUY_PAGE_TENANT_ID,
      company:       companyName,
      contact_name:  fullName,
      contact_email: email,
      contact_phone: phone,
      plan:          planLabel,
      seats,
      value:         subtotal,
      stage:         "quote",
      source:        sourceTag,
      domain:        cleanDomain,        // structured — flows lead→quote→subscription
      notes:         leadNotes,
    });
    if (leadErr) {
      console.error("[checkout/workspace] lead insert failed:", leadErr);
      return NextResponse.json({ error: "Could not start checkout. Please retry." }, { status: 500 });
    }

    // ── Allocate a quote number + insert draft quote with payment_status='awaiting'
    // Quote-ID allocation is its own retry loop because next_document_number is
    // atomic but the subsequent INSERT can still collide on a concurrent buy.
    let quoteId: string | null = null;
    let quoteAllocated = false;
    for (let attempt = 1; attempt <= 3 && !quoteAllocated; attempt++) {
      const { data: qid, error: numErr } = await admin
        .rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: BUY_PAGE_TENANT_ID });
      if (numErr || !qid) {
        console.error("[checkout/workspace] next_document_number failed:", numErr);
        break;
      }
      quoteId = qid as string;
      quoteAllocated = true;
    }
    if (!quoteId) {
      return NextResponse.json({ error: "Could not allocate a quote number. Please retry." }, { status: 500 });
    }

    // ── Coupon — validated + redeemed via the atomic RPC, BEFORE we insert
    //    the quote so the quote row carries the discounted subtotal/amount.
    //    The RPC records a redemption row linked to this quote_id.
    //    Race condition: if the coupon hits max_redemptions between client
    //    validation and this call, the RPC refuses — visitor sees a clear
    //    error and the quote is never created.
    if (couponCode) {
      const { data: redeemRes, error: redeemErr } = await admin.rpc("redeem_coupon", {
        p_code:         couponCode.toUpperCase().trim(),
        p_tenant_id:    BUY_PAGE_TENANT_ID,
        p_tier_id:      tierId,
        p_seats:        seats,
        p_gross_amount: subtotal,
        p_quote_id:     quoteId,
        p_lead_id:      leadId,
        p_email:        email,
        p_name:         fullName,
      });
      if (redeemErr) {
        console.error("[checkout/workspace] redeem_coupon failed:", redeemErr);
        return NextResponse.json(
          { error: "Could not apply coupon: " + redeemErr.message },
          { status: 500 },
        );
      }
      if (!redeemRes?.ok) {
        return NextResponse.json(
          { error: `Coupon refused: ${redeemRes?.reason ?? "unknown"}` },
          { status: 400 },
        );
      }
      couponDiscount    = Math.min(redeemRes.discount ?? 0, subtotal);
      appliedCouponCode = (redeemRes.code as string) ?? couponCode.toUpperCase().trim();
      // Recompute pre-GST subtotal + GST-inclusive amount
      subtotal = Math.max(0, subtotal - couponDiscount);
      amount   = Math.round(subtotal * 1.18);
      // Reflect the discounted deal value on the lead — Pardeep's pipeline
      // KPIs should see the actual money that's coming in.
      await admin.from("leads").update({ value: subtotal }).eq("id", leadId);
    }

    // ── Insert the actual quote row with the (possibly-discounted) totals.
    const today   = new Date();
    const expires = new Date(today);
    expires.setDate(expires.getDate() + 7);

    const quoteNotes = [
      isSimulation
        ? `[SIMULATION] Test buy from /buy/workspace.`
        : `Direct buy from /buy/workspace. Razorpay order pending.`,
      sitePromoId
        ? `Online sale "${sitePromoHeadline}" auto-applied · −₹${sitePromoDiscount.toLocaleString("en-IN")} pre-GST`
        : null,
      appliedCouponCode
        ? `Coupon ${appliedCouponCode} applied · −₹${couponDiscount.toLocaleString("en-IN")} pre-GST`
        : null,
    ].filter(Boolean).join("\n");

    const { error: qErr } = await admin.from("quotes").insert({
      id:             quoteId,
      tenant_id:      BUY_PAGE_TENANT_ID,
      customer_id:    null,
      customer_name:  companyName,
      lead_id:        leadId,
      plan:           planLabel,
      seats,
      line_items:     items,
      subtotal,
      total_cost:     0,
      discount_pct:   0,
      tax_rate:       18,
      amount,                              // incl-GST total (what Razorpay charges)
      status:         "sent",              // direct buy — auto-sent
      payment_status: "awaiting",          // webhook flips to 'received'
      owner_id:       null,
      domain:         cleanDomain,         // structured — record_payment copies to subscription
      created_date:   today.toISOString().slice(0, 10),
      expires_date:   expires.toISOString().slice(0, 10),
      notes:          quoteNotes,
    });
    if (qErr) {
      console.error("[checkout/workspace] quote insert failed:", qErr);
      return NextResponse.json({ error: "Could not save quote. Please retry." }, { status: 500 });
    }

    // ═══════════════════════════════════════════════════════════════════
    // SIMULATION FLOW — skip Razorpay, call record_payment directly so
    // Pardeep can preview the full downstream effect (customer + sub +
    // emails) before he has real keys.
    // ═══════════════════════════════════════════════════════════════════
    if (isSimulation) {
      const simRef = `SIM-${quoteId}-${Date.now().toString(36).toUpperCase()}`;

      const { error: rpcErr } = await admin.rpc("record_payment", {
        p_quote_id:  quoteId,
        p_amount:    amount,
        p_method:    "razorpay",
        p_reference: simRef,
        p_notes:     `[SIMULATION] Test payment for ${tierName} · ${seats} users`,
      });
      if (rpcErr) {
        console.error("[checkout/workspace] simulated record_payment failed:", rpcErr);
        return NextResponse.json(
          { error: "Simulation failed: " + rpcErr.message },
          { status: 500 },
        );
      }

      // Best-effort confirmation emails — clearly tagged [TEST] in subject.
      const amountFmt = `₹${amount.toLocaleString("en-IN")}`;
      await Promise.allSettled([
        // Customer copy
        sendEmail({
          to:      email,
          from:    FROM_EMAIL,
          replyTo: PARDEEP_EMAIL,
          subject: `[TEST] Payment received · ${quoteId} · ${amountFmt}`,
          text:
`Hi ${fullName.split(" ")[0] || "there"},

THIS IS A TEST. No real payment was processed.

If this were a live order, your payment of ${amountFmt} for ${seats} users of
Google Workspace ${tierName} would have been received.

ORDER SUMMARY
  Order ID    ${quoteId}
  Plan        Google Workspace ${tierName}
  Seats       ${seats}
  Domain      ${cleanDomain}
  Total       ${amountFmt} (incl 18% GST)

— Pardeep Sharma
   Founder, Excel Technologies
   (Simulated email — system test only)`,
        }),
        // Pardeep alert — flagged clearly as test
        sendEmail({
          to:      PARDEEP_EMAIL,
          from:    FROM_EMAIL,
          subject: `[TEST 🧪] Simulated purchase · ${companyName} · ${amountFmt}`,
          text:
`A SIMULATED direct-buy was just submitted via /buy/workspace.

This is NOT a real payment — Razorpay keys are not configured yet.
Once you add RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET, real buys land in the same place.

COMPANY     ${companyName}
CONTACT     ${fullName} <${email}>
PLAN        Google Workspace ${tierName}
SEATS       ${seats}
DOMAIN      ${cleanDomain}
TOTAL       ${amountFmt}
ORDER ID    ${quoteId}
LEAD ID     ${leadId}
REFERENCE   ${simRef}

The quote has been marked PAID in the app and a customer record was created
(so you can see the full pipeline working). You may want to delete these
test rows before going live.`,
        }),
      ]);

      return NextResponse.json({
        success:        true,
        simulated:      true,
        quoteId,
        leadId,
        customerName:   fullName,
        tierName,
        seats,
        totalRupees:    amount,
        sitePromoId,
        sitePromoDiscount,
        couponCode:     appliedCouponCode,
        couponDiscount,
        message:        "Simulated payment recorded. Check the app for the new quote, lead, customer and payment.",
      });
    }

    // ═══════════════════════════════════════════════════════════════════
    // LIVE FLOW — create real Razorpay Order and return widget credentials
    // ═══════════════════════════════════════════════════════════════════
    const razorpay = new Razorpay({ key_id: rzKeyId, key_secret: rzKeySecret });
    const order    = await razorpay.orders.create({
      amount:       amount * 100,           // paise
      currency:     "INR",
      receipt:      quoteId,                 // ≤40 chars — Q-2025-26-0001 is fine
      notes:        {
        leadId,
        quoteId,
        company:      companyName,
        contact:      fullName,
        email,
        phone,
        domain:       cleanDomain,
        tierId,
        tierName,
        seats:        String(seats),
      },
    });

    // Store the Razorpay order ID on the quote so the webhook can reverse-lookup
    await admin.from("quotes")
      .update({ payment_reference: order.id })
      .eq("id", quoteId);

    return NextResponse.json({
      success:        true,
      orderId:        order.id,
      amount:         amount * 100,
      currency:       "INR",
      razorpayKeyId:  rzKeyId,
      razorpayMode:   rzMode,
      quoteId,
      leadId,
      // For the success modal — visitor sees a friendly confirmation
      customerName:   fullName,
      tierName,
      seats,
      totalRupees:    amount,
      sitePromoId,
      sitePromoDiscount,
      couponCode:     appliedCouponCode,
      couponDiscount,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/public/checkout/workspace] crashed:", m);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
