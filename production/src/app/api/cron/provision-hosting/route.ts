/**
 * Provision-hosting worker — turns a PAID hosting order into a live account,
 * through the DMS engine's `hosting.provision` command.
 *
 * ─── CHANGED 24 Sep 2026: the account is created by DMS, not by this app ────
 * Owner decision: DMS is the only app that writes to DirectAdmin for a sale,
 * and the hosting lands in the customer's DMS panel. Until this date this
 * worker called DirectAdmin itself (daCreateAccount) and emailed the customer a
 * control-panel password — an account DMS never knew about, which the customer
 * could not see or manage in their panel, and a password sitting in an inbox.
 * Now DMS creates the account, the Hosting row and (if needed) the customer's
 * DMS account with a "set your password" email; the customer reaches cPanel
 * from the panel by SSO. See DMS lib/integrations/engine-handlers-provision.ts.
 *
 * (The hosting TRIAL confirm route still creates its account directly — a
 * second DirectAdmin writer that is recorded in Todos.md, not removed here.)
 *
 * ─── WHAT MUST BE TRUE BEFORE A LIVE COMMAND IS SENT ────────────────────────
 *   1. HOSTING_PROVISIONING_LIVE=1 on THIS server;
 *   2. the row was fully approved by decideProvisioning (live, verified, full
 *      payment; `provisioning.activate` dial on auto) — else it has a blocker;
 *   3. the workspace kill switch is off;
 *   4. the order names a domain and the buyer's email.
 * The engine then applies its own gate (ENGINE_HOSTING_PROVISION_LIVE=1).
 *
 * ─── L1 ───────────────────────────────────────────────────────────────────
 *   Retries: the scheduler re-runs this; one commandId per request per IST day,
 *     so a same-day re-run replays and the engine adopts an account an earlier
 *     attempt made instead of creating a second.
 *   Told: the owner is emailed on a lost response or a refusal.
 *   Noticed later: rows stay `queued` with a note until activated or failed.
 *
 * Auth: Bearer(CRON_SECRET) or a signed-in owner.
 */
import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { loadAutonomyPolicy } from "@/lib/ai/autonomy.server";
import {
  listReadyHostingRequests,
  markProvisioningActivated,
  markProvisioningFailed,
  noteProvisioning,
} from "@/lib/provisioning/provisioning.server";
import { commandsConfigured, sendEngineCommand } from "@/lib/dms-engine/commands";
import {
  hostingLineFor,
  hostingProvisioningEnabled,
  normalisePhone,
  provisionCommandId,
  splitName,
} from "@/lib/provisioning/domain-registration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (timingSafeEqualStr(m?.[1] ?? "", secret)) return true;
  }
  try {
    const supabase = createClient();
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) return false;
    const { data: me } = await supabase.from("users").select("role").eq("id", authData.user.id).single();
    return me?.role === "owner";
  } catch {
    return false;
  }
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function alertOwner(tenantId: string, subject: string, text: string) {
  const admin = createAdminClient();
  const { alert } = await loadOwnerAlert(admin, tenantId);
  if (!alert.ok) {
    console.error(`[provision-hosting] no owner alert for tenant ${tenantId}: ${alert.reason} — ${subject}`);
    return;
  }
  // Internal, to the owner: deliberately NOT gated by the automation switch (L64).
  await sendEmail({ to: alert.to, from: FROM_EMAIL, kind: "hosting_provisioning_owner", route: { tenantId }, subject, text }).catch((e) =>
    console.error("[provision-hosting] owner alert failed:", e),
  );
}

/**
 * R-036 (29 Sep 2026): the hosting line THIS request paid for. hostingLineFor returns the
 * order's FIRST hosting line, so on an order with Starter on a.in and Plus on b.in both
 * requests would have provisioned Starter. Each request carries its own plan
 * ("hosting-<tier>"), so the line with that tier is the one; with no match (an older
 * order, or a plan label written another way) it falls back to the old reading.
 * Two lines of the SAME tier for two domains still cannot be told apart from the line
 * alone — that needs R-032's per-request domain on the line.
 */
function lineForRequest(lineItems: unknown, requestPlan: string | null, requestDomain?: string | null) {
  /* R-032 (1 Oct 2026): each hosting line names its own domain, so the request's domain
     picks its line exactly — two lines of the same tier on two domains included. */
  const want = (requestDomain ?? "").trim().toLowerCase();
  if (want && Array.isArray(lineItems)) {
    const byDomain = lineItems.filter((l) => {
      const line = (l ?? {}) as { hostingPlan?: unknown; hostingDomain?: unknown; domain?: unknown };
      const d = typeof line.hostingDomain === "string" ? line.hostingDomain : typeof line.domain === "string" ? line.domain : "";
      return typeof line.hostingPlan === "string" && d.trim().toLowerCase() === want;
    });
    if (byDomain.length) return hostingLineFor(byDomain, requestPlan);
  }
  const tier = (requestPlan ?? "").replace(/^hosting-/, "").trim().toLowerCase();
  if (tier && Array.isArray(lineItems)) {
    const mine = lineItems.filter((l) => String((l as { hostingPlan?: unknown } | null)?.hostingPlan ?? "").toLowerCase() === tier);
    if (mine.length) return hostingLineFor(mine, requestPlan);
  }
  return hostingLineFor(lineItems, requestPlan);
}

