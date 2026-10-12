/**
 * Who gets the "money landed / lead landed / trial ended" alert for a tenant.
 *
 * ─── THE BUG THIS REPLACES ──────────────────────────────────────────────────
 * Five server routes carried this, module-level:
 *
 *     const PARDEEP_EMAIL = "owner@client-a.example.test";
 *
 * and used it as the `to:` of the owner alert — in four of them unconditionally,
 * ignoring the tenant entirely. `api/webhooks/razorpay/route.ts` had already been
 * fixed to resolve the tenant's own address and its header says why:
 *
 *   "in a multi-tenant product every tenant's payment alert, carrying their
 *    customer's name, email and amount, was mailed to one fixed address. The
 *    owner of the tenant that made the sale never got it, and someone else did."
 *
 * The other four were missed. `api/cron/trial-expiry/route.ts` is the clearest:
 * it SELECTS `tenant_id` for every expired trial, never filters or reads it, and
 * mails all of them — company, contact name, contact email, phone, domain — to
 * that one address.
 *
 * ─── WHY THIS IS NOT A "STALE BRAND" FIX ────────────────────────────────────
 * The tempting fix is to ban `example.test`, since CLAUDE.md §1 records
 * that brand as historical. That would be wrong twice over. Tenant
 * `<client-tenant-id>` genuinely has `pardeep@example.test`
 * as its recorded contact, so banning the domain would block that tenant's own
 * mail — its address is the operator's data, not this module's business. And a
 * ban list dated to one brand goes stale the moment somebody hardcodes
 * `pardeep@anutech.in` instead, which is the identical bug wearing a fresher
 * domain.
 *
 * The defect is the HARDCODED LITERAL, not the domain in it. So there is no
 * default here and no constant to fall back to: the address comes from the
 * tenant row or it does not come at all.
 *
 * ─── AND A MISSING ADDRESS IS REPORTED, NEVER SUBSTITUTED ───────────────────
 * Same posture as `lib/invoices/supplier-identity.ts`: an unknown identity is
 * reported, never guessed. A tenant with no email on file produces a named
 * reason the caller must log — not a send to somebody else's inbox, which is how
 * this bug stayed invisible (the alert always "worked", it just arrived at the
 * wrong desk). Callers must treat `ok: false` as loud: the underlying event is
 * already recorded in the database, so losing a NOTIFICATION while saying so is
 * strictly better than delivering a tenant's customer data to a third party.
 */

/** The columns this needs from `tenants`. A partial select is fine. */
export interface TenantContact {
  name?:         string | null;
  email?:        string | null;
  contact_name?: string | null;
}

export type OwnerAlertResult =
  | { ok: true;  to: string; ownerName: string }
  /** `reason` is written for a server log: it names the tenant and the fix. */
  | { ok: false; reason: string };

/**
 * Deliberately loose. This is not an address validator — Postgres holds whatever
 * the operator typed and the mail provider is the real judge. It exists to catch
 * the two shapes that are certainly not deliverable and would otherwise be
 * handed to the transport: an empty cell, and a stray word with no `@`.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve the owner-alert recipient for one tenant.
 *
 * @param tenant  the tenant row, or null when the lookup found nothing
 * @param tenantId  used only to make the failure reason searchable
 */
export function resolveOwnerAlert(
  tenant: TenantContact | null | undefined,
  tenantId: string,
): OwnerAlertResult {
  if (!tenant) {
    return {
      ok: false,
      reason: `tenant ${tenantId} not found — cannot address the owner alert. The event itself is recorded; only the notification is lost.`,
    };
  }

  const email = tenant.email?.trim() ?? "";
  if (!email) {
    return {
      ok: false,
      reason: `tenant ${tenantId} has no email on file — owner alert not sent. Set it in Settings → Business profile.`,
    };
  }
  if (!LOOKS_LIKE_EMAIL.test(email)) {
    return {
      ok: false,
      reason: `tenant ${tenantId} has an unusable email (${email}) — owner alert not sent. Fix it in Settings → Business profile.`,
    };
  }

  /* Contact person first, company second. The alert reads as a message to a
     person, and a company name in the greeting slot is the tell that nobody set
     one up. Never a placeholder like "Employee" or "your reseller" — L4: a
     display placeholder that reaches a rule matches everybody. */
  const ownerName =
    tenant.contact_name?.trim() || tenant.name?.trim() || "";

  return { ok: true, to: email, ownerName };
}
