/**
 * POST /api/dms/upgrade-request — a hosting plan upgrade asked for inside the DMS panel.
 *
 * Owner decision, 25 Sep 2026: DMS takes no payment for an upgrade. Its Upgrade button
 * sends the request here; this app records it as a lead and tells the owner, staff send a
 * quote, the customer pays that quote here, and staff change the plan in DMS.
 *
 * `estimateRupees` is DMS's prorated figure (ResellerOS's plan prices, incl. GST, for the
 * days left). It is written on the lead as an ESTIMATE to check, never used as a price:
 * the quote is the only price (AGENTS §2).
 *
 * Asking twice is safe: an open request for the same domain and target plan is returned
 * instead of a second lead.
 *
 * Auth: `Authorization: Bearer <DMS_PANEL_API_KEY>`, the same key as /api/dms/panel-order.
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { checkPanelKey } from "@/lib/dms-engine/panel-auth";
import { sendInternalEmail } from "@/lib/messaging";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";

export const dynamic = "force-dynamic";

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";
const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const SOURCE = "dms-upgrade-request";

const schema = z.object({
  dmsUserId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  email: z.string().email().max(200),
  fullName: z.string().min(1).max(120),
  phone: z.string().max(20).optional(),
  companyName: z.string().max(200).optional(),
  domain: z.string().min(3).max(253),
  currentPlan: z.string().min(1).max(40),
  targetPlan: z.string().min(1).max(40),
  estimateRupees: z.number().int().nonnegative().max(10_000_000).optional(),
  expiresAt: z.string().max(40).optional(),
});

export async function POST(request: NextRequest) {
  const auth = checkPanelKey(request.headers);
  if (!auth.ok) {
    if (auth.status === 503) console.warn("[dms/upgrade-request]", auth.error);
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid upgrade request: the request was not JSON. Nothing was recorded." }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid upgrade request: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") + ". Nothing was recorded." },
      { status: 400 },
    );
  }
  const r = parsed.data;
  const domain = r.domain.trim().toLowerCase();
  const plan = `hosting-upgrade-${r.targetPlan.trim().toLowerCase()}`;
  const admin = createAdminClient();

  // An open request for the same thing is the same request.
  const { data: existing, error: findErr } = await admin
    .from("leads")
    .select("id")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("source", SOURCE)
    .eq("domain", domain)
    .eq("plan", plan)
    .not("stage", "in", "(won,lost)")
    .limit(1)
    .maybeSingle();
  if (findErr) {
    console.error("[dms/upgrade-request] lookup failed:", findErr.message);
    return NextResponse.json({ error: "The upgrade request could not be recorded just now. Nothing was charged. Please try again in a few minutes." }, { status: 500 });
  }
  if (existing) return NextResponse.json({ success: true, leadId: existing.id, alreadyRequested: true });

  const leadId = "L-" + Date.now().toString(36).toUpperCase();
  const estimate = typeof r.estimateRupees === "number" ? `₹${r.estimateRupees.toLocaleString("en-IN")} incl. GST` : "not given";
  const notes = [
    `HOSTING UPGRADE REQUEST (from the DMS panel) · ${domain}`,
    `${r.currentPlan} → ${r.targetPlan}${r.expiresAt ? ` · current term ends ${r.expiresAt}` : ""}`,
    `DMS's prorated estimate: ${estimate}. This is an ESTIMATE to check, not a price. Send a quote for the upgrade; when it is paid, change the plan in DMS.`,
    `DMS account ${r.dmsUserId}`,
  ].join("\n");

  const { error: insErr } = await admin.from("leads").insert({
    id: leadId,
    tenant_id: BUY_PAGE_TENANT_ID,
    company: r.companyName?.trim() || r.fullName,
    contact_name: r.fullName,
    contact_email: r.email.trim().toLowerCase(),
    contact_phone: r.phone ?? null,
    plan,
    seats: 1,
    stage: "new",
    source: SOURCE,
    domain,
    notes,
  });
  if (insErr) {
    console.error("[dms/upgrade-request] lead insert failed:", insErr.message);
    return NextResponse.json({ error: "The upgrade request could not be recorded just now. Nothing was charged. Please try again in a few minutes." }, { status: 500 });
  }

  // The owner has to act on it, so tell them. A failed alert does not undo the request.
  try {
    const { alert } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
    if (alert.ok) {
      await sendInternalEmail({
        to: alert.to, from: FROM_EMAIL, kind: "dms_upgrade_request_owner", route: { tenantId: BUY_PAGE_TENANT_ID }, replyTo: r.email,
        subject: `Hosting upgrade requested — ${domain}: ${r.currentPlan} → ${r.targetPlan}`,
        text: `${notes}\n\nContact: ${r.fullName} <${r.email}>${r.phone ? ` · ${r.phone}` : ""}\nLead: ${`${trustedOrigin(request.headers)}/leads/${leadId}`}\n\n— ResellerOS`,
      });
    } else {
      console.warn(`[dms/upgrade-request] no owner to alert for lead ${leadId}: ${alert.reason}`);
    }
  } catch (err) {
    console.error("[dms/upgrade-request] owner alert failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ success: true, leadId, alreadyRequested: false });
}
