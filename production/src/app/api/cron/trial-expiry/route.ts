/**
 * Trial expiry cron — runs daily.
 *
 * For every lead at stage='trial' whose trial_expires_at <= today AND
 * trial_converted_at is NULL AND trial_expired_at is NULL:
 *   1. Mark trial_expired_at = now()
 *   2. Stage stays 'trial' (NOT auto-moved to 'lost') — operator decides
 *      whether to push for last-ditch conversion or close the deal out.
 *      Rationale: many trials convert on day 15-17 after a final call.
 *   3. Send "we miss you" email to customer + alert to Pardeep
 *
 * Schedule: 10:00 IST (04:30 UTC) — daily, after the renewals cron.
 * Configure via vercel.json or your scheduler of choice.
 *
 * Auth: Same Bearer-token pattern as the renewals cron. Set CRON_SECRET
 * in env. FAIL CLOSED — without the secret configured the route refuses
 * (503), and a wrong/missing bearer → 401 (constant-time compare). (SEC-3)
 */

import { reportCron } from "@/lib/ops/cron-report";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { fetchAllRows, fetchAllRowsIn, errorMessage } from "@/lib/ops/fetch-all";
import { sendEmail } from "@/lib/email/send";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { resolveOwnerAlert, type TenantContact } from "@/lib/email/owner-alert";
import { storefrontVoice } from "@/lib/email/storefront-voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FROM_EMAIL    = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL       = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";

interface CronResult {
  ran_at:         string;
  total_expired:  number;
  emails_sent:    number;
  /**
   * Alerts that had nowhere to go, per tenant. Surfaced in the RESPONSE and not
   * only in a log line, because L1's third question — "how would you notice this
   * a week later?" — has no answer for a console.error nobody reads. A tenant
   * whose trials expire into silence shows up here.
   */
  alerts_unaddressed: { tenant_id: string; reason: string }[];
  errors:         { lead_id: string; message: string }[];
  details:        { lead_id: string; company: string; days_past: number }[];
  /** Hosting trials whose cPanel account was suspended on expiry. */
}

