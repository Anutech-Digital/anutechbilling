/**
 * Who the shop's own customer emails come from (Pawan, 5 Oct 2026).
 *
 * The Anutech storefront (the buy-page tenant, BUY_PAGE_TENANT_ID) is a company, not a person.
 * Its customer emails signed off as the tenant's contact person ("— Pardeep Sharma") and sent
 * replies to that person's own inbox, while DMS's hosting emails — the same customer, the same
 * order — signed "— Anutech Digital" and pointed at support. The customer now hears one voice:
 * every storefront email signs "— Anutech Digital" and a reply reaches support@anutech.in.
 *
 * Only the storefront. Every other tenant is a reseller selling under its own name, so its
 * emails keep its own sign-off and reply-to (lib/email/owner-alert.ts) — signing a reseller's
 * customer email as Anutech would hand that reseller's customer to us.
 *
 * And the owner's "payment received" alert can be switched off on a developer machine
 * (NO_OWNER_PAYMENT_ALERT_LOCAL=1): every local test payment was mailing the owner. The
 * switch is ignored on any deployed server, so live sales always reach the owner.
 */
import { COMPANY } from "@/site/lib/config";
import { buyPageTenantIdOrEmpty, isProductionDeployment } from "@/lib/checkout/live-guards";

type Env = Record<string, string | undefined>;

export interface StorefrontVoice {
  /** "— Anutech Digital" — the whole sign-off block. */
  signOff: string;
  /** Where a customer's reply goes. */
  replyTo: string;
}

/** The support desk a storefront customer's reply reaches. */
export function storefrontSupportEmail(env: Env = process.env): string {
  return env.SUPPORT_EMAIL?.trim() || COMPANY.supportEmail;
}

/** True only for the Anutech storefront's own tenant. */
export function isStorefrontTenant(tenantId: string | null | undefined, env: Env = process.env): boolean {
  const storefront = buyPageTenantIdOrEmpty(env);
  return !!tenantId && !!storefront && tenantId === storefront;
}

/** The storefront's sign-off and reply-to, or null for any other tenant (it keeps its own). */
export function storefrontVoice(tenantId: string | null | undefined, env: Env = process.env): StorefrontVoice | null {
  if (!isStorefrontTenant(tenantId, env)) return null;
  return { signOff: `— ${COMPANY.short}`, replyTo: storefrontSupportEmail(env) };
}

/** False only on a developer machine that switched the alert off; a deployed server always sends it. */
export function ownerPaymentAlertAllowed(env: Env = process.env): boolean {
  if (isProductionDeployment(env)) return true;
  return env.NO_OWNER_PAYMENT_ALERT_LOCAL?.trim() !== "1";
}
