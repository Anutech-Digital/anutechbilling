/**
 * Renew-domains worker — turns a PAID domain renewal in the provisioning queue into a
 * real renewal, through the DMS engine's `domain.renew` command (25 Sep 2026: "Handle
 * the domain renewals too"). The twin of register-domains, for rows whose plan is
 * DOMAIN_RENEWAL_PLAN, which the payment webhook writes when a renewal quote of a
 * vendor-`domain` subscription is paid.
 *
 * ─── WHAT MUST BE TRUE BEFORE A LIVE COMMAND IS SENT ────────────────────────
 *   1. DOMAIN_RENEWAL_LIVE=1 on THIS server (the paying side's gate);
 *   2. the row was fully approved by decideProvisioning: a live, verified, full
 *      payment, and the `provisioning.activate` dial on auto — otherwise it carries a
 *      blocker and is never listed here;
 *   3. the tenant's kill switch is off (checked per row, fails closed);
 *   4. the domain's CURRENT expiry is known. It is read from DMS and sent as
 *      `expiryBefore`; the engine renews only if the registrar still agrees, so a
 *      renewal somebody already made is refused instead of bought twice (DMS L108).
 * The ENGINE then applies its own gate (ENGINE_DOMAIN_RENEW_LIVE=1) and its spend
 * limit, and holds anything outside it for a person.
 *
 * ─── L1: WHAT RETRIES IT, WHO IS TOLD, HOW A FAILURE IS NOTICED ─────────────
 *   Retries: the scheduler re-runs this; one commandId per row per IST day, so a
 *     re-run the same day is a free replay.
 *   Told: the tenant owner is emailed when a renewal needs reconciling or is refused.
 *     Holds are written to the row's note, which the /provisioning screen shows.
 *   Noticed later: every row stays `queued` with a note until activated or failed.
 *
 * Auth: Bearer(CRON_SECRET) only (R-1552, 18 Oct 2026 — the "or a signed-in owner" path let
 * any company's owner run this for EVERY company). Answer reported like every cron (R-1587).
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendInternalEmail } from "@/lib/messaging";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { loadAutonomyPolicy } from "@/lib/ai/autonomy.server";
import {
  listReadyDomainRenewals,
  markProvisioningActivated,
  markProvisioningFailed,
  noteProvisioning,
} from "@/lib/provisioning/provisioning.server";
import { commandsConfigured, sendEngineCommand } from "@/lib/dms-engine/commands";
import { getEngineServices } from "@/lib/dms-engine/client";
import { coverFromPaid } from "@/lib/provisioning/domain-registration";
import { domainRenewalEnabled, expiryEpochSeconds, renewalCommandId } from "@/lib/domains/renewal";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";
import { errorMessage } from "@/lib/ops/fetch-all";
import { cronAuthFailure } from "@/app/api/cron/_lib/cron-auth";
import { cronDbFailure } from "@/app/api/cron/_lib/db-failure";
import { engineAnswered, engineDown, newEngineHealth, provisioningResponse } from "@/app/api/cron/_lib/provisioning-report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("renew-domains", handle);
export async function GET(req: Request) { return gated(req); }
export async function POST(req: Request) { return gated(req); }

async function alertOwner(tenantId: string, subject: string, text: string) {
  const admin = createAdminClient();
  const { alert } = await loadOwnerAlert(admin, tenantId);
  if (!alert.ok) {
    console.error(`[renew-domains] no owner alert for tenant ${tenantId}: ${alert.reason} — ${subject}`);
    return;
  }
  // Internal, to the owner: deliberately NOT gated by the automation switch (L64).
  await sendInternalEmail({ to: alert.to, from: FROM_EMAIL, kind: "domain_renewal_owner", route: { tenantId }, subject, text }).catch((e) =>
    console.error("[renew-domains] owner alert failed:", e),
  );
}

async function handle(req: Request) {
  const denied = cronAuthFailure(req, process.env.CRON_SECRET);
  if (denied) return denied;

  if (!domainRenewalEnabled()) {
    return NextResponse.json({ ran: true, renewed: 0, note: "automatic domain renewal is switched off (DOMAIN_RENEWAL_LIVE is not 1)" });
  }
  if (!commandsConfigured()) {
    return NextResponse.json({ error: "DMS_ENGINE_URL / DMS_ENGINE_COMMAND_KEY are not set, so nothing can be renewed." }, { status: 503 });
  }

  let queue: Awaited<ReturnType<typeof listReadyDomainRenewals>>;
  try {
    queue = await listReadyDomainRenewals();
  } catch (e) {
    return cronDbFailure("renew-domains", e, `could not read the domain renewal queue: ${errorMessage(e)}`);
  }
  /* R-897: only the companies this pass may work on — and only they are counted (R-1552). */
  const rows = queue.filter((r) => cronTenantAllowed(r.tenant_id));
  const admin = createAdminClient();
  const summary = { considered: rows.length, renewed: 0, held: 0, reconciling: 0, refused: 0, skipped: 0 };
  const health = newEngineHealth();

  for (const row of rows) {
    const domain = (row.domain ?? "").trim().toLowerCase();

    const policy = await loadAutonomyPolicy(row.tenant_id);
    if (policy.killSwitch) {
      await noteProvisioning(row.id, "Waiting: automation is switched off for this workspace (Automation page). Nothing was renewed.");
      summary.skipped += 1;
      continue;
    }

    // Whose domain: the paid renewal quote's customer, whose DMS account holds it.
    const { data: quote } = await admin
      .from("quotes")
      .select("id, customer_id")
      .eq("id", row.quote_id)
      .eq("tenant_id", row.tenant_id) // service-role client: this IS the tenant boundary
      .maybeSingle();
    const customerId = (quote as { customer_id?: string | null } | null)?.customer_id ?? null;
    const { data: customer } = customerId
      ? await admin.from("customers").select("contact_email").eq("id", customerId).eq("tenant_id", row.tenant_id).maybeSingle()
      : { data: null };
    const email = (customer as { contact_email?: string | null } | null)?.contact_email?.trim() || "";
    if (!email) {
      await noteProvisioning(row.id, `Held: the customer on renewal quote ${row.quote_id} has no email, so their DMS account (which holds ${domain}) cannot be found. Renew it by hand.`);
      summary.held += 1;
      continue;
    }

    const services = await getEngineServices(email);
    if (!services.ok) {
      engineDown(health, `${domain}: could not read DMS services (${services.reason}${services.detail ? `: ${services.detail}` : ""})`);
      await noteProvisioning(row.id, `Waiting: could not read ${domain}'s current expiry from DMS (${services.reason}${services.detail ? `: ${services.detail}` : ""}). It will be tried again on the next run.`);
      summary.skipped += 1;
      continue;
    }
    const held = services.data.domains.find((d) => d.domainName.trim().toLowerCase() === domain);
    const expiryBefore = expiryEpochSeconds(held?.expiresAt);
    if (!held || expiryBefore === null) {
      await noteProvisioning(
        row.id,
        `Held: DMS has ${held ? "no expiry date" : "no record"} for ${domain} under ${email}, and the renewal is only sent against the expiry the registrar still has. Nothing was renewed; check the domain in DMS, then renew it by hand.`,
      );
      summary.held += 1;
      continue;
    }

    const outcome = await sendEngineCommand({
      commandId: renewalCommandId(row.id),
      command: "domain.renew",
      subject: domain,
      mode: "live",
      payload: {
        years: 1,
        expiryBefore,
        coverRupees: coverFromPaid(Number(row.amount_paid) || 0),
        paymentMode: "live",
        sourceRef: row.quote_id,
      },
    });

    if (outcome.kind === "unreachable") engineDown(health, `${domain}: could not reach the DMS engine (${outcome.reason})`);
    else engineAnswered(health);

    switch (outcome.kind) {
      case "done": {
        const ref = String(outcome.result.orderId ?? "renewed");
        await markProvisioningActivated(row.id, ref);
        summary.renewed += 1;
        break;
      }
      case "held":
      case "busy":
        await noteProvisioning(row.id, `Held: ${outcome.reason}`);
        summary.held += 1;
        break;
      case "gate_closed":
        await noteProvisioning(row.id, `Waiting: ${outcome.reason}`);
        return provisioningResponse("renew-domains", summary, health, { note: "the DMS engine's domain.renew gate is closed — stopped" });
      case "needs_reconciliation":
        health.errors.push(`${domain}: needs reconciling (${outcome.reason})`);
        if (await noteProvisioning(row.id, `RECONCILE: ${outcome.reason}`)) {
          await alertOwner(
            row.tenant_id,
            `⚠️ Domain renewal needs checking — ${domain}`,
            `The renewal of ${domain} (quote ${row.quote_id}) reached ResellerClub and no clear answer came back.\n\n${outcome.reason}\n\nIt has NOT been retried. Check ResellerClub: if the expiry moved a year, the renewal landed. Then settle the command in DMS (Admin → Engine commands). Do not renew it by hand until you have checked, or it may be renewed twice.\n\n— ResellerOS`,
          );
        }
        summary.reconciling += 1;
        break;
      case "refused":
        health.errors.push(`${domain}: refused (${outcome.reason})`);
        await markProvisioningFailed(row.id, `Not renewed: ${outcome.reason}`);
        await alertOwner(
          row.tenant_id,
          `❌ Domain renewal refused — ${domain}`,
          `The renewal of ${domain} (quote ${row.quote_id}) was refused:\n\n${outcome.reason}\n\nNothing was spent. The customer has paid, so either renew it by hand or refund them.\n\n— ResellerOS`,
        );
        summary.refused += 1;
        break;
      case "unreachable":
        await noteProvisioning(row.id, `Waiting: could not reach the DMS engine (${outcome.reason}). It will be tried again on the next run.`);
        summary.skipped += 1;
        break;
    }
  }

  return provisioningResponse("renew-domains", summary, health);
}
