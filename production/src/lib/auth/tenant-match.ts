/**
 * Domain-based tenant matching — the half that touches the database.
 *
 * The decision itself lives in `domain.ts` and is pure. This module only fetches
 * what that decision needs, records the outcome, and tells a human about it.
 *
 * ─── EVERY FUNCTION HERE IS BEST-EFFORT ON PURPOSE ───────────────────────────
 * These run inside sign-up and OAuth callback. If a lookup, an insert, or a
 * WhatsApp notification fails, the person in front of the screen must still get a
 * coherent next step — a signup that 500s because a notification could not be
 * delivered is a worse outcome than a notification nobody received. So failures
 * are logged and swallowed, and each function returns something the caller can
 * still act on.
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsApp } from "@/lib/whatsapp/client";
import { sendEmail } from "@/lib/email/send";
import {
  emailDomain,
  isPublicEmailDomain,
  resolveDomainOwner,
  resolveOwnerDomainTenant,
  type DomainMatch,
  type OwnerDomainRecord,
  type TenantDomainRecord,
} from "./domain";
import type { TeamInviteRole } from "@/lib/supabase/database.types";

/**
 * The tenant that owns this address's domain — or null.
 *
 * Null for every "no signal" case, which are deliberately indistinguishable to
 * the caller: unparseable address, consumer mailbox provider, unknown domain, and
 * *claimed but unverified* domain. Only `verified_at is not null` routes anyone.
 */
export async function findVerifiedDomainTenant(
  email: string | null | undefined,
): Promise<DomainMatch | null> {
  const domain = emailDomain(email);
  if (!domain || isPublicEmailDomain(domain)) return null;

  const admin = createAdminClient();
  // Fetch by domain only. The verified-vs-claimed decision is NOT made here —
  // `resolveDomainOwner` makes it, so it is covered by tests that need no
  // database. Filtering it out in SQL would put a tenant-leak guard somewhere no
  // test can reach.
  const { data, error } = await admin
    .from("tenant_domains")
    .select("tenant_id, domain, verified_at, tenants(name)")
    .eq("domain", domain);

  if (error) {
    console.error("[tenant-match] domain lookup failed:", error.message);
    return null;
  }

  // The embedded relation comes back as an object or a single-element array
  // depending on how PostgREST resolves the FK; normalise both.
  const rows: TenantDomainRecord[] = (data ?? []).map((r) => {
    const rel = (r as { tenants?: { name?: string } | Array<{ name?: string }> }).tenants;
    return {
      tenant_id:   r.tenant_id,
      tenant_name: (Array.isArray(rel) ? rel[0]?.name : rel?.name) ?? "your company's workspace",
      domain:      r.domain,
      verified_at: r.verified_at,
    };
  });

  const verified = resolveDomainOwner(email, rows);
  if (verified) return verified;

  // R-822: no verified domain row → fall back to the existing OWNERS' verified
  // email domains (see `resolveOwnerDomainTenant` for the rules).
  return findTenantByOwnerDomain(admin, domain, email);
}

type Admin = ReturnType<typeof createAdminClient>;

/** `%` and `_` are LIKE wildcards; a domain never holds them legitimately, but escape anyway. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Owners whose own email is at `domain`, with their workspace and whether their
 * mailbox is confirmed. Best-effort: any failure is "no signal".
 */
async function findTenantByOwnerDomain(
  admin: Admin,
  domain: string,
  email: string | null | undefined,
): Promise<DomainMatch | null> {
  const { data: owners, error } = await admin
    .from("users")
    .select("id, tenant_id, email")
    .eq("role", "owner")
    .like("email", `%@${likeEscape(domain)}`)
    .limit(25);
  if (error) {
    console.error("[tenant-match] owner-domain lookup failed:", error.message);
    return null;
  }
  const list = (owners ?? []).filter((o) => o.tenant_id && emailDomain(o.email) === domain);
  if (list.length === 0) return null;

  const tenantIds = [...new Set(list.map((o) => o.tenant_id as string))];
  const { data: tenants } = await admin
    .from("tenants")
    .select("id, name, created_at")
    .in("id", tenantIds);
  const byId = new Map((tenants ?? []).map((t) => [t.id, t]));

  const records: OwnerDomainRecord[] = [];
  for (const o of list) {
    const t = byId.get(o.tenant_id as string);
    if (!t) continue; // workspace gone — nothing to join
    records.push({
      tenant_id:         t.id,
      tenant_name:       t.name ?? "your company's workspace",
      tenant_created_at: t.created_at ?? null,
      owner_email:       o.email ?? "",
      owner_verified:    await ownerEmailConfirmed(admin, o.id),
    });
  }
  return resolveOwnerDomainTenant(email, records);
}

/** Whether an owner's sign-in email is confirmed. Unknown counts as NO. */
async function ownerEmailConfirmed(admin: Admin, userId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user) return false;
    return Boolean(data.user.email_confirmed_at);
  } catch {
    return false;
  }
}

/**
 * R-822: the one step every "first time in, no workspace yet" path runs for a
 * person whose email is ALREADY verified (Google / Auth.js first login, the
 * confirmation link of a password signup, the /welcome "create workspace" button).
 *
 * If their company's domain already belongs to a workspace, park them in
 * `join_requests` for that owner and tell the owner — and return the workspace
 * name so the caller can say "Your company already uses ResellerOS — we've asked
 * the owner to add you." Returns null when nothing matched (or they already have a
 * workspace), and the caller carries on as before.
 *
 * Never call this for an UNVERIFIED address: a typed-in email proves nothing, and
 * routing it would let anyone ping a company's owner in someone else's name.
 */
