/**
 * Domain-based tenant matching — the pure half.
 *
 * ─── WHAT PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * `decideMembership()` answers one question — "is there an invite for this exact
 * address?" — and when the answer is no it says "new tenant". That is correct as
 * far as it goes, and it is why a colleague who signed in as
 * `ranjeetraj@exceltechnologies.in` (invited as `ranjeet@anutech.in`) was handed a
 * private company of his own, named after his real employer, which he then used
 * for two days.
 *
 * The email domain was sitting right there the whole time. This module reads it.
 *
 * ─── A DOMAIN MATCH IS EVIDENCE, NOT A KEY ───────────────────────────────────
 * `decideOnboarding` deliberately cannot return "join" on a domain match. The
 * strongest thing it will say is `request_approval`, which parks the person in
 * `join_requests` until a human lets them in. CLAUDE.md §4 says no invite → never
 * another tenant's data, and a domain is not an invite: anyone able to get an
 * address at a lookalike domain would otherwise walk straight in.
 *
 * ─── AND IT ONLY EVER SAYS "CHOOSE" OTHERWISE ────────────────────────────────
 * Note what is missing from the return type: there is no `new`. Creating a company
 * is now something a person does on purpose on the onboarding screen, not
 * something that happens to them because a string did not match.
 *
 * Pure and dependency-free so it can be tested without a database — the same
 * reason `membership.ts` is split this way.
 */
import { decideMembership, type InviteMatch, type MembershipDecision } from "./membership";
import type { InvitableRole } from "./roles";

/**
 * Consumer mailbox providers. A tenant that signed up from a gmail.com address
 * does not own gmail.com, and claiming it would funnel every future Gmail signup
 * on the platform into that one workspace — a tenant leak dressed up as a feature.
 *
 * This list is a safety floor, not a completeness claim: it exists so an obvious
 * mistake cannot happen. `tenant_domains.verified_at` is the real gate (0242).
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.in", "yahoo.co.in",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "rediffmail.com", "rediff.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "gmx.com", "mail.com", "yandex.com",
  "proton.me", "protonmail.com",
  "zoho.com", "zohomail.com",
]);

/**
 * The domain part of an email, lower-cased and trimmed. Returns "" for anything
 * that is not recognisably an address — callers treat "" as "no signal", which is
 * the safe reading.
 */
export function emailDomain(email: string | null | undefined): string {
  const at = (email ?? "").trim().toLowerCase();
  const i = at.lastIndexOf("@");
  if (i <= 0 || i === at.length - 1) return "";
  const domain = at.slice(i + 1);
  // A bare hostname with no dot is not a public domain; treat it as no signal.
  return domain.includes(".") ? domain : "";
}

/** True for consumer mailbox providers, which no tenant may claim. */
export function isPublicEmailDomain(domain: string | null | undefined): boolean {
  return PUBLIC_EMAIL_DOMAINS.has((domain ?? "").trim().toLowerCase());
}

/**
 * A verified `tenant_domains` row, resolved by the caller. `null` when the domain
 * is unknown, unverified, or belongs to a consumer provider — all three mean the
 * same thing here: no signal.
 */
export interface DomainMatch {
  tenant_id: string;
  tenant_name: string;
}

/** A `tenant_domains` row (0242), as the resolver needs to see it. */
export interface TenantDomainRecord {
  tenant_id:   string;
  tenant_name: string;
  domain:      string;
  /** null = claimed but unproven. Unproven routes nobody. */
  verified_at: string | null;
}

/**
 * Which tenant owns this address's domain — the whole rule, in one pure place.
 *
 * Extracted from the database query so the rule can be tested without a database.
 * The query narrows rows; THIS decides. Keeping the decision in SQL filters meant
 * "unverified routes nobody" was enforced by a `.not("verified_at", "is", null)`
 * that no test could see — one refactor away from silently becoming
 * "any claim routes anyone", which is a tenant leak.
 *
 * Returns null for every no-signal case, and they are deliberately
 * indistinguishable to the caller: unparseable address, consumer mailbox
 * provider, unknown domain, or a claim that was never verified.
 */
