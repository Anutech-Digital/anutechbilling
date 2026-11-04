/**
 * GET /api/tenant/pay-methods — can this workspace take a Razorpay payment?
 *
 * R-038. The invoice PDF may only name a payment route the seller actually has, and
 * that fact lives in `tenant_secrets`, which is owner-only under RLS. The customer-
 * facing PDF (`/api/v1/documents/invoice/[id]/pdf`) reads it with the admin client and
 * is fine; the IN-APP "Download PDF" button runs in the browser, as whatever staff
 * member pressed it, and cannot.
 *
 * Without this, the same invoice would download differently depending on which door it
 * came out of — the drift this codebase keeps paying for (see the logo comment in
 * quotes/[id]/page.tsx: "a logo on one and a monogram on the other is the kind of
 * difference nobody reports and everybody notices").
 *
 * What it returns is a yes/no, never a credential: no key id, no prefix, no mask. The
 * mode is already surfaced by the owner-only integrations route for the people
 * entitled to see it. Any authenticated member of the tenant may ask this question,
 * because any of them can print an invoice.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { razorpayReadiness } from "@/lib/payments/razorpay-readiness";
import { liveKeyCheckoutRefusal } from "@/lib/checkout/live-guards";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

export async function GET() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: me, error: meErr } = await supabase
    .from("users").select("tenant_id").eq("id", authData.user.id).maybeSingle();
  if (meErr) {
    /* §2 / L84: a failed read is not "no Razorpay". Say so, and let the caller decide —
       which for the PDF means leaving the line off rather than inventing either answer. */
    return NextResponse.json(
      { error: "Could not read your workspace. Try again." },
      { status: 503 },
    );
  }
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "No workspace on your account" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: secrets, error } = await admin
    .from("tenant_secrets")
    .select("razorpay_key_id, razorpay_key_secret, razorpay_webhook_secret")
    .eq("tenant_id", me.tenant_id)          // ← the whole tenant boundary for this read
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "Could not read payment settings" }, { status: 503 });
  }

  /* `canCollect`, not `state === "ready"`. The question a customer's invoice answers is
     "can I pay this by card/UPI through Razorpay", and a collect-only workspace can
     take that payment — it just will not reconcile it by itself, which is the
     operator's problem and is already shouted about on the integrations card. */
  const readiness = razorpayReadiness({
    keyId:         secrets?.razorpay_key_id ?? null,
    keySecret:     secrets?.razorpay_key_secret ?? null,
    webhookSecret: secrets?.razorpay_webhook_secret ?? null,
  });

  /* R-2155: staging with a live key cannot take a Razorpay payment — the PDF must not offer one. */
  return NextResponse.json({
    razorpayConfigured: readiness.canCollect && !liveKeyCheckoutRefusal(secrets?.razorpay_key_id),
  });
}
