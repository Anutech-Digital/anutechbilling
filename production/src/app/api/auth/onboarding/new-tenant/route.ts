/**
 * POST /api/auth/onboarding/new-tenant   { companyName, gstin?, businessType?, sellMode? }
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
 *
 * R-1843: businessType (proprietor | partnership | llp | pvt_ltd) is optional — the /welcome
 * question. Missing / null leaves tenants.business_type empty (= Pvt Ltd until the owner sets
 * it in Settings); any other value is a 400, nothing created.
 *
 * R-1860: sellMode (subscriptions | one_time | both) is optional too — the /welcome "What do you
 * sell?" question. Missing / null / 'both' writes nothing (the column default is Both); any other
 * value is a 400. Stored with a separate update after the tenant insert, so a workspace is still
 * created on a database that does not have tenants.sell_mode yet.
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { initials } from "@/lib/utils";
import { normalizeEmail } from "@/lib/auth/membership";
import { emailDomain, isPublicEmailDomain } from "@/lib/auth/domain";
import { routeVerifiedSignupToCompany } from "@/lib/auth/tenant-match";
import { SELL_MODES, type SellMode } from "@/lib/sell-mode";

const schema = z.object({
  companyName: z.string().trim().min(2, "Company name is required").max(120),
  gstin:       z.string().trim().max(20).optional().nullable(),
  businessType: z.enum(["proprietor", "partnership", "llp", "pvt_ltd"], {
    message: "Pick Proprietorship, Partnership, LLP or Private Limited — or leave it empty and set it later in Settings.",
  }).optional().nullable(),
  sellMode: z.enum(SELL_MODES as [SellMode, ...SellMode[]], {
    message: "Pick Subscriptions, One-time products & services or Both — you can change it later in Settings.",
  }).optional().nullable(),
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
  const routed = await routeVerifiedSignupToCompany({
    authUserId: authUser.id,
    email,
    fullName,
    appUrl:     trustedOrigin(request.headers), // R-723
    note:       `Tried to create a workspace named "${parsed.data.companyName}".`,
  });
  if (routed) {
    return NextResponse.json({ ok: true, status: "pending_approval", tenantName: routed.tenantName });
  }

  const tenantId = crypto.randomUUID();
  /* business_type is newer than the generated types (lib/compliance/profile.ts), so the row is
     built first — the insert still checks every typed column. */
  const tenantRow = {
    id:    tenantId,
    name:  parsed.data.companyName,
    email,
    gstin: parsed.data.gstin || null,
    tier:  "reseller" as const,
    business_type: parsed.data.businessType ?? null,
  };
  const { error: tenantErr } = await admin.from("tenants").insert(tenantRow);
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

  // R-1860: what this business sells. Not 'both' (the column default) → store it. A failure
  // here never undoes the workspace — the owner can set it in Settings → Company.
  const sellMode = parsed.data.sellMode;
  if (sellMode && sellMode !== "both") {
    const { error } = await (admin.from("tenants") as unknown as {
      update: (row: { sell_mode: SellMode }) => { eq: (c: string, v: string) => Promise<{ error: { message: string } | null }> };
    }).update({ sell_mode: sellMode }).eq("id", tenantId);
    if (error) console.warn("[onboarding/new-tenant] sell mode not saved:", error.message);
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