export async function routeVerifiedSignupToCompany(input: {
  authUserId: string;
  email:      string;
  fullName?:  string | null;
  appUrl?:    string | null;
  note?:      string | null;
}): Promise<{ tenantName: string; alreadyPending: boolean } | null> {
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("users")
    .select("id")
    .eq("id", input.authUserId)
    .maybeSingle();
  if (member) return null;

  const match = await findVerifiedDomainTenant(input.email);
  if (!match) return null;

  const parked = await openJoinRequest({
    tenantId:   match.tenant_id,
    email:      input.email,
    fullName:   input.fullName ?? null,
    authUserId: input.authUserId,
    matchedBy:  "domain",
    note:       input.note ?? null,
  });
  if (!parked.ok) return null;

  if (!parked.alreadyPending) {
    await notifyOwnerOfJoinRequest({
      tenantId:   match.tenant_id,
      tenantName: match.tenant_name,
      email:      input.email,
      fullName:   input.fullName ?? null,
      appUrl:     input.appUrl ?? null,
    });
  }
  return { tenantName: match.tenant_name, alreadyPending: parked.alreadyPending };
}

export interface OpenJoinRequestInput {
  tenantId:   string;
  email:      string;
  fullName?:  string | null;
  authUserId?: string | null;
  matchedBy:  "domain" | "manual";
  role?:      TeamInviteRole;
  note?:      string | null;
}

/**
 * Park someone in `join_requests`. Grants nothing — that is the whole design.
 *
 * Re-asking is not an error: the partial unique index allows exactly one OPEN
 * request per person per tenant, so a duplicate is reported as `alreadyPending`
 * rather than failing the signup they are in the middle of.
 */
export async function openJoinRequest(
  input: OpenJoinRequestInput,
): Promise<{ ok: boolean; alreadyPending: boolean }> {
  const admin = createAdminClient();
  const { error } = await admin.from("join_requests").insert({
    tenant_id:      input.tenantId,
    auth_user_id:   input.authUserId ?? null,
    email:          input.email.trim().toLowerCase(),
    full_name:      input.fullName ?? null,
    requested_role: input.role ?? "support",
    matched_by:     input.matchedBy,
    note:           input.note ?? null,
  });

  if (error) {
    // 23505 = the partial unique index above. They already asked; nothing to do.
    if (error.code === "23505") return { ok: true, alreadyPending: true };
    console.error("[tenant-match] join request insert failed:", error.message);
    return { ok: false, alreadyPending: false };
  }
  return { ok: true, alreadyPending: false };
}

/**
 * Tell the workspace owner somebody is waiting.
 *
 * Two channels, both best-effort, and neither is the system of record — the
 * Dashboard card reads `join_requests` directly, so a request is never lost just
 * because a message failed to send. That ordering matters: notifications are how
 * an owner finds out FAST, not how they find out AT ALL.
 *
 * ⚠️ WhatsApp will no-op until credentials are set (Settings → Integrations →
 * WhatsApp Business). As of 14 Aug 2026 they are not set for any tenant here, so
 * `sendWhatsApp` throws immediately and the catch below records that.
 */
export async function notifyOwnerOfJoinRequest(input: {
  tenantId:    string;
  tenantName:  string;
  email:       string;
  fullName?:   string | null;
  appUrl?:     string | null;
}): Promise<{ whatsapp: "sent" | "skipped"; email: "sent" | "skipped" }> {
  const admin = createAdminClient();
  const who = input.fullName?.trim() || input.email;
  const link = `${(input.appUrl ?? "").replace(/\/+$/, "")}/team`;

  const { data: tenant } = await admin
    .from("tenants")
    .select("phone, email")
    .eq("id", input.tenantId)
    .maybeSingle();

  const body =
    `${who} (${input.email}) wants to join ${input.tenantName} on ResellerOS.\n\n` +
    `They have NO access yet — nothing happens until you approve it.\n\n` +
    `Approve or reject: ${link || "open Team in ResellerOS"}`;

  let whatsapp: "sent" | "skipped" = "skipped";
  if (tenant?.phone) {
    try {
      await sendWhatsApp({
        tenantId: input.tenantId,
        to:       tenant.phone,
        message:  { kind: "text", text: body },
      });
      whatsapp = "sent";
    } catch (e) {
      // Expected while WhatsApp is unconfigured. Never fails the signup.
      console.warn("[tenant-match] WhatsApp alert skipped:", (e as Error).message);
    }
  }

  let mail: "sent" | "skipped" = "skipped";
  const { data: owner } = await admin
    .from("users")
    .select("email")
    .eq("tenant_id", input.tenantId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();

  const to = owner?.email ?? tenant?.email ?? null;
  if (to) {
    try {
      const res = await sendEmail({
        to,
        subject: `${who} is waiting to join ${input.tenantName}`,
        text:    body,
        route:   { tenantId: input.tenantId },
        kind:    "join_request",
      });
      if (res.status === "sent") mail = "sent";
    } catch (e) {
      console.warn("[tenant-match] email alert skipped:", (e as Error).message);
    }
  }

  return { whatsapp, email: mail };
}
