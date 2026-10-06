/**
 * Renew-hosting worker — tells DMS a hosting renewal was paid, so DMS extends the account
 * instead of suspending it at its old expiry (owner, 25 Sep 2026: "Fix those too").
 * Sends the DMS engine's `hosting.renew` for rows the payment webhook queued with
 * plan = HOSTING_RENEWAL_PLAN. See lib/hosting/renewal.ts.
 *
 * ─── WHAT MUST BE TRUE BEFORE A LIVE COMMAND IS SENT ────────────────────────
 *   1. HOSTING_RENEWAL_LIVE=1 on THIS server;
 *   2. the row was fully approved by decideProvisioning (live, verified, full payment;
 *      `provisioning.activate` on auto) — otherwise it carries a blocker;
 *   3. the tenant's kill switch is off;
 *   4. the renewal's length is known from the quote's lines (1 or 12 months), never
 *      guessed; and the account's CURRENT expiry is read from DMS and sent as
 *      `expiryBefore`, so a second send cannot extend it twice.
 * DMS applies its own gate (ENGINE_HOSTING_RENEW_LIVE=1).
 *
 * ─── L1 ──────────────────────────────────────────────────────────────────────
 *   Retries: the scheduler re-runs this; one commandId per row per IST day.
 *   Told: the owner is emailed when a renewal needs reconciling or is refused.
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
  listReadyHostingRenewals,
  markProvisioningActivated,
  markProvisioningFailed,
  noteProvisioning,
} from "@/lib/provisioning/provisioning.server";
import { commandsConfigured, sendEngineCommand } from "@/lib/dms-engine/commands";
import { getEngineServices } from "@/lib/dms-engine/client";
import { expiryEpochSeconds } from "@/lib/domains/renewal";
import { hostingRenewalCommandId, hostingRenewalEnabled, monthsFromRenewalLines } from "@/lib/hosting/renewal";

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
    console.error(`[renew-hosting] no owner alert for tenant ${tenantId}: ${alert.reason} — ${subject}`);
    return;
  }
  // Internal, to the owner: deliberately NOT gated by the automation switch (L64).
  await sendEmail({ to: alert.to, from: FROM_EMAIL, kind: "hosting_renewal_owner", route: { tenantId }, subject, text }).catch((e) =>
    console.error("[renew-hosting] owner alert failed:", e),
  );
}

async function handle(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!hostingRenewalEnabled()) {
    return NextResponse.json({ ran: true, renewed: 0, note: "automatic hosting renewal is switched off (HOSTING_RENEWAL_LIVE is not 1)" });
  }
  if (!commandsConfigured()) {
    return NextResponse.json({ error: "DMS_ENGINE_URL / DMS_ENGINE_COMMAND_KEY are not set, so nothing can be renewed." }, { status: 503 });
  }

  const rows = await listReadyHostingRenewals();
  const admin = createAdminClient();
  const summary = { considered: rows.length, renewed: 0, held: 0, reconciling: 0, refused: 0, skipped: 0 };

  for (const row of rows) {
    const domain = (row.domain ?? "").trim().toLowerCase();

    const policy = await loadAutonomyPolicy(row.tenant_id);
    if (policy.killSwitch) {
      await noteProvisioning(row.id, "Waiting: automation is switched off for this workspace (Automation page). Nothing was renewed.");
      summary.skipped += 1;
      continue;
    }

    const { data: quote } = await admin
      .from("quotes")
      .select("id, customer_id, line_items")
      .eq("id", row.quote_id)
      .eq("tenant_id", row.tenant_id) // service-role client: this IS the tenant boundary
      .maybeSingle();
    const q = quote as { customer_id?: string | null; line_items?: unknown } | null;
    const months = monthsFromRenewalLines(q?.line_items);
    if (!months) {
      await noteProvisioning(row.id, `Held: renewal quote ${row.quote_id} does not say one clear term (monthly or yearly), so the length to extend ${domain} by is not known. Extend it by hand in DMS.`);
      summary.held += 1;
      continue;
    }
    const { data: customer } = q?.customer_id
      ? await admin.from("customers").select("contact_email").eq("id", q.customer_id).eq("tenant_id", row.tenant_id).maybeSingle()
      : { data: null };
    const email = (customer as { contact_email?: string | null } | null)?.contact_email?.trim() || "";
    if (!email) {
      await noteProvisioning(row.id, `Held: the customer on renewal quote ${row.quote_id} has no email, so their DMS account (which holds ${domain}'s hosting) cannot be found. Extend it by hand in DMS.`);
      summary.held += 1;
      continue;
    }

    const services = await getEngineServices(email);
    if (!services.ok) {
      await noteProvisioning(row.id, `Waiting: could not read ${domain}'s hosting expiry from DMS (${services.reason}${services.detail ? `: ${services.detail}` : ""}). It will be tried again on the next run.`);
      summary.skipped += 1;
      continue;
    }
    const hosting = services.data.hostings.find((h) => h.domainName.trim().toLowerCase() === domain && h.status !== "terminated");
    const expiryBefore = expiryEpochSeconds(hosting?.expiryDate);
    if (!hosting || expiryBefore === null) {
      await noteProvisioning(
        row.id,
        `Held: DMS has ${hosting ? "no expiry date" : "no hosting account"} for ${domain} under ${email}, and the extension is only sent against the expiry DMS still has. Nothing was changed; check the account in DMS, then extend it by hand.`,
      );
      summary.held += 1;
      continue;
    }

    const outcome = await sendEngineCommand({
      commandId: hostingRenewalCommandId(row.id),
      command: "hosting.renew",
      subject: domain,
      mode: "live",
      /* Said as it is, as in provision-hosting: only a live row reaches here on a deployed server; a
         test row only on a laptop with the local test switch, and DMS holds it unless its own twin is on. */
      payload: { months, expiryBefore, paymentMode: row.payment_mode === "test" ? "test" : "live", sourceRef: row.quote_id },
    });

    switch (outcome.kind) {
      case "done": {
        const after = typeof outcome.result.expiryAfter === "string" ? outcome.result.expiryAfter : "extended";
        await markProvisioningActivated(row.id, after);
        summary.renewed += 1;
        /* The expiry moved, but a suspended account could not be switched back on. DMS
           reports that as a success with `unsuspendError`, because the renewal itself did
           land — so it is said out loud here, or the customer who paid stays suspended. */
        const unsuspendError = typeof outcome.result.unsuspendError === "string" ? outcome.result.unsuspendError : "";
        if (unsuspendError) {
          await noteProvisioning(row.id, `Extended to ${after}, but the account is still SUSPENDED: ${unsuspendError}`);
          await alertOwner(
            row.tenant_id,
            `⚠️ Hosting renewed but still suspended — ${domain}`,
            `${domain}'s hosting was extended to ${after} after the paid renewal (quote ${row.quote_id}), but it could not be switched back on:

${unsuspendError}

Unsuspend it in DMS. Do not send the renewal again; the expiry has already moved.

— ResellerOS`,
          );
        }
        break;
      }
      case "held":
      case "busy":
        await noteProvisioning(row.id, `Held: ${outcome.reason}`);
        summary.held += 1;
        break;
      case "gate_closed":
        await noteProvisioning(row.id, `Waiting: ${outcome.reason}`);
        return NextResponse.json({ ...summary, note: "the DMS engine's hosting.renew gate is closed — stopped" });
      case "needs_reconciliation":
        if (await noteProvisioning(row.id, `RECONCILE: ${outcome.reason}`)) {
          await alertOwner(
            row.tenant_id,
            `⚠️ Hosting renewal needs checking — ${domain}`,
            `Extending ${domain}'s hosting in DMS (quote ${row.quote_id}) got no clear answer.\n\n${outcome.reason}\n\nIt has NOT been retried. Check the account's expiry in DMS: if it moved on by ${months} month(s), the renewal landed. Then settle the command in DMS (Admin → Engine commands).\n\n— ResellerOS`,
          );
        }
        summary.reconciling += 1;
        break;
      case "refused":
        await markProvisioningFailed(row.id, `Not extended: ${outcome.reason}`);
        await alertOwner(
          row.tenant_id,
          `❌ Hosting renewal not applied — ${domain}`,
          `DMS did not extend ${domain}'s hosting after the paid renewal (quote ${row.quote_id}):\n\n${outcome.reason}\n\nThe customer has paid. Extend the account by hand in DMS so it is not suspended at its old expiry.\n\n— ResellerOS`,
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
