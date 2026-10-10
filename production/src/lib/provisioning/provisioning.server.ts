/**
 * Writing a provisioning request. One insert, and the reason it is not on the typed client.
 *
 * `provisioning_requests` is not in the generated `Database` type. Registering it is not a
 * two-line fix: measured 23 Aug 2026 on `document_series`, adding ONE table to the Tables map
 * took `npm run typecheck` from 4 errors to 2,722, because supabase-js resolves row types
 * through a conditional chain that tips over the instantiation limit at this schema size and
 * collapses every table to `never`. `ai_autonomy`, `ai_action_log`, `ai_telecall_logs` and
 * `quote_views` are unregistered for the same measured reason; this follows their pattern
 * rather than inventing a sixth.
 *
 * WITH NO GENERATED TYPES, NOTHING CHECKS THE TENANT FILTER — so the tenant id is a required
 * argument and is written on the row, and the caller passes the one it read off the quote it
 * verified, never one from a webhook body.
 */
import { createBareClient } from "@/lib/supabase/bare";
import { testPaymentProvisioningAllowed, type ProvisioningBlocker, type ProvisioningVendor } from "./provisioning";
import { DOMAIN_RENEWAL_PLAN } from "@/lib/domains/renewal";
import { HOSTING_RENEWAL_PLAN } from "@/lib/hosting/renewal";

function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

/** One hosting request ready to be turned into a real cPanel account. */
export interface ReadyHostingRequest {
  id: string;
  tenant_id: string;
  quote_id: string;
  domain: string | null;
  plan: string | null;
  /** "test" only on a local machine with test provisioning on; DMS is told which. */
  payment_mode?: string | null;
}

/**
 * Hosting requests that decideProvisioning fully approved (blocker IS NULL) on a
 * LIVE payment — the ones the worker may provision. A test-mode payment, an
 * engine-not-connected or dial-hold row carries a blocker and is left alone.
 */
export async function listReadyHostingRequests(limit = 50): Promise<ReadyHostingRequest[]> {
  return listReadyHostingRows("new", limit);
}

/**
 * Paid hosting RENEWALS approved the same way (25 Sep 2026). Separate, so the
 * provision-hosting worker never creates an account for somebody renewing one; the
 * renew-hosting worker takes only these.
 */
export async function listReadyHostingRenewals(limit = 50): Promise<ReadyHostingRequest[]> {
  return listReadyHostingRows("renewal", limit);
}

async function listReadyHostingRows(kind: "new" | "renewal", limit: number): Promise<ReadyHostingRequest[]> {
  const db = bare();
  if (!db) return [];
  let q = db
    .from("provisioning_requests")
    .select("id, tenant_id, quote_id, domain, plan, payment_mode")
    .eq("vendor", "hosting")
    .eq("status", "queued")
    /* A test-payment row reaches here only when it was approved under the local-only switch
       (provisioning.ts testPaymentProvisioningAllowed) — a production build never lets one in. */
    .in("payment_mode", testPaymentProvisioningAllowed() ? ["live", "test"] : ["live"])
    .is("blocker", null);
  // As for domains: `neq` alone would drop NULL-plan rows, so the null case is named.
  q = kind === "renewal" ? q.eq("plan", HOSTING_RENEWAL_PLAN) : q.or(`plan.is.null,plan.neq.${HOSTING_RENEWAL_PLAN}`);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(limit);
  if (error) {
    console.error(`[provisioning] list ready hosting ${kind === "new" ? "requests" : "renewals"} failed:`, error.message);
    return [];
  }
  return (data ?? []) as ReadyHostingRequest[];
}

/** One paid domain request the registration worker may send to the engine. */
export interface ReadyDomainRequest {
  id: string;
  tenant_id: string;
  quote_id: string;
  domain: string | null;
  amount_paid: number;
  note: string | null;
  /** Paid term (R-031); absent until migration 20261005090000 is applied — read as 1. */
  years?: number;
}

/**
 * Domain requests decideProvisioning fully approved (blocker IS NULL) on a LIVE
 * payment. A row queued while registration was switched off carries the
 * `engine_not_connected` blocker and is deliberately NOT picked up when it is
 * switched on — it was paid for under the old arrangement and a person clears it.
 */
export async function listReadyDomainRequests(limit = 20): Promise<ReadyDomainRequest[]> {
  return listReadyDomainRows("registration", limit);
}

/**
 * Paid domain RENEWALS approved the same way (25 Sep 2026). A separate list, because
 * registering a domain the customer already owns would be the wrong spend: the
 * register-domains worker never sees these rows, and renew-domains sees only them.
 */
export async function listReadyDomainRenewals(limit = 20): Promise<ReadyDomainRequest[]> {
  return listReadyDomainRows("renewal", limit);
}

async function listReadyDomainRows(kind: "registration" | "renewal", limit: number): Promise<ReadyDomainRequest[]> {
  const db = bare();
  if (!db) return [];
  let q = db
    .from("provisioning_requests")
    /* "*" rather than a list so `years` (R-031) is read when the column exists and the
       query still works before migration 20261005090000 lands — the register cron's
       yearsFor() treats an absent value as 1. */
    .select("*")
    .eq("vendor", "domain")
    .eq("status", "queued")
    .eq("payment_mode", "live")
    .is("blocker", null);
  // `neq` alone would also drop rows whose plan is NULL (a NULL is never "not equal"),
  // which is most registrations, so the null case is named.
  q = kind === "renewal" ? q.eq("plan", DOMAIN_RENEWAL_PLAN) : q.or(`plan.is.null,plan.neq.${DOMAIN_RENEWAL_PLAN}`);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(limit);
  if (error) {
    console.error(`[provisioning] list ready domain ${kind}s failed:`, error.message);
    return [];
  }
  return (data ?? []) as ReadyDomainRequest[];
}

