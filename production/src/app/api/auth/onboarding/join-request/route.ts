/**
 * POST /api/auth/onboarding/join-request   { company }
 *
 * "My company already uses ResellerOS" — the manual counterpart to the automatic
 * domain match. `company` is a domain (`anutech.in`) or any address at it
 * (`pardeep@anutech.in`); both reduce to the same thing.
 *
 * ─── THE RESPONSE IS DELIBERATELY THE SAME EITHER WAY ────────────────────────
 * Whether or not a workspace was found, this answers "if that workspace exists,
 * its owner has been asked". Anything more precise turns this endpoint into a
 * directory: type domains, learn which companies use ResellerOS and therefore who
 * their reseller is. That is a competitor's shopping list, not a feature.
 *
 * The cost is a worse error message for someone who mistypes their own domain.
 * That is covered instead by prefilling the field with their own — which is the
 * right answer in nearly every real case, and leaks nothing, because they already
 * control that address.
 *
 * Nothing here grants access. It writes one `join_requests` row, and an owner
 * still has to approve it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeEmail } from "@/lib/auth/membership";
import { emailDomain, isPublicEmailDomain } from "@/lib/auth/domain";
import { openJoinRequest, notifyOwnerOfJoinRequest } from "@/lib/auth/tenant-match";

const schema = z.object({
  company: z.string().trim().min(3).max(200),
  note:    z.string().trim().max(500).optional().nullable(),
});

/** Same wording for found and not-found. See the header. */
const GENERIC =
  "If that workspace is on ResellerOS, we've asked its owner to add you. You'll be able to sign in once they approve.";

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
      { error: "Enter your work email domain, for example anutech.in" },
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

  // "anutech.in" and "pardeep@anutech.in" both reduce to "anutech.in".
  const raw = parsed.data.company.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const domain = raw.includes("@") ? emailDomain(raw) : raw.replace(/^www\./, "");

  if (!domain || !domain.includes(".") || isPublicEmailDomain(domain)) {
    // A consumer provider can never be a workspace's domain, and saying so is not
    // a leak — it is true of every tenant.
    return NextResponse.json({
      ok: true,
      message: "Use your work email domain (like anutech.in), not a personal mail provider.",
      matched: false,
    });
  }

  const { data: claim } = await admin
    .from("tenant_domains")
    .select("tenant_id, tenants(name)")
    .eq("domain", domain)
    .maybeSingle();

  if (!claim?.tenant_id) {
    return NextResponse.json({ ok: true, message: GENERIC, matched: false });
  }

  const rel = (claim as { tenants?: { name?: string } | Array<{ name?: string }> }).tenants;
  const tenantName = (Array.isArray(rel) ? rel[0]?.name : rel?.name) ?? "that workspace";

  const email = normalizeEmail(authUser.email);
  const fullName =
    (authUser.user_metadata?.full_name as string | undefined) ||
    (authUser.user_metadata?.name as string | undefined) ||
    email.split("@")[0] ||
    null;

  const parked = await openJoinRequest({
    tenantId:   claim.tenant_id,
    email,
    fullName,
    authUserId: authUser.id,
    matchedBy:  "manual",
    note:       parsed.data.note ?? null,
  });

  if (parked.ok) {
    await notifyOwnerOfJoinRequest({
      tenantId:   claim.tenant_id,
      tenantName,
      email,
      fullName,
      appUrl:     trustedOrigin(request.headers), // R-723
    });
  }

  return NextResponse.json({ ok: true, message: GENERIC, matched: false });
}
