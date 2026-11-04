/**
 * R-2017 (G-DPDP, 2 Nov 2026) — every file under src/app/api/public that holds the SERVICE ROLE.
 *
 * The service role bypasses RLS, and nobody is signed in on these routes — so the code IS the
 * tenant boundary. Each entry says, in one place, why the route needs the service role, what
 * lets the caller in (the credential), which tenant it is pinned to, and exactly which tables
 * it reads (with the columns and the filters) and writes.
 *
 * admin-client-allowlist.scan.test.ts (next to this folder) fails when:
 *   - a public file uses createAdminClient / createAdminClientFor / SUPABASE_SERVICE_ROLE_KEY,
 *     or imports a lib that does (SERVICE_ROLE_LIBS), without an entry here — or an entry is stale;
 *   - a file reads or writes a table / calls an RPC that its entry does not list;
 *   - a read of a personal-data table (PII_TABLES) selects `*`, selects a column not listed, or
 *     leaves out a listed filter (tenant / id / token);
 *   - the guard named in `mustContain` (token check, website tenant, Turnstile …) is gone.
 *
 * Adding an entry is a review decision, not a way to make the test pass: write what bounds the
 * route instead of a session. Route-level buckets (secret / user / public) stay in
 * src/app/api/admin-client-ratchet.test.ts (R-051); this file adds the data scope.
 */

/** Tables that hold personal data of customers, leads, employees or users (DPDP). */
export const PII_TABLES = [
  "leads", "lead_activities", "customers", "contacts", "employees", "users", "quotes",
  "quote_signatures", "subscriptions", "project_sales", "tenant_secrets", "consent_events",
  "assessment_attempts",
] as const;

export interface TableRead {
  /** Exact columns allowed in .select(...) — or the name of an exported column constant. "*" only for non-PII tables. */
  columns: string[] | "*";
  /** Filters every read chain of this table must carry, e.g. ["tenant_id"] → `.eq("tenant_id", …)`. */
  by: string[];
}

export interface PublicAdminEntry {
  /** Why the service role (one line). */
  reason: string;
  /** What lets an anonymous caller in, and which tenant it is pinned to. */
  scope: string;
  /** Words that must stay in the code (comments stripped) — the guard that bounds the route. */
  mustContain: string[];
  reads: Record<string, TableRead>;
  /** Tables written (insert/update/upsert/delete) and RPCs called. */
  writes: string[];
  /** Service role reached only through a lib (no direct client in the file). */
  via?: string;
}

const WEBSITE = "website tenant only (websiteTenantId / BUY_PAGE_TENANT_ID, never one the caller names)";
const QUOTE_LINK = "quote id + unguessable link token (quoteTokenMatches); wrong token = not found; the quote's own tenant";

