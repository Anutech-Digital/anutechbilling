/**
 * POST /api/leads/start-trial
 *
 * Internal trial-start endpoint used when a customer phones in directly
 * and Pardeep needs to provision a 14-day trial without making them fill
 * the public /buy/workspace form. Mirrors /api/public/trial/workspace
 * but uses the logged-in user's tenant_id (multi-tenant-safe).
 *
 * Body: { fullName, companyName, email, phone, seats, domain, tierId?, message? }
 * Returns: { leadId, trialEnds, tasksCreated }
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { errorResponse, RouteError } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TRIAL_DAYS = 14;

const schema = z.object({
  fullName:    z.string().min(2).max(120),
  companyName: z.string().min(2).max(200),
  email:       z.string().email().max(200),
  phone:       z.string().min(7).max(20),
  seats:       z.coerce.number().int().min(1).max(300),
  domain:      z.string().min(3).max(120),
  tierId:      z.enum(["starter", "standard", "plus", "enterprise"]).default("standard"),
  message:     z.string().max(2000).optional(),
});

export async function POST(req: NextRequest) {
  // Authn — must be a logged-in reseller user
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: me, error: meErr } = await userClient
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (meErr || !me?.tenant_id) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body: " + parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }

  const { fullName, companyName, email, phone, seats, domain, tierId, message } = parsed.data;

  const cleanDomain = domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .trim();

  const admin = createAdminClientFor(authData.user.id);

  const leadId    = "L-" + Date.now().toString(36).toUpperCase();
  const planLabel = `google-workspace-${tierId}`;
  const tierName  =
    tierId === "starter"    ? "Business Starter"   :
    tierId === "standard"   ? "Business Standard"  :
    tierId === "plus"       ? "Business Plus"      :
                              "Enterprise";

  const trialStartedAt = new Date();
  const trialExpiresAt = new Date(trialStartedAt.getTime() + TRIAL_DAYS * 86400000);

  const notes = [
    `TRIAL REQUEST · ${TRIAL_DAYS}-day free trial (started via phone call)`,
    `Domain: ${cleanDomain}`,
    `Plan to trial: Google Workspace ${tierName}`,
    `Seats: ${seats}`,
    `Started by: ${authData.user.email}`,
    message ? `Notes: ${message}` : null,
    ``,
    `NEXT STEPS:`,
    `  1. Verify domain ownership via DNS TXT record`,
    `  2. Create trial Org in Google Reseller Console`,
    `  3. Provision ${seats} ${tierName} licenses (14-day expiry)`,
    `  4. Send admin credentials to ${email} + WhatsApp ${phone}`,
    `  5. Calendar reminders auto-set for Day 7 / 12 / 14`,
  ].filter(Boolean).join("\n");

  const { error: leadErr } = await admin.from("leads").insert({
    id:                leadId,
    tenant_id:         me.tenant_id,
    company:           companyName,
    contact_name:      fullName,
    contact_email:     email,
    contact_phone:     phone,
    plan:              planLabel,
    seats,
    value:             0,
    stage:             "trial",
    source:            "phone-call",
    domain:            cleanDomain,
    notes,
    trial_started_at:  trialStartedAt.toISOString(),
    trial_expires_at:  trialExpiresAt.toISOString(),
  });

  if (leadErr) {
    // Raw DB text client ko nahi (S21) — server log me [route] prefix ke saath.
    return errorResponse("[api/leads/start-trial]", "POST", new RouteError(500, "Trial shuru nahi hua — lead save nahi hui. Dobara try kariye.", leadErr.message));
  }

  // Auto-create follow-up tasks (Day 7 / 12 / 14)
  let tasksCreated = 0;
  try {
    const day7  = new Date(trialStartedAt.getTime() + 7  * 86400000);
    const day12 = new Date(trialStartedAt.getTime() + 12 * 86400000);
    const day14 = new Date(trialStartedAt.getTime() + 14 * 86400000);
    day7.setHours(10, 0, 0, 0);
    day12.setHours(10, 0, 0, 0);
    day14.setHours(10, 0, 0, 0);

    const { error: tErr } = await admin.from("tasks").insert([
      {
        tenant_id: me.tenant_id,
        title:     `Trial check-in: ${companyName} (${cleanDomain})`,
        notes:     `Day 7 of 14-day trial. Ask about adoption, onboarding blockers, any questions.`,
        kind:      "call",
        due_at:    day7.toISOString(),
        lead_id:   leadId,
      },
      {
        tenant_id: me.tenant_id,
        title:     `Conversion call: ${companyName} — trial ends in 2 days`,
        notes:     `Day 12 of 14-day trial. Discuss converting to paid. Quote ready to issue.`,
        kind:      "call",
        due_at:    day12.toISOString(),
        lead_id:   leadId,
      },
      {
        tenant_id: me.tenant_id,
        title:     `Trial expires TODAY: ${companyName}`,
        notes:     `14-day trial ends. Final outreach. Either convert to paid quote OR mark lead lost + suspend in Google CSP.`,
        kind:      "call",
        due_at:    day14.toISOString(),
        lead_id:   leadId,
      },
    ]);
    if (!tErr) tasksCreated = 3;
  } catch (e) {
    console.error("[start-trial] task creation failed (non-fatal):", e);
  }

  return NextResponse.json({
    leadId,
    trialEnds:     trialExpiresAt.toISOString(),
    tasksCreated,
    domain:        cleanDomain,
    seats,
    tier:          tierName,
  });
}
