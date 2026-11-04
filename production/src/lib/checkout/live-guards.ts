/**
 * R-079 (Pardeep, 1 Oct 2026) — two things a LIVE deployment must never do on its own.
 *
 * ─── 1. A SIMULATED PAYMENT ─────────────────────────────────────────────────
 * The cart, the Workspace buy page and the public quote page can "pay" without Razorpay:
 * they call `record_payment` directly, which converts the lead, creates the customer and
 * the subscription, and (since R-079) issues the GST tax invoice. That is a walkthrough
 * tool for a laptop. On a live site it is a free order with a statutory invoice attached.
 *
 * It used to be allowed whenever `ALLOW_SIMULATED_CHECKOUT=1` (or
 * `ALLOW_QUOTE_PAY_SIMULATION=1`) was set — including in production, where one stale env
 * var was all it took. Now a production deployment refuses it, whatever the flag says.
 *
 * "Production" is read from every signal the app already has, not one:
 *   - `NODE_ENV=production`   — the Dockerfile sets it on every deployed image;
 *   - `NEXT_PUBLIC_APP_ENV=production|staging` — the build arg the topbar badge reads;
 *   - `K_SERVICE`             — Cloud Run sets it on every revision it runs;
 *   - a LIVE Razorpay key (`rzp_live_…`) — the same test `razorpayMode` uses.
 * Any one is enough. `next dev` on a laptop sets none of them.
 *
 * ─── 2. A HARD-CODED TENANT ─────────────────────────────────────────────────
 * The website's orders are filed under `BUY_PAGE_TENANT_ID`, which fell back to a literal
 * UUID when the env var was missing. On a laptop that is a convenience; in production it
 * files real customers' orders and invoices under whichever tenant that literal names,
 * silently. Production now requires the env value and says so in words.
 */
import { isStagingEnv } from "@/lib/email/staging-allowlist";

/** The ANUTECH tenant the website sells under on a developer's machine. Never used in production. */
export const DEV_BUY_PAGE_TENANT_ID = "fbb976f1-9090-4f10-9726-0901bd144e42";

type Env = Record<string, string | undefined>;

/** True when this process is a deployed (live or staging) server, not a laptop. */
export function isProductionDeployment(env: Env = process.env): boolean {
  if (env.NODE_ENV === "production") return true;
  const appEnv = (env.NEXT_PUBLIC_APP_ENV ?? "").trim().toLowerCase();
  if (appEnv === "production" || appEnv === "staging") return true;
  if ((env.K_SERVICE ?? "").trim()) return true;
  return false;
}

/**
 * May this request settle a payment WITHOUT Razorpay?
 *
 * Never on a deployment, never with a live key in hand — the env flags cannot override
 * either. Outside production it stays allowed, as before, so the walkthrough still works.
 */
export function simulatedPaymentAllowed(opts: { env?: Env; razorpayKeyId?: string | null } = {}): boolean {
  const env = opts.env ?? process.env;
  if (isProductionDeployment(env)) return false;
  if ((opts.razorpayKeyId ?? "").startsWith("rzp_live_")) return false;
  return true;
}

export class BuyPageTenantMissingError extends Error {
  constructor() {
    super(
      "BUY_PAGE_TENANT_ID is not set. In production the website's orders must be filed under an " +
        "explicitly configured tenant — set BUY_PAGE_TENANT_ID on the deployment to the selling " +
        "tenant's id, then redeploy. Nothing was saved or charged.",
    );
    this.name = "BuyPageTenantMissingError";
  }
}

/**
 * The tenant the website sells under. Throws `BuyPageTenantMissingError` in production when
 * the env value is missing; outside production falls back to the dev tenant.
 */
export function buyPageTenantId(env: Env = process.env): string {
  const v = (env.BUY_PAGE_TENANT_ID ?? "").trim();
  if (v) return v;
  if (isProductionDeployment(env)) throw new BuyPageTenantMissingError();
  return DEV_BUY_PAGE_TENANT_ID;
}

/**
 * Non-throwing form for module-level constants: "" in production when unset, so a lookup
 * against it finds nothing (and fails closed) instead of reaching the hard-coded tenant.
 */
export function buyPageTenantIdOrEmpty(env: Env = process.env): string {
  try {
    return buyPageTenantId(env);
  } catch {
    return "";
  }
}

/**
 * R-2155 (30 Oct 2026) — staging never takes real money.
 *
 * Staging needs the company's LIVE Razorpay key for one thing: READING settlements and payments
 * (R-2099, lib/razorpay/settlement*.ts). The same key in tenant_secrets is also what every
 * checkout uses, so without this a staging quote-accept / buy link would open a real Razorpay
 * window and charge a real card.
 *
 * Every path that creates a Razorpay order or payment link, or settles a payment, asks this
 * first and refuses with the message when it answers. Read paths never ask it.
 * `live-key-staging-ratchet.test.ts` fails if a new money call site skips it.
 *
 * "Staging" = isStagingEnv (APP_ENV / NEXT_PUBLIC_APP_ENV = staging, or a staging host in
 * NEXT_PUBLIC_APP_URL) — the same signals the R-1403 mail guard uses. The live deployment sets
 * none of them, so live checkout is untouched; a test key on staging is untouched too.
 */
export const STAGING_LIVE_KEY_MESSAGE =
  "Staging cannot take real payments — use a Razorpay test key (rzp_test_…) for checkout here. Nothing was charged.";

/** The refusal to show, or null when this key may take a payment on this deployment. */
export function liveKeyCheckoutRefusal(keyId: string | null | undefined, env: Env = process.env): string | null {
  if (!(keyId ?? "").trim().startsWith("rzp_live_")) return null;
  return isStagingEnv(env) ? STAGING_LIVE_KEY_MESSAGE : null;
}