export const PUBLIC_ADMIN_CLIENT: Record<string, PublicAdminEntry> = {
  "agent/chat/route.ts": {
    reason: "website sales chat: reads public prices + past lessons, checks whether the email is already a lead",
    scope: `${WEBSITE}; Turnstile + per-visitor limit; the lead check returns yes/no only`,
    mustContain: ["websiteTenantId", "siteVisitorLimit", "turnstileRefusalFor"],
    reads: {
      leads: { columns: ["id"], by: ["tenant_id", "contact_email"] },
      items: { columns: ["name", "msrp", "prices"], by: ["tenant_id"] },
      tenants: { columns: ["name", "phone"], by: ["id"] },
      ai_action_log: { columns: ["reason", "outcome", "entity", "facts"], by: ["tenant_id"] },
    },
    writes: [],
  },
  "assessment/[token]/route.ts": {
    reason: "employee test page: loads the test and the name picker without a login",
    scope: "unguessable assessment share token; the test's own tenant; answers stripped; employees id + name only",
    mustContain: ["public_token"],
    reads: {
      assessments: { columns: ["id", "tenant_id", "title", "topic", "questions", "status"], by: ["public_token"] },
      employees: { columns: ["id", "name"], by: ["tenant_id", "is_active"] },
    },
    writes: [],
  },
  "assessment/[token]/submit/route.ts": {
    reason: "employee test page: saves an attempt without a login",
    scope: "unguessable assessment share token; the test's own tenant",
    mustContain: ["public_token"],
    reads: { assessments: { columns: ["id", "tenant_id", "questions", "status"], by: ["public_token"] } },
    writes: ["assessment_attempts"],
  },
  "brand/route.ts": {
    reason: "R-2024 buy-page brand after a failed cold-start read",
    scope: `${WEBSITE}; BRAND_COLUMNS only; per-IP limit`,
    mustContain: ["readBuyBrand", "rateLimitShared"],
    reads: {},
    writes: [],
  },
  "callback/route.ts": {
    reason: "website call-back form: inserts a lead",
    scope: `${WEBSITE}; Turnstile + per-IP/per-number limits; insert only`,
    mustContain: ["websiteTenantId", "rateLimit", "turnstileRefusal"],
    reads: {},
    writes: ["leads"],
  },
  "catalog/buy-workspace/route.ts": {
    reason: "R-2027 buy-page prices after a failed cold-start read",
    scope: `${WEBSITE}; id/name/msrp only; per-IP limit`,
    mustContain: ["readBuyCatalog", "rateLimitShared"],
    reads: {},
    writes: [],
  },
  "catalog/workspace/route.ts": {
    reason: "public price catalogue (read-only)",
    scope: WEBSITE,
    mustContain: ["websiteTenantId"],
    reads: { items: { columns: ["name", "msrp", "prices", "vendor"], by: ["tenant_id"] } },
    writes: [],
  },
  "checkout/support/route.ts": {
    reason: "R-2083 support-plan buy flow: lead + draft quote, priced on the server",
    scope: `${WEBSITE}; Turnstile; an existing customer is attached only when id AND email match (attachableCustomer), never reported back`,
    mustContain: ["BUY_PAGE_TENANT_ID", "turnstileRefusalFor", "attachableCustomer"],
    reads: {
      items: { columns: ["id", "name", "sku"], by: ["tenant_id"] },
      subscriptions: { columns: ["id", "plan", "renewal_date"], by: ["tenant_id", "customer_id"] },
      quotes: { columns: ["public_token"], by: [] },
    },
    writes: ["leads", "quotes", "next_document_number", "record_payment"],
  },
  "checkout/workspace/domain-quote.server.ts": {
    reason: "R-1977 helper of the buy flow: inserts the domain draft quote",
    scope: `${WEBSITE} (tenant passed in by checkout/workspace); insert only`,
    mustContain: [],
    reads: { quotes: { columns: ["public_token"], by: [] } },
    writes: ["quotes", "next_document_number"],
  },
  "checkout/workspace/meta-purchase/route.ts": {
    reason: "R-1979 Meta purchase event for a paid buy-page quote",
    scope: `${WEBSITE} + quote id + link token (quoteTokenMatches)`,
    mustContain: ["websiteTenantId", "quoteTokenMatches"],
    reads: { quotes: { columns: ["id", "public_token", "payment_status"], by: ["id", "tenant_id"] } },
    writes: [],
  },
  "checkout/workspace/route.ts": {
    reason: "public Workspace buy flow: lead + draft quote + Razorpay order for the buy-page tenant",
    scope: `${WEBSITE}; Turnstile; Razorpay keys read sealed and never returned`,
    mustContain: ["BUY_PAGE_TENANT_ID", "turnstileRefusalFor"],
    reads: {
      items: { columns: ["id", "name", "msrp", "wholesale", "prices"], by: ["tenant_id"] },
      tenant_secrets: { columns: ["razorpay_key_id", "razorpay_key_secret", "razorpay_mode"], by: ["tenant_id"] },
      site_promos: { columns: "*", by: ["tenant_id"] },
      quotes: { columns: ["public_token"], by: [] },
    },
    writes: ["leads", "quotes", "next_document_number", "redeem_coupon", "record_payment"],
  },
  "consent/record.server.ts": {
    reason: "R-2010 helper: inserts one cookie-consent row",
    scope: `${WEBSITE}; insert only; IP kept only as an HMAC`,
    mustContain: ["createHmac"],
    reads: {},
    writes: ["consent_events"],
  },
  "consent/route.ts": {
    reason: "R-2010 cookie-consent record",
    scope: `${WEBSITE}; insert only; per-IP limit`,
    mustContain: ["websiteTenantId", "rateLimit"],
    reads: {},
    writes: ["consent_events"],
  },
  "coupons/validate/route.ts": {
    reason: "dry-run coupon check; records nothing",
    scope: WEBSITE,
    mustContain: ["BUY_PAGE_TENANT_ID"],
    reads: { coupons: { columns: "*", by: ["code", "tenant_id"] } },
    writes: [],
  },
  "demo-session/route.ts": {
    reason: "R-524 Try the demo: mints a one-time login for the fixed read-only demo visitor",
    scope: "demo tenant only; DEMO_ENABLED + per-IP limit; refused unless the DB confirms read-only",
    mustContain: ["demoEnabled", "readOnlyWallUp", "rateLimitShared"],
    reads: {},
    writes: [],
  },
  "enquiry/general/route.ts": {
    reason: "website enquiry form: inserts a lead, emails the owner",
    scope: `${WEBSITE}; Turnstile; tenant email read only to notify the owner`,
    mustContain: ["websiteTenantId", "turnstileRefusalFor"],
    reads: { tenants: { columns: ["email", "name"], by: ["id"] } },
    writes: ["leads"],
  },
  "enquiry/workspace/route.ts": {
    reason: "website Workspace enquiry: lead + draft quote + activity",
    scope: `${WEBSITE}; Turnstile; insert + update of the lead it just made`,
    mustContain: ["websiteTenantId", "turnstileRefusalFor"],
    reads: {},
    writes: ["leads", "quotes", "lead_activities", "next_document_number"],
  },
  "expense-claim/manage/route.ts": {
    reason: "public expense-claim link: edit / delete a claim",
    scope: "signed claim token (verifyClaimToken) + verify_claim_access RPC; the claim's own tenant",
    mustContain: ["verifyClaimToken"],
    reads: {},
    writes: ["delete_claim_public", "edit_claim_public", "verify_claim_access"],
  },
  "expense-claim/route.ts": {
    reason: "public expense-claim link: submit a claim + receipt upload (storage as service role)",
    scope: "signed claim token (verifyClaimToken) + verify_claim_access RPC; the claim's own tenant folder",
    mustContain: ["verifyClaimToken"],
    reads: {},
    writes: ["submit_expense_claim", "verify_claim_access"],
  },
  "expense-claim/verify/route.ts": {
    reason: "public expense-claim link: checks the link",
    scope: "signed claim token (verifyClaimToken) + verify_claim_access RPC",
    mustContain: ["verifyClaimToken"],
    reads: {},
    writes: ["verify_claim_access"],
  },
  "health/live/route.ts": {
    reason: "uptime probe",
    scope: "head count on tenants; returns no rows",
    mustContain: [],
    reads: { tenants: { columns: ["id"], by: [] } },
    writes: [],
  },
  "project-quote/[id]/accept/route.ts": {
    reason: "customer accepts a project quote from the emailed link",
    scope: "project id + link token (quoteTokenMatches); the project's own tenant",
    mustContain: ["quoteTokenMatches"],
    reads: { project_sales: { columns: ["id", "public_token"], by: ["id"] } },
    writes: ["accept_project_quote"],
  },
  "quote/[id]/accept/route.ts": {
    reason: "customer accepts a quote from the emailed link",
    scope: `${QUOTE_LINK}; tenant email read only to notify the owner`,
    mustContain: ["quoteTokenMatches"],
    reads: {
      quotes: { columns: ["id", "status", "payment_status", "expires_date", "customer_name", "tenant_id", "public_token", "amount", "line_items", "tax_rate", "subtotal"], by: ["id"] },
      items: { columns: "*", by: ["tenant_id"] },
      tenants: { columns: ["name", "email"], by: ["id"] },
    },
    writes: ["quotes", "quote_signatures", "accept_quote"],
  },
  "quote/[id]/configure/route.ts": {
    reason: "customer picks options on the quote link; returns the re-priced lines only",
    scope: QUOTE_LINK,
    mustContain: ["quoteTokenMatches"],
    reads: {
      quotes: { columns: ["id", "status", "tenant_id", "public_token", "line_items", "tax_rate"], by: ["id"] },
      items: { columns: "*", by: ["tenant_id"] },
    },
    writes: [],
  },
  "quote/[id]/pay/route.ts": {
    reason: "customer pays a quote from the emailed link (Razorpay order)",
    scope: QUOTE_LINK,
    mustContain: ["quoteTokenMatches"],
    reads: { quotes: { columns: ["QUOTE_ORDER_COLUMNS"], by: ["id"] } },
    writes: [],
  },
  "quote/[id]/request-fresh/route.ts": {
    reason: "customer asks for a fresh quote from an expired link",
    scope: QUOTE_LINK,
    mustContain: ["quoteTokenMatches"],
    reads: {
      quotes: { columns: ["id", "status", "tenant_id", "public_token", "customer_name", "expires_date", "payment_status", "invoice_id", "superseded_by"], by: ["id"] },
      tenants: { columns: ["name"], by: ["id"] },
    },
    writes: [],
  },
  "quote/[id]/upi-notify/route.ts": {
    reason: "customer says they paid by UPI; emails the owner",
    scope: `${QUOTE_LINK}; tenant email read only to notify the owner`,
    mustContain: ["quoteTokenMatches"],
    reads: {
      quotes: { columns: ["id", "status", "tenant_id", "public_token", "customer_name", "amount", "payment_status"], by: ["id"] },
      tenants: { columns: ["name", "email"], by: ["id"] },
    },
    writes: [],
  },
  "site-promo/current/route.ts": {
    reason: "the website's current promo banner (read-only)",
    scope: WEBSITE,
    mustContain: ["websiteTenantId"],
    reads: { site_promos: { columns: "*", by: ["tenant_id"] } },
    writes: [],
  },
  "trial/hosting/confirm/route.ts": {
    reason: "hosting trial email-confirm link: starts the trial on the lead",
    scope: `signed trial token (verifyTrialToken) naming the lead; ${WEBSITE}; redirects, never returns lead data`,
    mustContain: ["verifyTrialToken", "BUY_PAGE_TENANT_ID"],
    reads: {
      leads: { columns: ["id", "company", "contact_name", "contact_email", "contact_phone", "plan", "domain", "source", "notes", "trial_converted_at"], by: ["id", "tenant_id"] },
    },
    writes: ["leads", "tasks"],
  },
  "trial/workspace/route.ts": {
    reason: "website trial request: inserts a lead + task",
    scope: `${WEBSITE}; Turnstile; insert only`,
    mustContain: ["websiteTenantId", "turnstileRefusalFor"],
    reads: {},
    writes: ["leads", "tasks"],
  },
  "privacy-request/route.ts": {
    reason: "R-2013 data-rights form: saves the unconfirmed request + the code's hash, reads the company name for the code email",
    scope: `${WEBSITE}; Turnstile + per-IP/per-email limits; insert only, never says whether the person is known`,
    mustContain: ["websiteTenantId", "rateLimit", "turnstileRefusal"],
    reads: { tenants: { columns: ["name"], by: ["id"] } },
    writes: ["privacy_requests"],
  },
  "privacy-request/verify/route.ts": {
    reason: "R-2013 code check: one RPC confirms the request (and records a consent withdrawal)",
    scope: `${WEBSITE}; request id + hashed 6-digit code, 5 tries + expiry in the RPC; per-IP limit`,
    mustContain: ["websiteTenantId", "rateLimit", "privacyCodeHash"],
    reads: {},
    writes: ["privacy_request_verify"],
  },
  "unsubscribe/route.ts": {
    reason: "email unsubscribe link: records the suppression",
    scope: "signed unsubscribe token (verifyUnsubscribe); upsert of that one address",
    mustContain: ["verifyUnsubscribe"],
    reads: {},
    writes: ["email_suppressions"],
  },
  "ux/events/route.ts": {
    reason: "UX friction events (R-2170): insert-only; tenant from the session when there is one",
    scope: "tenant read from the signed-in user's own users row (user client), else null; insert only",
    mustContain: ["getUser"],
    reads: { users: { columns: ["tenant_id"], by: ["id"] } }, // with the USER client, own row only

    writes: ["ux_events"],
  },
  // ── service role only through a lib ───────────────────────────────────────
  "catalog/route.ts": {
    reason: "public price book (getPriceBook reads it with the service role)",
    scope: WEBSITE,
    mustContain: ["websiteTenantId"],
    reads: {},
    writes: [],
    via: "catalog/catalog-prices.server",
  },
  "hosting-prices/route.ts": {
    reason: "public hosting prices (getPriceBook)",
    scope: WEBSITE,
    mustContain: ["websiteTenantId"],
    reads: {},
    writes: [],
    via: "catalog/catalog-prices.server",
  },
  "checkout/cart/route.ts": {
    reason: "public cart checkout (runCartCheckout: lead + quote + order for the buy-page tenant)",
    scope: `${WEBSITE} — enforced inside lib/checkout/cart-checkout.ts`,
    mustContain: ["runCartCheckout"],
    reads: {},
    writes: [],
    via: "checkout/cart-checkout",
  },
  "checkout/verify/route.ts": {
    reason: "Razorpay payment verification for a buy-page order",
    scope: "Razorpay signature checked inside lib/checkout/verify-payment.server.ts; the order's own quote",
    mustContain: ["verifyCheckoutPayment"],
    reads: {},
    writes: [],
    via: "checkout/verify-payment.server",
  },
};

/**
 * Libs that use the service role for INFRASTRUCTURE only (rate-limit counters, outbound
 * notification/email logs, unsubscribe-token keys, the AI action log, the supabase client
 * factory itself) — importing them does not by itself make a public file need an entry.
 * A public file that imports any OTHER service-role lib must have an entry with `via`.
 */
export const INFRA_SERVICE_ROLE_LIBS: Record<string, string> = {
  "supabase/server": "the client factory; direct use is caught by the createAdminClient scan",
  "security/rate-limit": "rate-limit counters only",
  "notifications/notify.server": "in-app notification rows for the tenant's own staff",
  "email/send": "outbound email log",
  "marketing/unsubscribe-token": "token signing key lookup",
  "ai/autonomy.server": "AI action log for the website tenant",
};