async function handle(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!hostingProvisioningEnabled()) {
    return NextResponse.json({ ran: true, activated: 0, note: "automatic hosting provisioning is switched off (HOSTING_PROVISIONING_LIVE is not 1)" });
  }
  if (!commandsConfigured()) {
    return NextResponse.json({ error: "DMS_ENGINE_URL / DMS_ENGINE_COMMAND_KEY are not set, so nothing can be provisioned." }, { status: 503 });
  }

  const admin = createAdminClient();
  const rows = await listReadyHostingRequests();
  const summary = { considered: rows.length, activated: 0, held: 0, reconciling: 0, refused: 0, skipped: 0 };

  for (const row of rows) {
    const policy = await loadAutonomyPolicy(row.tenant_id);
    if (policy.killSwitch) {
      await noteProvisioning(row.id, "Waiting: automation is switched off for this workspace (Automation page). Nothing was created.");
      summary.skipped += 1;
      continue;
    }

    const { data: quote } = await admin
      .from("quotes")
      .select("id, lead_id, customer_name, domain, line_items")
      .eq("id", row.quote_id)
      .eq("tenant_id", row.tenant_id) // service-role client: this IS the tenant boundary
      .maybeSingle();
    if (!quote) {
      await noteProvisioning(row.id, `Waiting: the quote ${row.quote_id} could not be read, so nothing was created.`);
      summary.skipped += 1;
      continue;
    }

    let lead: { contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null; company?: string | null } | null = null;
    if (quote.lead_id) {
      const { data } = await admin
        .from("leads")
        .select("contact_name, contact_email, contact_phone, company")
        .eq("id", quote.lead_id)
        .eq("tenant_id", row.tenant_id)
        .maybeSingle();
      lead = data;
    }

    const domain = (row.domain || quote.domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();
    const email = (lead?.contact_email ?? "").trim().toLowerCase();
    const plan = lineForRequest(quote.line_items, row.plan, row.domain);
    const missing = [!domain && "a domain", !email && "the buyer's email", !plan && "a plan"].filter(Boolean);
    if (missing.length) {
      await noteProvisioning(row.id, `Held: the order has no ${missing.join(", ")}, so the account cannot be created automatically. Contact the customer and set it up by hand.`);
      summary.held += 1;
      continue;
    }

    const name = splitName(lead?.contact_name || quote.customer_name || email.split("@")[0]);
    const outcome = await sendEngineCommand({
      commandId: provisionCommandId(row.id),
      command: "hosting.provision",
      subject: domain,
      mode: "live",
      payload: {
        planId: plan!.planId,
        months: plan!.months,
        customer: { ...name, email, ...normalisePhone(lead?.contact_phone ?? ""), companyName: lead?.company || quote.customer_name || undefined },
        /* Said as it is: DMS refuses a TEST payment unless its own local-only switch is on. */
        paymentMode: row.payment_mode === "test" ? "test" : "live",
        sourceRef: row.quote_id,
      },
    });

    switch (outcome.kind) {
      case "done":
        await markProvisioningActivated(row.id, String(outcome.result.daUsername ?? "provisioned"));
        summary.activated += 1;
        break;
      case "held":
      case "busy":
        await noteProvisioning(row.id, `Held: ${outcome.reason}`);
        summary.held += 1;
        break;
      case "gate_closed":
        await noteProvisioning(row.id, `Waiting: ${outcome.reason}`);
        return NextResponse.json({ ...summary, note: "the DMS engine's hosting.provision gate is closed — stopped" });
      case "needs_reconciliation":
        if (await noteProvisioning(row.id, `RECONCILE: ${outcome.reason}`)) {
          await alertOwner(
            row.tenant_id,
            `⚠️ Hosting setup needs checking — ${domain}`,
            `Creating the hosting account for ${domain} (quote ${row.quote_id}) reached DirectAdmin and no clear answer came back.\n\n${outcome.reason}\n\nIt has NOT been retried. Check DirectAdmin, then settle the command in DMS (Admin → Engine commands). Do not create it by hand until you have checked.\n\n— ResellerOS`,
          );
        }
        summary.reconciling += 1;
        break;
      case "refused":
        await markProvisioningFailed(row.id, `DirectAdmin refused: ${outcome.reason}`);
        await alertOwner(
          row.tenant_id,
          `❌ Hosting setup failed — ${domain}`,
          `DirectAdmin refused to create the hosting account for ${domain} (quote ${row.quote_id}):\n\n${outcome.reason}\n\nNothing was created. The customer has paid, so set it up by hand or contact them.\n\n— ResellerOS`,
        );
        summary.refused += 1;
        break;
      case "unreachable":
        await noteProvisioning(row.id, `Waiting: could not reach the DMS engine (${outcome.reason}). It will be tried again on the next run.`);
        summary.skipped += 1;
        break;
    }
  }

  return NextResponse.json({ ran: true, ...summary });
}
