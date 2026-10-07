/**
 * POST /api/v1/telecalling/make-call — ask the AI telecaller to ring somebody.
 *
 * Body: { "call_type": "lead_qualification", "lead_id": "L-0007" }
 *    or { "call_type": "renewal_reminder", "subscription_id": "<uuid>" }
 *
 * API-key authenticated and tenant-scoped, like the rest of /api/v1. THE TENANT COMES FROM
 * THE KEY, never from the body — a caller may name a lead, not a workspace. Without that rule
 * this endpoint would place calls, in another reseller's name, from their number, to their
 * customers.
 *
 * ─── THIS ENDPOINT DOES NOT DECIDE WHETHER TO DIAL ──────────────────────────
 * It resolves the subject, reads the catalogue, and hands both to `dispatchTelecall`, which
 * owns the autonomy dial, the calling-hours rule, the 24-hour gap and the attempt ceiling. A
 * second copy of any of those here is how one path ends up stricter than the other; the same
 * argument `quote-dispatcher.ts` makes about not creating quotes itself.
 *
 * So a 200 from this route does NOT mean a phone rang. It means the request was understood and
 * a decision was recorded — read `outcome`. Today the `telecall.place` dial defaults to `hold`,
 * so the honest answer for every well-formed request is `held`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/api-keys/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { unauthorized, badRequest, notFound, requireScope } from "@/lib/api/v1-response";
import { rateLimitShared, MAKE_CALL_PER_KEY } from "@/lib/security/rate-limit";
import { loadSalesCatalog } from "@/lib/ai/sales-agent.server";
import { dispatchTelecall } from "@/lib/ai/actions/telecall-dispatcher";
import type { TelecallType } from "@/lib/ai/telecall";
import { loadLeadSubject, loadSubscriptionSubject } from "@/lib/telecall/subject.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CALL_TYPES: ReadonlySet<string> = new Set<TelecallType>([
  "lead_qualification",
  "renewal_reminder",
]);

interface MakeCallBody {
  call_type?: unknown;
  lead_id?: unknown;
  subscription_id?: unknown;
}

/** Only a non-empty string is an id. `""` and `null` both mean "not supplied". */
function asId(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return unauthorized();
  const denied = requireScope(auth, "telecalling");
  if (denied) return denied;

  /* Per KEY, not only per IP (middleware already counts per IP): a leaked key used from many
     machines would otherwise get a fresh bucket on each one. dispatchTelecall still owns the
     per-person rules (24-hour gap, attempt ceiling); this only bounds how fast one key can ask. */
  const rl = await rateLimitShared(`v1-make-call:${auth.keyId}`, MAKE_CALL_PER_KEY);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many call requests for this API key. Try again in ${rl.retryAfterSec} seconds.`, code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: MakeCallBody;
  try {
    body = (await req.json()) as MakeCallBody;
  } catch {
    return badRequest("Body must be JSON.");
  }

  const callType = typeof body.call_type === "string" ? body.call_type.trim() : "";
  if (!CALL_TYPES.has(callType)) {
    return badRequest(
      `call_type must be one of: ${[...CALL_TYPES].join(", ")}. Received ${JSON.stringify(body.call_type ?? null)}.`,
    );
  }

  const leadId = asId(body.lead_id);
  const subscriptionId = asId(body.subscription_id);

  if (!leadId && !subscriptionId) {
    return badRequest("Supply lead_id or subscription_id — a call has to be about something.");
  }
  if (leadId && subscriptionId) {
    /* Refused rather than picking one. Both supplied means the caller believes something about
       this call that the app does not, and guessing would file the transcript against whichever
       of the two happened to be checked first. */
    return badRequest("Supply lead_id or subscription_id, not both — one call is about one thing.");
  }

  const admin = createAdminClient();

  const subject = leadId
    ? await loadLeadSubject(admin, auth.tenantId, leadId)
    : await loadSubscriptionSubject(admin, auth.tenantId, subscriptionId as string);

  if (!subject) {
    /* Not found and not-yours are the same response on purpose: both queries are already
       tenant-scoped, so a distinguishable 403 would confirm that an id exists in somebody
       else's workspace. */
    return notFound(leadId ? `No lead ${leadId} in this workspace.` : "No such subscription in this workspace.");
  }

  const [catalogue, tenant] = await Promise.all([
    loadSalesCatalog(admin, auth.tenantId),
    admin.from("tenants").select("name, phone").eq("id", auth.tenantId).maybeSingle(),
  ]);

  const sellerName =
    tenant.data?.name?.trim() || process.env.SELLER_LEGAL_NAME?.trim() || "our team";

  /* Our own numbers, so nothing dials back to us — the voice version of the self-email loop the
     sales pipeline already suppresses. The tenant's recorded phone plus whatever this
     deployment calls FROM: a call to our own outbound number connects two robots. */
  const ourNumbers = [tenant.data?.phone, process.env.RETELL_FROM_NUMBER, process.env.VAPI_FROM_NUMBER]
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0);

  const result = await dispatchTelecall({
    admin,
    tenantId: auth.tenantId,
    callType: callType as TelecallType,
    leadId: subject.leadId,
    subscriptionId: subject.subscriptionId,
    rawPhone: subject.rawPhone,
    customerName: subject.customerName,
    currentPlan: subject.currentPlan,
    seats: subject.seats,
    renewalDate: subject.renewalDate,
    pendingAmount: subject.pendingAmount,
    catalogue,
    sellerName,
    ourNumbers,
    /* Not yet a stored preference. Stated here rather than silently omitted: when a
       do-not-call flag exists on the customer record, it is read HERE and the guard in
       decideTelecall already refuses on it. Until then the operator is the flag. */
    doNotCall: false,
    subjectIsOpen: subject.isOpen,
    subjectClosedReason: subject.closedReason,
    now: new Date(),
  });

  return NextResponse.json({
    ok: result.outcome !== "failed",
    outcome: result.outcome,
    detail: result.detail,
    call_log_id: result.callLogId,
  });
}
