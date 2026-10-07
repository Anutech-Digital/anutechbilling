/**
 * Register-domains worker — turns a PAID domain in the provisioning queue into a
 * real registration, through the DMS engine's `domain.register` command.
 *
 * Owner decisions, 24 Sep 2026 (Todos.md §0A, 21-24): automatic, under the
 * customer's own details, into a DMS account for them, within a spend limit.
 *
 * ─── WHAT MUST BE TRUE BEFORE A LIVE COMMAND IS SENT ────────────────────────
 *   1. DOMAIN_REGISTRATION_LIVE=1 on THIS server (the paying side's gate);
 *   2. the row was fully approved by decideProvisioning: a live, verified,
 *      full payment, and the `provisioning.activate` dial on auto — otherwise it
 *      carries a blocker and is never listed here;
 *   3. the tenant's kill switch is off (checked per row, fails closed);
 *   4. the quote carries the registrant details the checkout collected.
 * The ENGINE then applies its own gate (ENGINE_DOMAIN_REGISTER_LIVE=1) and the
 * spend limit, and holds anything outside it for a person.
 *
 * ─── L1: WHAT RETRIES IT, WHO IS TOLD, HOW A FAILURE IS NOTICED ─────────────
 *   Retries: the scheduler re-runs this; every attempt on a row uses one
 *     commandId per day (registrationCommandId), so a re-run the same day is a
 *     free replay and can never register twice.
 *   Told: the tenant owner is emailed when a registration needs reconciling or
 *     the registrar refuses it. Holds are written to the row's note, which the
 *     /provisioning screen shows.
 *   Noticed later: every row stays `queued` with a note until it is activated
 *     or failed — nothing disappears.
 *
 * Auth: Bearer(CRON_SECRET) or a signed-in owner, like provision-hosting.
 */
import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { loadAutonomyPolicy } from "@/lib/ai/autonomy.server";
import {
  listReadyDomainRequests,
  markProvisioningActivated,
  markProvisioningFailed,
  noteProvisioning,
} from "@/lib/provisioning/provisioning.server";
import { commandsConfigured, sendEngineCommand } from "@/lib/dms-engine/commands";
import { dmsPanelUrl } from "@/lib/dms-engine/client";
import {
  coverFromPaid,
  domainRegistrationEnabled,
  registrantFor,
  registrationCommandId,
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
    console.error(`[register-domains] no owner alert for tenant ${tenantId}: ${alert.reason} — ${subject}`);
    return;
  }
  // Internal, to the owner: deliberately NOT gated by the automation switch (L64).
  await sendEmail({ to: alert.to, from: FROM_EMAIL, kind: "domain_registration_owner", route: { tenantId }, subject, text }).catch((e) =>
    console.error("[register-domains] owner alert failed:", e),
  );
}

/**
 * "Your domain is registered" — an automated customer send, so it goes through the
 * automation dial (`domain.registered.send`) and the kill switch like every other one.
 * A failure is logged, never thrown: the domain IS registered either way.
 */
async function tellCustomer(tenantId: string, to: string, firstName: string, domain: string, quoteId: string) {
  const panel = dmsPanelUrl("customer");
  const text =
    `Hi ${firstName || "there"},

` +
    `${domain} is now registered in your name. It usually takes a few hours for a new domain to work everywhere on the internet.

` +
    (panel
      ? `You can manage it — nameservers, DNS records, renewal — in your customer panel: ${panel}
` +
        `If this is your first time there, sign in with the one-time password from the "Your Customer Portal is ready" email, then choose your own.

`
      : `Reply to this email if you need anything changed on it.

`) +
    `Order reference: ${quoteId}
`;
  const res = await sendEmail({
    to,
    from: FROM_EMAIL,
    kind: "domain_registered_customer",
    route: { tenantId },
    subject: `${domain} is registered`,
    text,
    automated: { tenantId, action: "domain.registered.send" },
  }).catch((e: unknown) => ({ status: "failed" as const, errorMessage: e instanceof Error ? e.message : String(e) }));
  if (res && (res as { status?: string }).status === "failed") {
    console.error(`[register-domains] ${domain} registered, but the customer email to ${to} failed: ${(res as { errorMessage?: string }).errorMessage ?? "unknown error"}`);
  }
}

/**
 * R-035 (29 Sep 2026): how many years the customer paid for. The cron always sent
 * `years: 1`, so a 3-year domain was registered for one year. The count lives on the
 * queued row (provisioning_requests.years, R-031 — Abhishek's column and select); read it
 * defensively so this ships before that column does: absent, not a whole number, or
 * outside DMS's 1–10 → 1, never a guess upward that would spend more than was paid.
 */
