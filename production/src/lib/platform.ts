/**
 * Platform (super-admin) allowlist — the ResellerOS FOUNDER accounts that may
 * see cross-tenant signup data. This is the ONLY thing that grants god-mode;
 * a tenant can never flip a flag to get in. The real gate is the server API
 * (which re-checks the caller's authenticated email against this list before
 * touching the service-role client) — the client copy just toggles nav/UI.
 *
 * Override in prod with PLATFORM_ADMIN_EMAILS="a@x.com,b@y.com".
 */
const DEFAULT_PLATFORM_ADMINS = ["pardeep@anutech.in", "pardeep@exceltechnologies.in"];

export function platformAdminEmails(): string[] {
  const env = process.env.NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS || process.env.PLATFORM_ADMIN_EMAILS;
  const list = (env ? env.split(",") : DEFAULT_PLATFORM_ADMINS).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list;
}

export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return platformAdminEmails().includes(email.trim().toLowerCase());
}
