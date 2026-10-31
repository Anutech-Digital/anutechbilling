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
 *
 * R-2119 (GP-05, G-PERSONAL): { kind: 'personal', consent: true, marketing? } makes a free
 * PERSONAL workspace instead (createPersonal below) — behind PERSONAL_SIGNUP_ENABLED, 404 when off.
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
import { personalSignupEnabled, PERSONAL_HOME, PERSONAL_SIGNUP_OFF } from "@/lib/personal/signup-flag";
import { recordAccountConsent } from "@/lib/consent/account-consent.server";
import {
  createPersonalWorkspace,
  finishPersonalWorkspace,
  personalConsentChoices,
  personalName,
  PERSONAL_CONSENT_VERSION,
} from "@/lib/personal/personal-workspace.server";

const schema = z.object({
  companyName: z.string({ required_error: "Company name is required", invalid_type_error: "Company name is required" }).trim().min(2, "Company name is required").max(120),
  gstin:       z.string().trim().max(20).optional().nullable(),
  businessType: z.enum(["proprietor", "partnership", "llp", "pvt_ltd"], {
    message: "Pick Proprietorship, Partnership, LLP or Private Limited — or leave it empty and set it later in Settings.",
  }).optional().nullable(),
  sellMode: z.enum(SELL_MODES as [SellMode, ...SellMode[]], {
    message: "Pick Subscriptions, One-time products & services or Both — you can change it later in Settings.",
  }).optional().nullable(),
});

/* R-2119 (GP-05): the personal branch — no companyName, no business type, no sell mode. */
const personalSchema = z.object({
  kind:      z.literal("personal"),
  consent:   z.boolean().optional().nullable(),
  marketing: z.boolean().optional().nullable(),
});

export async function POST(request: NextRequest) {
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const isPersonal = raw?.kind === "personal";
  /* R-2119: behind PERSONAL_SIGNUP_ENABLED (default off) the personal door does not exist. */
  if (isPersonal && !personalSignupEnabled()) {
    return NextResponse.json(PERSONAL_SIGNUP_OFF, { status: 404 });
  }

  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const authUser = authData.user;

  if (isPersonal) return createPersonal(request, authUser, raw);

  const parsed = schema.safeParse(raw);
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

type SessionUser = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

/**
 * R-2119 (GP-05, G-PERSONAL): the Google / Auth.js door of a free personal account.
 *
 * Order: consent tick required (400) → existing users row keeps the 409 → the email must be
 * confirmed (403) → consent proof (no proof = nothing created) → personal tenant + users row
 * (admin client; workspace_kind is platform-owned, R-720) → consent tenant + identity link (D4).
 * Never decideOnboarding / work-domain routing, never a domain claim: a personal account is
 * one person's own, whatever their email domain.
 */
async function createPersonal(request: NextRequest, authUser: SessionUser, raw: unknown) {
  const parsed = personalSchema.safeParse(raw);
  if (!parsed.success || parsed.data.consent !== true) {
    return NextResponse.json(
      { error: "Tick the box to accept the Terms and Privacy Policy and let us process your money records.", field: "consent" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
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

  if (!authUser.email_confirmed_at) {
    return NextResponse.json(
      { error: "Confirm your email first — open the link we sent you, then come back here." },
      { status: 403 },
    );
  }

  const email = normalizeEmail(authUser.email);
  const fullName = personalName(
    (authUser.user_metadata?.full_name as string | undefined) || (authUser.user_metadata?.name as string | undefined),
    email,
  );

  const recorded = await recordAccountConsent(admin, {
    userId: authUser.id,
    tenantId: null,
    purposes: personalConsentChoices(parsed.data.marketing === true),
    version: PERSONAL_CONSENT_VERSION,
    req: request,
    source: "signup",
    page: "/welcome",
  });
  if (!recorded) {
    return NextResponse.json({ error: "Could not save your consent. Nothing was created — please try again." }, { status: 500 });
  }

  const ws = await createPersonalWorkspace(admin, { userId: authUser.id, email, fullName });
  if (!ws.ok) {
    return NextResponse.json({ error: "Could not create your personal space. Please try again." }, { status: 500 });
  }
  if (!ws.created) {
    return NextResponse.json({ error: "You already belong to a workspace.", tenantId: ws.tenantId }, { status: 409 });
  }

  await finishPersonalWorkspace(admin, authUser.id, ws.tenantId);
  return NextResponse.json({ ok: true, tenantId: ws.tenantId, kind: "personal", next: PERSONAL_HOME });
}
