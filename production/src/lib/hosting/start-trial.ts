/**
 * Start a free hosting trial — the one place it happens.
 *
 * Moved here from POST /api/public/trial/hosting on 24 Sep 2026, when the trial
 * form page was removed (Pardeep: "Start free trial" should go to the cart, with
 * no page in between). The site cart checkout calls this for a
 * `hosting-trial:starter` line; nothing else does.
 *
 * Unchanged from the route it came from: it CAPTURES the request as a qualified
 * lead (stage='trial'), emails the customer a confirmation
 * link, and schedules follow-up tasks. It does NOT create a cPanel account —
 * that happens only after the customer confirms their email
 * (api/public/trial/hosting/confirm), behind HOSTING_TRIAL_LIVE.
 *
 * Only Starter is trialled (owner, 24 Sep 2026) — see ./trial-plan.
 */
import type { NextRequest } from "next/server";
import { captureFromRequest } from "@/lib/marketing/utm";
import type { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { storefrontVoice } from "@/lib/email/storefront-voice";
import { makeTrialToken } from "@/lib/hosting/trial-token";
import { TRIAL_PLAN_ID, TRIAL_PLAN_NAME } from "@/lib/hosting/trial-plan";
import { checkTrialHistory, recordTrialInDms } from "@/lib/dms-engine/trials";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

export const TRIAL_DAYS = 15;

export interface StartTrialInput {
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  /** Blank when the customer has no domain yet — the owner helps them pick one. */
  domain?: string;
  /** What the trial converts to. Recorded on the lead for the conversion call. */
  cycle: "monthly" | "yearly";
}

export type StartTrialResult =
  | {
      ok: true;
      leadId: string;
      trialEnds: string;
      /** Did the confirmation link actually leave? The page must not say "we sent a link"
          when it did not (30 Sep 2026). */
      confirmationSent: boolean;
    }
  | { ok: false; error: string; alreadyTrialled?: true; trialStartedOn?: string };

/** Escape LIKE wildcards, so an email containing `_` or `%` matches only itself. */
export function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Double-quote a value for a PostgREST `or=(…)` filter, so a comma or bracket in it cannot split the filter. */
export function quoteForOr(v: string): string {
  return `"${v.replace(/"/g, '\\"')}"`;
}

/**
 * One free trial per customer (owner, 24 Sep 2026), asked on its own.
 *
 * Moved out of startHostingTrial unchanged on 26 Sep 2026, so the DMS panel can ask the
 * SAME question before it offers the trial (POST /api/dms/trial-eligibility), and the
 * panel and the checkout can never give different answers. Read-only. Fails closed: an
 * unreadable history is `ok: false`, never "eligible".
 */
export type TrialEligibility =
  | { ok: true; eligible: true }
  | { ok: true; eligible: false; error: string; /** "30 Sept 2026" — when the earlier trial began, if known. */ startedOn?: string }
  | { ok: false; error: string };

/** The domain as the trial stores it: lower-case, no scheme, no trailing slash. */
export function normaliseTrialDomain(domain: string | undefined): string {
  return (domain || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .trim();
}

/**
 * The one-trial-per-customer check switched off, for testing on a local machine:
 * `ALLOW_REPEAT_TRIALS_LOCAL=1` in .env.local, and only when NODE_ENV is not
 * "production" — so a deployed build keeps the check even if the variable leaks in.
 */
export function repeatTrialsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && env.ALLOW_REPEAT_TRIALS_LOCAL?.trim() === "1";
}

export async function checkTrialEligibility(
  admin: ReturnType<typeof createAdminClient>,
  input: { email: string; phone: string; domain?: string },
): Promise<TrialEligibility> {
  // Local testing only (Pawan, 1 Oct 2026): start trial after trial on the same details.
  // Never in a production build, whatever the variable says.
  if (repeatTrialsAllowed()) return { ok: true, eligible: true };
  const tierName = TRIAL_PLAN_NAME;
  const cleanDomain = normaliseTrialDomain(input.domain);

  // The site has no customer login, so "the same customer" is judged on what we
  // hold: an earlier trial with the same email, the same phone number (last 10
  // digits, so +91 / spaces do not matter) or the same website domain. Read
  // BEFORE anything is written; an unreadable history refuses rather than lets a
  // second trial through (fail closed), and says so.
  const emailKey = input.email.trim().toLowerCase();
  const phoneKey = input.phone.replace(/\D/g, "").slice(-10);
  const orParts = [`contact_email.ilike.${quoteForOr(likeEscape(emailKey))}`];
  if (phoneKey.length === 10) orParts.push(`contact_phone.ilike.${quoteForOr(`%${phoneKey}`)}`);
  if (cleanDomain.length >= 3) orParts.push(`domain.eq.${quoteForOr(cleanDomain)}`);
  const { data: priorTrials, error: priorErr } = await admin
    .from("leads")
    .select("id, created_at")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("source", "buy-hosting-trial")
    .or(orParts.join(","))
    .order("created_at", { ascending: true })
    .limit(1);
  if (priorErr) {
    console.error("[checkTrialEligibility] could not read earlier trials:", priorErr);
    return { ok: false, error: "We couldn't check whether you've had a trial before, so we haven't started one. Nothing was saved. Please try again in a minute." };
  }
  if (priorTrials && priorTrials.length > 0) {
    const when = new Date(priorTrials[0].created_at as string).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    return {
      ok: true,
      eligible: false,
      startedOn: when,
      error:
        `You've already had a free hosting trial with us (started ${when}), and it's one per customer — matched on this email, phone number or domain. ` +
        `Nothing was saved. You can buy ${tierName} from the hosting page, or reply to our earlier email if you need more time on the trial.`,
    };
  }

  // …and in DMS: a trial in the DMS customer panel, or one this app recorded
  // there, on the same email, phone or domain also counts. DMS not answering
  // refuses the trial rather than reads as "no earlier trial".
  const dmsHistory = await checkTrialHistory({ email: emailKey, phone: phoneKey || undefined, domain: cleanDomain || undefined });
  if (!dmsHistory.ok) {
    console.error(`[checkTrialEligibility] could not check DMS trial history: ${dmsHistory.reason}`);
    return { ok: false, error: "We couldn't check whether you've had a trial before, so we haven't started one. Nothing was saved. Please try again in a minute." };
  }
  if (dmsHistory.trialled) {
    const startedOn = dmsHistory.startedAt
      ? new Date(dmsHistory.startedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
      : undefined;
    const when = startedOn ? ` (started ${startedOn})` : "";
    return {
      ok: true,
      eligible: false,
      ...(startedOn ? { startedOn } : {}),
      error:
        `You've already had a free hosting trial with us${when}, and it's one per customer — matched on this email, phone number or domain. ` +
        `Nothing was saved. You can buy ${tierName} from the hosting page, or reply to our earlier email if you need more time on the trial.`,
    };
  }
  return { ok: true, eligible: true };
}

export async function startHostingTrial(
  admin: ReturnType<typeof createAdminClient>,
  input: StartTrialInput,
  request: NextRequest,
  utmBody: Record<string, unknown>,
): Promise<StartTrialResult> {
  const { fullName, companyName, email, phone, domain, cycle } = input;
  const domainStatus: "have" | "need" = (domain ?? "").trim().length >= 3 ? "have" : "need";
  const tierId = TRIAL_PLAN_ID;
  const tierName = TRIAL_PLAN_NAME;
  const leadId = "L-" + Date.now().toString(36).toUpperCase();

  const cleanDomain = normaliseTrialDomain(domain);


  // One free trial per customer — the same check the DMS panel asks beforehand
  // (checkTrialEligibility above), so the two can never disagree.
  const eligibility = await checkTrialEligibility(admin, { email, phone, domain });
  if (!eligibility.ok) return { ok: false, error: eligibility.error };
  if (!eligibility.eligible) {
    return { ok: false, alreadyTrialled: true, error: eligibility.error, ...(eligibility.startedOn ? { trialStartedOn: eligibility.startedOn } : {}) };
  }
  // The same keys the check matched on, for DMS's shared trial record below.
  const emailKey = email.trim().toLowerCase();
  const phoneKey = phone.replace(/\D/g, "").slice(-10);

  const notes = [
    `HOSTING TRIAL REQUEST · ${TRIAL_DAYS}-day free trial (no card)`,
    `Plan to trial: ${tierName} hosting (cPanel on Google Cloud)`,
    `After the trial: ${tierName} billed ${cycle}`,
    domainStatus === "need"
      ? `Domain: needs a new domain`
      : cleanDomain
        ? `Domain: ${cleanDomain} (existing — migrate)`
        : `Domain: not specified`,
    `Submitted via the site cart checkout`,
    ``,
    `NEXT STEPS (provisioning is gated — do this to start the trial):`,
    `  1. Create the ${tierName} cPanel account in DirectAdmin`,
    `  2. ${domainStatus === "need" ? "Help the customer register a domain" : `Set up ${cleanDomain || "their domain"} / offer free migration`}`,
    `  3. Send cPanel login to ${email} + WhatsApp ${phone}`,
    `  4. Day 12: conversion outreach; Day ${TRIAL_DAYS}: convert to paid or close`,
  ].filter(Boolean).join("\n");

  const trialStartedAt = new Date();
  const trialExpiresAt = new Date(trialStartedAt.getTime() + TRIAL_DAYS * 86400000);

  const { error: leadErr } = await admin.from("leads").insert({
    id: leadId,
    tenant_id: BUY_PAGE_TENANT_ID,
    company: companyName,
    contact_name: fullName,
    contact_email: email,
    contact_phone: phone,
    plan: `hosting-${tierId}`,
    seats: 1,
    value: 0,
    stage: "trial",
    source: "buy-hosting-trial",
    ...captureFromRequest(request, utmBody),
    domain: cleanDomain || null,
    notes,
    trial_started_at: trialStartedAt.toISOString(),
    trial_expires_at: trialExpiresAt.toISOString(),
  });

  if (leadErr) {
    // 23503 on tenant_id: BUY_PAGE_TENANT_ID names a tenant this database does not
    // have. A deployment fault that no retry can fix, so the customer is not told to
    // retry, and the log says exactly which setting to correct. Measured 24 Sep 2026:
    // the local database has no row for the production fallback id, so every trial
    // failed here while the message said "please try again".
    if (leadErr.code === "23503" && /tenant/i.test(`${leadErr.message} ${leadErr.details ?? ""}`)) {
      console.error(
        `[startHostingTrial] BUY_PAGE_TENANT_ID=${BUY_PAGE_TENANT_ID} is not a tenant in this database. ` +
          "Set BUY_PAGE_TENANT_ID to the tenant the site sells for. Nothing was saved.",
      );
      return { ok: false, error: "We can't start trials right now — the problem is on our side, not yours, and trying again won't help yet. Nothing was saved. Please email or WhatsApp us using the details on this page and we'll set your trial up by hand." };
    }
    console.error("[startHostingTrial] lead insert failed:", leadErr);
    return { ok: false, error: "Could not start your trial — nothing was saved, so please try again. If it happens twice, email us using the address on this page and we will set it up by hand." };
  }

  // Tell DMS, so a later trial in its customer panel on the same email, phone or
  // domain is refused there. If DMS cannot be told, the trial still stands (this
  // app will refuse a repeat here), but the gap is written on the lead and in the
  // error log rather than left silent.
  const recorded = await recordTrialInDms({
    ref: leadId, email: emailKey, phone: phoneKey || undefined, domain: cleanDomain || undefined, planId: tierId, cycle,
  });
  if (!recorded.ok) {
    console.error(`[startHostingTrial] trial ${leadId} started but NOT recorded in DMS: ${recorded.reason}`);
    await admin
      .from("leads")
      .update({ notes: `${notes}\n\n⚠ NOT RECORDED IN DMS (${recorded.reason}). DMS cannot see this trial, so the same customer could start another in the DMS panel. Record it there by hand.` })
      .eq("id", leadId);
  }

  // Follow-up tasks — best-effort (non-fatal).
  try {
    const day12 = new Date(trialStartedAt.getTime() + 12 * 86400000);
    const day15 = new Date(trialStartedAt.getTime() + TRIAL_DAYS * 86400000);
    day12.setHours(10, 0, 0, 0);
    day15.setHours(10, 0, 0, 0);
    await admin.from("tasks").insert([
      {
        tenant_id: BUY_PAGE_TENANT_ID,
        title: `Provision hosting trial: ${companyName} (${tierName})`,
        notes: `New ${TRIAL_DAYS}-day hosting trial. Create the ${tierName} cPanel account and send login to ${email}.`,
        kind: "followup",
        due_at: trialStartedAt.toISOString(),
        lead_id: leadId,
      },
      {
        tenant_id: BUY_PAGE_TENANT_ID,
        title: `Conversion call: ${companyName} — hosting trial ends in 3 days`,
        notes: `Day 12 of ${TRIAL_DAYS}-day hosting trial. Discuss converting to a paid ${tierName} plan.`,
        kind: "call",
        due_at: day12.toISOString(),
        lead_id: leadId,
      },
      {
        tenant_id: BUY_PAGE_TENANT_ID,
        title: `Hosting trial expires TODAY: ${companyName}`,
        notes: `${TRIAL_DAYS}-day hosting trial ends. Convert to paid or close the account.`,
        kind: "call",
        due_at: day15.toISOString(),
        lead_id: leadId,
      },
    ]);
  } catch (taskErr) {
    console.error("[startHostingTrial] task auto-create failed (non-fatal):", taskErr);
  }

  const trialEndsFmt = trialExpiresAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  // Email-verification link — the bot guard. The account is provisioned only
  // after the customer clicks this. Without a signing secret configured we
  // can't verify a link, so we fall back to the manual "we'll set it up" note.
  const token = makeTrialToken(leadId);
  // Links are built from the request's own origin (AGENTS.md L112): it needs no
  // configuration and cannot point at a dead fallback host.
  const confirmUrl = token ? new URL(`/api/public/trial/hosting/confirm?token=${encodeURIComponent(token)}`, request.url).toString() : null;
  const firstName = fullName.split(" ")[0];

  const { alert: owner, tenant: ownerTenant } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
  if (!owner.ok) {
    console.error(`[trial/hosting] lead ${leadId} saved, but no owner alert: ${owner.reason}`);
  }
  const ownerName = owner.ok ? owner.ownerName : "";
  // The storefront signs as the company and takes replies at support (lib/email/storefront-voice.ts).
  const voice = storefrontVoice(BUY_PAGE_TENANT_ID);
  const signOff = voice ? voice.signOff : `— ${ownerName || ownerTenant?.name?.trim() || "Your hosting team"}${
    ownerTenant?.name?.trim() && ownerName !== ownerTenant.name.trim() ? `\n   ${ownerTenant.name.trim()}` : ""
  }`;
  const customerReplyTo = voice ? voice.replyTo : owner.ok ? owner.to : null;
  const customerSubject = confirmUrl
    ? `Confirm your email to start your ${TRIAL_DAYS}-day hosting trial`
    : `Your ${TRIAL_DAYS}-day hosting trial${cleanDomain ? ` — ${cleanDomain}` : ""}`;
  const customerText = confirmUrl
    ? `Hi ${firstName},

One quick step to start your free ${TRIAL_DAYS}-day ${tierName} hosting trial —
confirm this is your email by opening the link below:

${confirmUrl}

As soon as you do${domainStatus === "need" ? ", we'll be in touch to help you pick a domain and set the account up" : `, we set up your ${tierName} cPanel account${cleanDomain ? ` for ${cleanDomain}` : ""} and email your login`}.
No credit card, ${TRIAL_DAYS} days fully free. The link is valid for 48 hours.

If you didn't request this, you can ignore this email — nothing happens without
that click.

${signOff}`
    : `Hi ${firstName},

Thanks for starting a ${tierName} hosting trial${ownerTenant?.name?.trim() ? ` with ${ownerTenant.name.trim()}` : ""}. We'll set up your
cPanel account and email your login within a few hours. No credit card, ${TRIAL_DAYS}
days fully free. Trial ends ${trialEndsFmt}.

${signOff}`;

  /* ── The customer's confirmation link: the one email the customer is waiting for ──
     Sent first, on its own, and whatever the owner alert does. Until 30 Sep 2026 both
     emails were awaited together AND gated on the owner alert resolving: the customer sat
     on "Starting your trial…" while the owner was emailed (25 s of a 30 s wait, measured),
     and a workspace with no owner alert address sent the customer no link at all while
     the page still said "We sent a link". */
  const confirmation = await sendEmail({
    to: email,
    from: FROM_EMAIL,
    ...(customerReplyTo ? { replyTo: customerReplyTo } : {}),
    kind: "buy_page_trial_customer",
    route: { tenantId: BUY_PAGE_TENANT_ID },
    subject: customerSubject,
    text: customerText,
  }).catch((e: unknown) => ({ status: "failed" as const, errorMessage: (e as Error).message }));
  const confirmationSent = confirmation.status === "sent";
  if (!confirmationSent) {
    console.error(`[trial/hosting] lead ${leadId}: the confirmation link did NOT reach ${email}: ${confirmation.errorMessage ?? confirmation.status}`);
  }

  /* No owner email for a trial (owner, 30 Sep 2026: "remove this feature completely — that
     will just annoy the owner"). The trial is on the lead (stage trial) with its follow-up
     tasks, which is where staff see it. */
  return { ok: true, leadId, trialEnds: trialExpiresAt.toISOString(), confirmationSent };
}
