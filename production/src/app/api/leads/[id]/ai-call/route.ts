/**
 * POST /api/leads/[id]/ai-call — a salesperson presses "AI call" on a lead (R-1437).
 *
 * The signed-in twin of /api/v1/telecalling/make-call (which is API-key only). Same dispatcher,
 * same guards — calling hours, 24-hour gap, attempt ceiling, our own number, closed lead — with
 * one difference: the person's press is the approval the `telecall.place` hold waits for
 * (`humanApproved`). The workspace kill switch still wins.
 *
 * Visibility is checked with the USER's client first, so a salesperson can only dial leads the
 * hierarchy rules let them see; the dispatcher then writes with the admin client as before.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { rateLimitShared, MAKE_CALL_PER_KEY } from "@/lib/security/rate-limit";
import { loadSalesCatalog } from "@/lib/ai/sales-agent.server";
import { dispatchTelecall } from "@/lib/ai/actions/telecall-dispatcher";
import { loadLeadSubject } from "@/lib/telecall/subject.server";
import { missingTelecallEnv, resolveTelecallProvider } from "@/lib/telecall/provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const { data: me } = await supabase
    .from("users").select("tenant_id, full_name").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json(
      { error: "Your account is not linked to a workspace yet — an owner can claim it on the Team page." },
      { status: 403 },
    );
  }

  /* Through the user's own client: RLS decides whether this person may see — and so call — it. */
  const { data: visible } = await supabase
    .from("leads").select("id").eq("id", leadId).eq("tenant_id", me.tenant_id).maybeSingle();
  if (!visible) {
    return NextResponse.json({ error: "That lead is not in your list any more — refresh the page." }, { status: 404 });
  }

  /* §24: not set up is a next step, not an error. */
  if (!resolveTelecallProvider()) {
    return NextResponse.json(
      {
        error: "AI calling is not set up yet.",
        /* Nothing chosen yet → name Bolna's settings, the vendor this button was built for. */
        detail: process.env.TELECALL_PROVIDER?.trim()
          ? `Ask the owner to add ${missingTelecallEnv().join(", ")} on the server.`
          : "Ask the owner to set TELECALL_PROVIDER=bolna and add BOLNA_API_KEY and BOLNA_AGENT_ID on the server (docs/telecall-bolna.md).",
      },
      { status: 409 },
    );
  }

  const rl = await rateLimitShared(`lead-ai-call:${user.id}`, MAKE_CALL_PER_KEY);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many AI calls from you in the last hour. Try again in ${rl.retryAfterSec} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const admin = createAdminClient();
  const subject = await loadLeadSubject(admin, me.tenant_id, leadId);
  if (!subject) {
    return NextResponse.json({ error: "That lead is not in your list any more — refresh the page." }, { status: 404 });
  }

  const [catalogue, tenant] = await Promise.all([
    loadSalesCatalog(admin, me.tenant_id),
    admin.from("tenants").select("name, phone").eq("id", me.tenant_id).maybeSingle(),
  ]);

  const sellerName = tenant.data?.name?.trim() || process.env.SELLER_LEGAL_NAME?.trim() || "our team";
  const ourNumbers = [tenant.data?.phone, process.env.RETELL_FROM_NUMBER, process.env.VAPI_FROM_NUMBER, process.env.BOLNA_FROM_NUMBER]
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0);

  const result = await dispatchTelecall({
    admin,
    tenantId: me.tenant_id,
    callType: "lead_qualification",
    leadId: subject.leadId,
    subscriptionId: null,
    rawPhone: subject.rawPhone,
    customerName: subject.customerName,
    currentPlan: subject.currentPlan,
    seats: subject.seats,
    renewalDate: null,
    pendingAmount: null,
    catalogue,
    sellerName,
    ourNumbers,
    doNotCall: false,
    subjectIsOpen: subject.isOpen,
    subjectClosedReason: subject.closedReason,
    now: new Date(),
    humanApproved: { userName: me.full_name?.trim() || "A team member" },
  });

  const status = result.outcome === "queued" ? 200 : result.outcome === "failed" ? 502 : 409;
  return NextResponse.json(
    { ok: result.outcome === "queued", outcome: result.outcome, detail: result.detail, call_log_id: result.callLogId },
    { status },
  );
}
