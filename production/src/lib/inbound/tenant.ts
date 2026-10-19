/**
 * Which company forwarded mail (enquiries, support, purchase bills) belongs to — R-1555.
 *
 * Every inbound route used to say `INBOUND_EMAIL_TENANT_ID || BUY_PAGE_TENANT_ID || "fbb976f1-…"`.
 * On a deployment with neither env var set, mail went SILENTLY into Anutech's company — another
 * reseller's purchases / enquiries / support mail in Anutech's books, with no warning anywhere.
 * Now:
 *   - env set                      → that tenant;
 *   - deployed server, env missing → null, and the route answers 503 (like webhooks/meta);
 *   - laptop (`next dev`)          → the old dev tenant, so the local demo keeps working.
 * "Deployed" is the same test the website checkout uses (lib/checkout/live-guards, R-079).
 */
import { DEV_BUY_PAGE_TENANT_ID, isProductionDeployment } from "@/lib/checkout/live-guards";

type Env = Record<string, string | undefined>;

export function inboundTenantId(env: Env = process.env): string | null {
  const explicit = (env.INBOUND_EMAIL_TENANT_ID ?? "").trim() || (env.BUY_PAGE_TENANT_ID ?? "").trim();
  if (explicit) return explicit;
  if (isProductionDeployment(env)) return null;
  return DEV_BUY_PAGE_TENANT_ID;
}

/** Server-log line for the refusal. Names the env vars, nothing secret. */
export function inboundTenantMissingMessage(label: string): string {
  return `[${label}] refused: INBOUND_EMAIL_TENANT_ID / BUY_PAGE_TENANT_ID is not set — no company to file this mail under. Nothing was saved.`;
}
