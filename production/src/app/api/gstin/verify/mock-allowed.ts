/**
 * R-1734: may /api/gstin/verify answer with the MOCK company when no GSTIN provider
 * (Sandbox.co.in key in tenant_secrets or SANDBOX_API_KEY/SECRET env) is configured?
 *
 * Only on a developer's laptop or in tests. On staging/live the mock's invented legal name and
 * address used to fill a real customer's form and could reach a GST invoice.
 *
 * "Deployed" is the app's one existing rule, `isProductionDeployment` (R-079): NODE_ENV=production
 * (every built image), NEXT_PUBLIC_APP_ENV=production|staging, or K_SERVICE (Cloud Run). Any one
 * is enough, so nothing new has to be set on a deployment. `npm run dev` / `dev:local` set none.
 */
import { isProductionDeployment } from "@/lib/checkout/live-guards";

type Env = Record<string, string | undefined>;

export function gstinMockAllowed(env: Env = process.env): boolean {
  return !isProductionDeployment(env);
}

/** Shown on the Verify button's card when no provider is configured on a deployed server. */
export const GSTIN_NOT_SET_UP_ERROR =
  "GSTN verification is not set up — enter the details from the GST certificate.";
export const GSTIN_NOT_SET_UP_CODE = "provider_not_configured";