function checkAuth(req: Request): NextResponse | null {
  // FAIL CLOSED (SEC-3): this job expires trials + emails under service-role.
  // No secret configured → refuse (was: fail-open "dev mode — allow").
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const match  = /^Bearer\s+(.+)$/i.exec(header);
  if (!timingSafeEqualStr(match?.[1] ?? "", secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(req: Request)  { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request) {
  const auth = checkAuth(req);
  if (auth) return auth;

  const admin = createAdminClient();
  const today = new Date();
  const result: CronResult = {
    ran_at:        today.toISOString(),
    total_expired: 0,
    emails_sent:   0,
    alerts_unaddressed: [],
    errors:        [],
    details:       [],
  };

  // Pull trials past their expiry that haven't been marked yet
  /* WC-scale: paged (lib/ops/fetch-all.ts) — every expired trial in one pass, not the first
     1000 PostgREST hands back. All rows are read BEFORE any is stamped, so the stamping
     cannot shift the pages. */
  let leads: { id: string; tenant_id: string; company: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null; plan: string | null; domain: string | null; source: string | null; trial_expires_at: string | null; trial_started_at: string | null }[];
  try {
    leads = await fetchAllRows((from, to) => admin
      .from("leads")
      .select("id, tenant_id, company, contact_name, contact_email, contact_phone, plan, domain, source, trial_expires_at, trial_started_at")
      .eq("stage", "trial")
      .is("trial_converted_at", null)
      .is("trial_expired_at", null)
      .lte("trial_expires_at", today.toISOString())
      .order("id", { ascending: true })
      .range(from, to));
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }

  /* ── Whose trial is this? ──────────────────────────────────────────────────
     The query above has always SELECTED `tenant_id` and never read it. Every
     alert went to one hardcoded address instead, so in a multi-tenant product
     each tenant's lead — company, contact name, email, phone, domain — was
     mailed to a third party, and the tenant whose trial it was never heard.
     Same defect api/webhooks/razorpay/route.ts fixed earlier; this route was
     missed. One query for the whole batch rather than one per lead. */
  const tenantIds = [...new Set((leads ?? []).map((l) => l.tenant_id).filter(Boolean))];
  const tenantById = new Map<string, TenantContact>();
  if (tenantIds.length) {
    let tenantRows: { id: string; name: string; email: string | null; phone: string | null; contact_name: string | null }[] = [];
    let tErr: { message: string } | null = null;
    try {
      tenantRows = await fetchAllRowsIn(tenantIds, (ids, from, to) => admin
        .from("tenants")
        .select("id, name, email, phone, contact_name")
        .in("id", ids)
        .order("id", { ascending: true })
        .range(from, to));
    } catch (e) {
      tErr = { message: errorMessage(e) };
    }
    if (tErr) {
      /* A failed lookup must not become a send to the wrong inbox (rule 5: no
         failsafe fallback). Refuse the whole run — the trials are unstamped, so
         tomorrow's run picks them up intact. Stamping them now with no alert
         would lose the notification permanently and silently. */
      return NextResponse.json(
        { error: `could not resolve tenants for the alerts: ${tErr.message}` },
        { status: 500 },
      );
    }
    for (const t of tenantRows) tenantById.set(t.id, t as TenantContact);
  }

  for (const lead of leads) {
    try {
      // Stamp expiry
      const { error: updErr } = await admin
        .from("leads")
        .update({ trial_expired_at: today.toISOString() })
        .eq("id", lead.id);
      if (updErr) throw updErr;

      result.total_expired++;
      const expiresAt = new Date(lead.trial_expires_at ?? today);
      const daysPast  = Math.round((today.getTime() - expiresAt.getTime()) / 86400000);
      result.details.push({
        lead_id:   lead.id,
        company:   lead.company,
        days_past: daysPast,
      });

      /* This lead's own reseller, resolved per lead. `owner` is either an address
         or a stated reason — never a substituted one. */
      const tenant = tenantById.get(lead.tenant_id) ?? null;
      const owner  = resolveOwnerAlert(tenant, lead.tenant_id);
      const sellerName   = tenant?.name?.trim() || "";
      const sellerPerson = tenant?.contact_name?.trim() || sellerName;
      const sellerPhone  = (tenant as { phone?: string | null } | null)?.phone?.trim() || "";
      /* The storefront signs as the company and takes replies at support (lib/email/storefront-voice.ts);
         a reseller tenant signs as itself. A reply still needs the owner address resolved (owner.ok). */
      const voice = storefrontVoice(lead.tenant_id);
      const contactWho = voice ? "us" : sellerPerson || "us";

      // ── Hosting trials: a hosting-worded note ─────────────────────────────
      // (The Workspace-worded customer email below is gated to non-hosting leads.)
      // No DirectAdmin suspend from here any more (25 Sep 2026): trial accounts are
      // created by the DMS engine under DMS's own usernames, and DMS suspends an
      // expired trial itself at the Hosting row's expiry. The suspend this cron used
      // to send guessed the username with this app's old scheme, which no longer
      // matches the account.
      const isHosting = lead.source === "buy-hosting-trial";
      if (isHosting) {
        if (lead.contact_email && owner.ok) {
          try {
            await sendEmail({
              to:        lead.contact_email,
              from:      FROM_EMAIL,
              replyTo:   voice ? voice.replyTo : owner.to,
              kind:      "trial_expiry_customer",
              route:     { tenantId: lead.tenant_id },
              automated: { tenantId: lead.tenant_id, action: "trial.send" },
              subject:   `Your hosting trial${lead.domain ? ` for ${lead.domain}` : ""} has ended`,
              text:
`Hi ${(lead.contact_name ?? "").split(" ")[0] || "there"},

Your hosting trial${lead.domain ? ` on ${lead.domain}` : ""} has ended${daysPast === 0 ? " today" : ` ${daysPast} days ago`}, so the account is paused for now.

Everything you built is safe. To keep your site live, just reply and we'll convert you to a paid plan — you pick up exactly where you left off, no data loss.

${sellerPhone ? `Prefer to talk? WhatsApp ${contactWho} on ${sellerPhone}.\n\n` : ""}${voice ? voice.signOff : `— ${sellerPerson || sellerName || "Your hosting team"}${sellerName && sellerPerson !== sellerName ? `\n   ${sellerName}` : ""}`}`,
            });
            result.emails_sent++;
          } catch (e) {
            console.error("[trial-expiry] hosting customer email failed:", e);
          }
        }
      }

      // Best-effort emails — don't fail the cron if these break
      /* The customer mail needs somewhere for a reply to LAND. Without the
         reseller's address it used to point at a hardcoded third party, which is
         worse than not sending: the customer replies and nobody who can help ever
         sees it. So this now requires `owner.ok`, and the skip is counted. */
      if (!isHosting && lead.contact_email && owner.ok) {
        try {
          await sendEmail({
            to:      lead.contact_email,
            from:    FROM_EMAIL,
            replyTo: voice ? voice.replyTo : owner.to,
            kind:    "trial_expiry_customer",
            route:   { tenantId: lead.tenant_id },
            /* Customer-facing, so gated by the kill switch + dial. The OWNER copy further
               down is deliberately NOT: a switch that silenced what the app says to the
               operator would hide the very thing they flipped it to investigate. */
            automated: { tenantId: lead.tenant_id, action: "trial.send" },
            subject: `Your Google Workspace trial — ${lead.domain ?? "your domain"} — has ended`,
            text:
`Hi ${(lead.contact_name ?? "").split(" ")[0] || "there"},

Your 14-day Google Workspace trial on ${lead.domain ?? "your domain"} ended ${daysPast === 0 ? "today" : `${daysPast} days ago`}.

We hope it gave you a real feel for how it would work day-to-day. We'd love to
know how it went — and if you'd like to convert to a paid plan, we can pick up
right where you left off (no data loss, just billing kicks in).

Just reply to this email${sellerPhone ? `, or WhatsApp ${contactWho} on ${sellerPhone}` : ""} — we'll get you sorted quickly.

${voice ? voice.signOff : `— ${sellerPerson || sellerName || "Your reseller"}${sellerName && sellerPerson !== sellerName ? `\n   ${sellerName}` : ""}`}`,
          });
          result.emails_sent++;
        } catch (e) {
          console.error("[trial-expiry] customer email failed:", e);
        }
      }

      if (!owner.ok) {
        /* Loud, and in the response. The trial IS stamped expired — that part
           succeeded and is in the database. Only the notifications are lost, and
           this is the record of which and why. */
        console.error(`[trial-expiry] no owner alert for lead ${lead.id}: ${owner.reason}`);
        if (!result.alerts_unaddressed.some((a) => a.tenant_id === lead.tenant_id)) {
          result.alerts_unaddressed.push({ tenant_id: lead.tenant_id, reason: owner.reason });
        }
        continue;
      }

      try {
        await sendEmail({
          to:      owner.to,
          from:    FROM_EMAIL,
          kind:    "trial_expiry_owner",
          route:   { tenantId: lead.tenant_id },
          subject: `⏰ Trial expired: ${lead.company} (${lead.domain ?? "no domain"}) — last chance`,
          text:
`A 14-day trial just ended.

COMPANY      ${lead.company}
CONTACT      ${lead.contact_name ?? "—"} <${lead.contact_email ?? "—"}>
PHONE        ${lead.contact_phone ?? "—"}
PLAN         ${lead.plan ?? "—"}
DOMAIN       ${lead.domain ?? "—"}
STARTED      ${lead.trial_started_at ? new Date(lead.trial_started_at).toDateString() : "—"}
EXPIRED      ${new Date(lead.trial_expires_at ?? today).toDateString()} (${daysPast} days ago)

${lead.contact_email
  ? `A "we miss you" email has been sent to the customer. Customer responses\nin the next 3-5 days still often convert — call them if they don't reply.`
  : `NO EMAIL WAS SENT TO THE CUSTOMER — this lead has no contact_email on file.\nReaching out is entirely on you. Add an address to the lead so the next one goes out.`}

Open the lead:
${APP_URL}/leads?lead=${lead.id}

— ResellerOS`,
        });
        result.emails_sent++;
      } catch (e) {
        /* Was "pardeep alert failed" — a fixed name in a message about whichever
           tenant this lead belongs to. */
        console.error(`[trial-expiry] owner alert failed for tenant ${lead.tenant_id}:`, e);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ lead_id: lead.id, message: msg });
    }
  }

  return NextResponse.json(reportCron("trial-expiry", result));
}
