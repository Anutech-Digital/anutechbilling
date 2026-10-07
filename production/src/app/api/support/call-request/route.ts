/**
 * POST /api/support/call-request — a customer asking for a live 1-on-1 call.
 *
 * ─── THE ENTITLEMENT IS CHECKED HERE, NOT IN THE BUTTON ─────────────────────
 * A disabled button is a hint, not a rule. Standard includes two calls a month and
 * Free includes none, and that has to be decided somewhere a caller cannot skip —
 * which is why the table has no insert policy and this route is the only way in.
 *
 * ─── THE ALLOWANCE IS COUNTED FROM WHAT ACTUALLY HAPPENED ───────────────────
 * "Two a month" is the number of rows this customer already has in the current IST
 * month, not a counter someone has to remember to decrement. A counter drifts the
 * first time a request is deleted; a count cannot.
 *
 * ─── AND NOTHING HERE INVENTS A MEETING LINK ────────────────────────────────
 * A valid Google Meet room can only be created by Google, through the Calendar API
 * with a calendar-scoped OAuth token. A locally generated code produces a link that
 * looks right and is dead — everyone believes the call is booked until the moment it
 * fails, which is the moment of the call. So `meet_url` is left NULL and the reply
 * says a link is coming.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { localDateISO } from "@/lib/leads/outcomes";
import {
  supportTier, tierFromPlanName, liveCallAllowance, type SupportTierId,
} from "@/lib/support/tiers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  customer_id: z.string().uuid(),
  ticket_id:   z.string().optional().nullable(),
  note:        z.string().max(2000).optional().nullable(),
});

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const { data: me } = await supabase
    .from("users").select("tenant_id, email").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json({
      error: "Your account is not linked to a company yet.",
      nextStep: "Finish joining under Team settings, then try again.",
    }, { status: 403 });
  }

  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Which customer is this call for?" }, { status: 400 });
  }

  const admin = createAdminClientFor(user.id);

  /* The customer must be this tenant's. The admin client bypasses RLS, so the id
     alone would address anybody's customer. */
  const { data: customer } = await admin
    .from("customers").select("id, name, tenant_id")
    .eq("id", parsed.data.customer_id)
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();
  if (!customer) {
    return NextResponse.json({ error: "That customer is not on your account." }, { status: 404 });
  }

  // ── Which plan are they on ───────────────────────────────────────────────
  const { data: subs } = await admin
    .from("subscriptions")
    .select("plan")
    .eq("customer_id", customer.id)
    .eq("tenant_id", me.tenant_id)
    .eq("status", "active");

  /* Best tier they hold. A customer with two support subscriptions is entitled to
     the one they pay more for. */
  const RANK: Record<SupportTierId, number> = { enterprise: 3, standard: 2, free: 1 };
  const tierId = (subs ?? [])
    .map((s) => tierFromPlanName(s.plan))
    .reduce<SupportTierId>((best, t) => (RANK[t] > RANK[best] ? t : best), "free");
  const tier = supportTier(tierId);

  // ── How many have they had this month ────────────────────────────────────
  /* IST, because the allowance resets on the 1st of the month the customer lives in,
     not the 1st in UTC (CLAUDE.md §13). */
  const todayIST = localDateISO(new Date());
  const monthStartIST = `${todayIST.slice(0, 7)}-01`;
  const { count } = await admin
    .from("support_call_requests")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id)
    .neq("status", "cancelled")
    .gte("created_at", `${monthStartIST}T00:00:00+05:30`);

  const allowance = liveCallAllowance(tier, count ?? 0);
  if (!allowance.allowed) {
    return NextResponse.json({
      error: allowance.reason,
      nextStep: tierId === "free"
        ? "Upgrade to Standard for 2 live calls a month, or Enterprise for unlimited."
        : "Raise a ticket and we will answer within your plan's SLA, or upgrade to Enterprise for unlimited calls.",
      tier: tierId,
    }, { status: 409 });
  }

  const { data: created, error } = await admin
    .from("support_call_requests")
    .insert({
      tenant_id:   me.tenant_id,
      customer_id: customer.id,
      ticket_id:   parsed.data.ticket_id ?? null,
      tier:        tierId,
      requested_by_email: me.email ?? user.email ?? "unknown",
      note:        parsed.data.note ?? null,
      /* Left NULL deliberately — see the header. */
      meet_url:    null,
    })
    .select("id, tier, created_at")
    .single();

  if (error) {
    console.error("[support/call-request]", error.message);
    return NextResponse.json({ error: "Could not record the call request." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    id: created.id,
    tier: tierId,
    remaining: allowance.remaining,
    /* Said plainly rather than returning a link that would not work. */
    message: `Call requested on the ${tier.label} plan. An engineer will send the meeting link — it is not generated automatically yet.`,
  });
}