function yearsFor(row: unknown): number {
  const y = Number((row as { years?: unknown } | null)?.years);
  return Number.isInteger(y) && y >= 1 && y <= 10 ? y : 1;
}

async function handle(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!domainRegistrationEnabled()) {
    return NextResponse.json({ ran: true, registered: 0, note: "automatic domain registration is switched off (DOMAIN_REGISTRATION_LIVE is not 1)" });
  }
  if (!commandsConfigured()) {
    // Ours to fix, not the caller's: a deployment secret is missing (L6 → 503).
    return NextResponse.json({ error: "DMS_ENGINE_URL / DMS_ENGINE_COMMAND_KEY are not set, so nothing can be registered." }, { status: 503 });
  }

  const rows = await listReadyDomainRequests();
  const admin = createAdminClient();
  const summary = { considered: rows.length, registered: 0, held: 0, reconciling: 0, refused: 0, skipped: 0 };

  for (const row of rows) {
    const domain = (row.domain ?? "").trim().toLowerCase();

    const policy = await loadAutonomyPolicy(row.tenant_id);
    if (policy.killSwitch) {
      await noteProvisioning(row.id, "Waiting: automation is switched off for this workspace (Automation page). Nothing was registered.");
      summary.skipped += 1;
      continue;
    }

    const { data: quote, error: qErr } = await admin
      .from("quotes")
      .select("id, line_items")
      .eq("id", row.quote_id)
      .eq("tenant_id", row.tenant_id) // service-role client: this IS the tenant boundary
      .maybeSingle();
    if (qErr || !quote) {
      await noteProvisioning(row.id, `Waiting: the quote ${row.quote_id} could not be read, so nothing was registered.`);
      summary.skipped += 1;
      continue;
    }

    const registrant = registrantFor((quote as { line_items?: unknown }).line_items, domain);
    if (!registrant) {
      await noteProvisioning(
        row.id,
        `Held: no registrant details (name, address) are recorded for ${domain} on quote ${row.quote_id}, and ResellerClub needs them. Register it by hand after collecting them.`,
      );
      summary.held += 1;
      continue;
    }

    const outcome = await sendEngineCommand({
      commandId: registrationCommandId(row.id),
      command: "domain.register",
      subject: domain,
      mode: "live",
      payload: {
        years: yearsFor(row),
        registrant,
        coverRupees: coverFromPaid(Number(row.amount_paid) || 0),
        paymentMode: "live",
        sourceRef: row.quote_id,
      },
    });

    switch (outcome.kind) {
      case "done": {
        const ref = String(outcome.result.orderId ?? (outcome.result.alreadyRegistered ? "already-registered" : "registered"));
        await markProvisioningActivated(row.id, ref);
        summary.registered += 1;
        /* Tell the customer — only for a registration made now, not one found already in
           the account (that customer has been told, or registered it some other way). */
        if (!outcome.result.alreadyRegistered && registrant.email) {
          await tellCustomer(row.tenant_id, registrant.email, `${registrant.firstName ?? ""}`.trim(), domain, row.quote_id);
        }
        break;
      }
      case "held":
      case "busy":
        await noteProvisioning(row.id, `Held: ${outcome.reason}`);
        summary.held += 1;
        break;
      case "gate_closed":
        // The engine's own gate is off: nothing else will get through this run either.
        await noteProvisioning(row.id, `Waiting: ${outcome.reason}`);
        return NextResponse.json({ ...summary, note: "the DMS engine's domain.register gate is closed — stopped" });
      case "needs_reconciliation":
        if (await noteProvisioning(row.id, `RECONCILE: ${outcome.reason}`)) {
          await alertOwner(
            row.tenant_id,
            `⚠️ Domain registration needs checking — ${domain}`,
            `The registration of ${domain} (quote ${row.quote_id}) reached ResellerClub and no clear answer came back.\n\n${outcome.reason}\n\nIt has NOT been retried and the domain is locked on the engine. Check ResellerClub, then settle the command in DMS (Admin → Engine commands). Do not register it by hand until you have checked.\n\n— ResellerOS`,
          );
        }
        summary.reconciling += 1;
        break;
      case "refused":
        await markProvisioningFailed(row.id, `ResellerClub refused: ${outcome.reason}`);
        await alertOwner(
          row.tenant_id,
          `❌ Domain registration refused — ${domain}`,
          `ResellerClub refused to register ${domain} (quote ${row.quote_id}):\n\n${outcome.reason}\n\nNothing was registered and nothing was spent. The customer has paid, so contact them — refund, or pick another name.\n\n— ResellerOS`,
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