/**
 * Record why a request is still waiting, without changing its status. Returns
 * whether a row was actually updated — an update matching nothing is a success
 * in supabase-js (AGENTS.md L84), so the count is read.
 */
export async function noteProvisioning(id: string, note: string): Promise<boolean> {
  const db = bare();
  if (!db) return false;
  const { data, error } = await db
    .from("provisioning_requests")
    .update({ note: note.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) {
    console.error("[provisioning] note failed:", error.message);
    return false;
  }
  return (data ?? []).length === 1;
}

export async function markProvisioningActivated(id: string, vendorRef: string): Promise<void> {
  const db = bare();
  if (!db) return;
  /* activated_at WITH the status. Until 29 Sep 2026 only status, vendor_ref and updated_at
     were written, so the first real engine activation (e2esife250) showed "activated" with
     no activation time; the column exists for exactly this, and the immutability trigger
     (20260921100000) lists it among the fields that may still change. */
  const now = new Date().toISOString();
  const { error } = await db
    .from("provisioning_requests")
    .update({ status: "activated", vendor_ref: vendorRef, activated_at: now, updated_at: now })
    .eq("id", id);
  if (error) console.error("[provisioning] mark activated failed:", error.message);
}

export async function markProvisioningFailed(id: string, note: string): Promise<void> {
  const db = bare();
  if (!db) return;
  const { error } = await db
    .from("provisioning_requests")
    .update({ status: "failed", note: note.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error("[provisioning] mark failed failed:", error.message);
}

export interface QueueProvisioningInput {
  tenantId: string;
  quoteId: string;
  vendor: ProvisioningVendor;
  seats: number;
  domain: string | null;
  plan: string | null;
  amountPaid: number;
  /** From the Razorpay KEY prefix — never a stored mode column. */
  paymentMode: "live" | "test";
  blocker: ProvisioningBlocker | null;
  note: string;
  /** Domains: the paid registration term, 1–10 (R-031). Omitted → the column's default, 1. */
  years?: number;
}

/**
 * Queue one activation. Idempotent by the unique index on (tenant_id, quote_id).
 *
 * Never throws: the caller is a payment webhook that has already committed the money via
 * `record_payment`, and a failed queue write must not turn a recorded payment into a 500 that
 * Razorpay then retries. Returns a word the caller can log.
 */
export async function queueProvisioning(
  input: QueueProvisioningInput,
): Promise<"queued" | "duplicate" | "failed"> {
  const db = bare();
  if (!db) {
    console.error("[provisioning] Supabase is not configured — activation not queued");
    return "failed";
  }

  try {
    const { error } = await db.from("provisioning_requests").insert({
      tenant_id:    input.tenantId,
      quote_id:     input.quoteId,
      vendor:       input.vendor,
      seats:        input.seats,
      domain:       input.domain,
      plan:         input.plan,
      amount_paid:  input.amountPaid,
      payment_mode: input.paymentMode,
      status:       "queued",
      blocker:      input.blocker,
      note:         input.note,
      /* Written only when it says something the default does not. Every sale today is one
         year (the cart refuses any other term), so a deploy that reaches this code before
         migration 20261005090000 adds the column keeps queuing — an insert naming a
         missing column would fail and leave a paid order queued for nobody. */
      ...(input.years && Number.isInteger(input.years) && input.years > 1 && input.years <= 10 ? { years: input.years } : {}),
    });

    if (!error) return "queued";

    /* 23505 is the unique index doing its job on a re-delivered Razorpay event — the same
       event arriving twice must not queue two activations, because seats given away twice are
       seats somebody has to take back from a customer who did nothing wrong. */
    if (error.code === "23505") return "duplicate";

    console.error("[provisioning] queue insert failed:", error.message);
    return "failed";
  } catch (err) {
    console.error("[provisioning] queue insert crashed:", err);
    return "failed";
  }
}

/** One row as the operator's queue shows it. */
export interface QueuedProvisioningRow {
  id: string;
  quote_id: string;
  vendor: string;
  seats: number;
  domain: string | null;
  plan: string | null;
  amount_paid: number;
  payment_mode: "live" | "test";
  status: string;
  blocker: string | null;
  note: string | null;
  vendor_ref: string | null;
  created_at: string;
}

/**
 * The queue for one tenant, for the operator's screen.
 *
 * Reads through the service-role client and filters by tenant_id EXPLICITLY.
 * `provisioning_requests` is not in the generated Database type (see this
 * file's header for the measured reason), so nothing checks that filter for
 * me — it is the entire tenant boundary, which is why the tenant id is a
 * required argument and comes from the caller's session, never a query param.
 *
 * Unlike `listReadyHostingRequests` this does NOT filter on payment_mode or
 * blocker. A screen that hid the blocked rows would hide exactly the ones
 * needing a human — the test-mode payments and the unconfigured vendors are
 * the queue's whole content today.
 */
export async function listProvisioningQueue(
  tenantId: string,
  limit = 100,
): Promise<QueuedProvisioningRow[]> {
  const db = bare();
  if (!db) return [];
  const { data, error } = await db
    .from("provisioning_requests")
    .select(
      "id, quote_id, vendor, seats, domain, plan, amount_paid, payment_mode, status, blocker, note, vendor_ref, created_at",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[provisioning] queue read failed:", error.message);
    return [];
  }
  return (data ?? []) as QueuedProvisioningRow[];
}
