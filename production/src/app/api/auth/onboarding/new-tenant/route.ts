/**
 * POST /api/auth/onboarding/new-tenant   { companyName, gstin? }
 *
 * Creates the workspace that the OAuth callback used to create by itself.
 *
 * ─── THE ONLY REAL CHANGE IS WHO DECIDED ─────────────────────────────────────
 * The rows written here are the same rows the callback wrote before. What is
 * different is that a person read a screen saying "this creates a NEW company"
 * and clicked. That single difference is the whole fix: the four accidental
 * tenants in this database were not created by bad code, they were created by
 * code answering a question nobody had asked it.
 *
 * Requires an authenticated session and NO existing users row — a person who
 * already has a workspace cannot mint a second one from here.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { initials } from "@/lib/utils";
import { normalizeEmail } from "@/lib/auth/membership";
import { emailDomain, isPublicEmailDomain } from "@/lib/auth/domain";
import { routeVerifiedSignupToCompany } from "@/lib/auth/tenant-match";

const schema = z.object({
  companyName: z.string().trim().min(2, "Company name is required").max(120),
  gstin:       z.string().trim().max(20).optional().nullable(),
});

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const authUser = authData.user;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Enter your company name." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Already in a workspace? Then this screen is stale — send them home rather
  // than creating a duplicate company for someone who already has one.
  const { data: existing } = await admin
    .from("users")
    .select("tenant_id")
    .eq("id", authUser.id)
    .maybeSingle();
  if (existing?.tenant_id) {
    return NextResponse.json(
      { error: "You already belong to a workspace.", tenantId: existing.tenant_id },
      { status: 409 },
    );
  }

  const email = normalizeEmail(authUser.email);
  const fullName =
    (authUser.user_metadata?.full_name as string | undefined) ||
    (authUser.user_metadata?.name as string | undefined) ||
    email.split("@")[0] ||
    "New user";

  // R-822: their company already uses ResellerOS → no second workspace. A signed-in
  // person's address is verified (Google, or the R-048 link), so the request goes
  // straight to that owner. This is the door the Google / Auth.js first login reaches
  // through /welcome, so it must follow the same rule as the callback.
  const fwdHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto   = request.headers.get("x-forwarded-proto") ?? "https";
  const routed = await routeVerifiedSignupToCompany({
    authUserId: authUser.id,
    email,
    fullName,
    appUrl:     fwdHost ? `${proto}://${fwdHost}` : (process.env.NEXT_PUBLIC_APP_URL ?? ""),
    note:       `Tried to create a workspace named "${parsed.data.companyName}".`,
  });
  if (routed) {
    return NextResponse.json({ ok: true, status: "pending_approval", tenantName: routed.tenantName });
  }

  const tenantId = crypto.randomUUID();
  const { error: tenantErr } = await admin.from("tenants").insert({
    id:    tenantId,
    name:  parsed.data.companyName,
    email,
    gstin: parsed.data.gstin || null,
    tier:  "reseller",
  });
  if (tenantErr) {
    console.error("[onboarding/new-tenant] tenant insert failed:", tenantErr.message);
    return NextResponse.json({ error: "Could not create the workspace. Please try again." }, { status: 500 });
  }

  const { error: userErr } = await admin.from("users").insert({
    id:        authUser.id,
    tenant_id: tenantId,
    email,
    full_name: fullName,
    initials:  initials(fullName),
    role:      "owner",
    color:     "amber",
  });
  if (userErr) {
    // Roll back so a failed attempt cannot leave an ownerless tenant behind —
    // that is one of the shapes the /platform signup list has to explain away.
    await admin.from("tenants").delete().eq("id", tenantId);
    console.error("[onboarding/new-tenant] users insert failed:", userErr.message);
    return NextResponse.json({ error: "Could not finish setting you up. Please try again." }, { status: 500 });
  }

  // Claim this company's own domain, UNVERIFIED. Unverified routes nobody
  // (0242), so this cannot misfire — it just means the next colleague who signs
  // up is visible as a pending request instead of vanishing into a new tenant,
  // once an owner verifies the claim.
  const domain = emailDomain(email);
  if (domain && !isPublicEmailDomain(domain)) {
    const { error } = await admin.from("tenant_domains").insert({ tenant_id: tenantId, domain });
    if (error && error.code !== "23505") {
      console.warn("[onboarding/new-tenant] domain claim skipped:", error.message);
    }
  }

  return NextResponse.json({ ok: true, tenantId });
}