export function resolveDomainOwner(
  email: string | null | undefined,
  rows: readonly TenantDomainRecord[],
): DomainMatch | null {
  const domain = emailDomain(email);
  if (!domain || isPublicEmailDomain(domain)) return null;

  const hit = rows.find(
    (r) => r.domain.trim().toLowerCase() === domain && r.verified_at !== null,
  );
  if (!hit || !hit.tenant_id) return null;

  return { tenant_id: hit.tenant_id, tenant_name: hit.tenant_name };
}

/**
 * An existing workspace OWNER, as the fallback resolver needs to see them (R-822).
 * `owner_verified` = the owner's own sign-in email is confirmed (Google-verified or
 * the R-048 confirmation link was followed).
 */
export interface OwnerDomainRecord {
  tenant_id:         string;
  tenant_name:       string;
  /** ISO time the tenant was created — the oldest workspace wins a tie. */
  tenant_created_at: string | null;
  owner_email:       string;
  owner_verified:    boolean;
}

/**
 * R-822 (10 Oct 2026): which workspace owns this address's domain when no
 * `tenant_domains` row is verified for it — decided from the OWNERS' verified
 * email domains.
 *
 * Why this exists: Pawan signed up as pawan@anutech.in on staging and became the
 * owner of a blank second "Anutech" workspace, because the real Anutech's
 * `tenant_domains` claim was never verified, so `resolveDomainOwner` said "no
 * signal". An owner who has proved their own @anutech.in mailbox is the same
 * evidence a verified domain row is — and a match still only opens a join request
 * the owner must approve, so it never grants access by itself.
 *
 * Rules, all tested:
 *  - consumer mail providers (gmail.com …) never match;
 *  - an UNVERIFIED owner email never matches (anyone can type an address);
 *  - several workspaces whose owners share the domain → the OLDEST workspace wins
 *    (the same tie-break 0242 used: the real company predates the accidental copies).
 */
export function resolveOwnerDomainTenant(
  email: string | null | undefined,
  owners: readonly OwnerDomainRecord[],
): DomainMatch | null {
  const domain = emailDomain(email);
  if (!domain || isPublicEmailDomain(domain)) return null;

  const hits = owners.filter(
    (o) => o.owner_verified && !!o.tenant_id && emailDomain(o.owner_email) === domain,
  );
  if (hits.length === 0) return null;

  const time = (o: OwnerDomainRecord) => {
    const t = o.tenant_created_at ? Date.parse(o.tenant_created_at) : NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const oldest = [...hits].sort((a, b) => time(a) - time(b) || a.tenant_id.localeCompare(b.tenant_id))[0];
  return { tenant_id: oldest.tenant_id, tenant_name: oldest.tenant_name };
}

export type OnboardingDecision =
  /** An explicit invite. The only path that grants access without a human. */
  | { mode: "join"; tenantId: string; role: InvitableRole }
  /** Domain matched a verified tenant — park them, alert the owner, grant nothing. */
  | { mode: "request_approval"; tenantId: string; tenantName: string }
  /** Nothing recognised them. Ask, do not guess. */
  | { mode: "choose" };

/**
 * @param invite      invite row matched on the exact (lower-cased) email, or null
 * @param domainMatch verified domain owner for that email's domain, or null
 *
 * Order matters and is not arbitrary: an invite is a decision someone already
 * made, so it outranks an inference drawn from the address.
 */
export function decideOnboarding(input: {
  invite?: InviteMatch | null;
  domainMatch?: DomainMatch | null;
}): OnboardingDecision {
  const membership: MembershipDecision = decideMembership(input.invite ?? null);
  if (membership.mode === "join") {
    return { mode: "join", tenantId: membership.tenantId, role: membership.role };
  }

  const match = input.domainMatch;
  if (match && match.tenant_id) {
    return { mode: "request_approval", tenantId: match.tenant_id, tenantName: match.tenant_name };
  }

  return { mode: "choose" };
}
