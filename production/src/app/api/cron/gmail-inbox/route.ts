/**
 * Cron: read the sales mailbox and feed anything new into the enquiry pipeline.
 *
 * ─── WHAT THIS REPLACES, AND WHY ────────────────────────────────────────────
 * An Apps Script living inside Gmail, on a 5-minute timer, POSTing each message to
 * /api/webhooks/inbound-email with a shared secret and labelling the thread `erp-sent` so
 * it would not send it twice.
 *
 * On 30 Aug 2026 that chain was found broken at its quietest link — measured, not guessed:
 *
 *   · last enquiry to reach the app:   28 Aug, 14:09 IST
 *   · every POST since:                401, in Cloud Run's own logs
 *   · what it was sending:             `?key=b051320e…`, a secret matching NEITHER value
 *                                      Cloud Run accepts — a stale copy of the script
 *   · what Gmail showed meanwhile:     the mail labelled `erp-sent`, i.e. delivered
 *
 * Six links (Gmail → filter → script → trigger → secret → webhook), and one of them could
 * fail while reporting success from inside a Google account nobody opens. This is two.
 *
 * ─── IT REUSES THE PIPELINE, IT DOES NOT REIMPLEMENT IT ─────────────────────
 * `ingestInboundEmail` is the same function the webhook calls, and the payload built by
 * `toIngestPayload` is field-for-field what the Apps Script sent — including Gmail's own
 * message id in `messageId`. So mail the old forwarder already delivered de-duplicates
 * against the existing row, and the cutover needs no migration and no cleanup.
 *
 * The webhook stays: it is still how a second reseller's inbound-parse provider delivers.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { refreshAccessToken, googleOAuthCreds } from "@/lib/google/oauth";
import { listRecentMessageIds, fetchMessage, toIngestPayload } from "@/lib/email/gmail-read";
import { ingestInboundEmail } from "@/lib/inbound/ingest";
import { cronDbFailure } from "@/app/api/cron/_lib/db-failure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The scope this needs. Its absence is a specific, fixable state — see below. */
const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * How many new messages to ingest in one run.
 *
 * Each one may call Gemini, so an unbounded batch could hold the request open past Cloud
 * Run's timeout and lose the tail. At a one-minute cadence a cap of ten drains a backlog of
 * a hundred in ten minutes, and the window in `DEFAULT_QUERY` is two days — nothing ages
 * out while it catches up. Anything skipped is reported, never silently dropped.
 */
const MAX_PER_RUN = 10;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  if (!timingSafeEqualStr(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const creds = googleOAuthCreds();
  if (!creds) {
    return NextResponse.json(reportCron("gmail-inbox", {
      ok: false, failed: 1,
      errors: ["GOOGLE_OAUTH_CLIENT_ID / SECRET are not configured on this server."],
    }), { status: 503 });
  }

  const admin = createAdminClient();
  const { data: accounts, error } = await admin
    .from("user_google_tokens")
    .select("user_id, tenant_id, google_email, refresh_token, scopes")
    .not("refresh_token", "is", null);
  if (error) return cronDbFailure("gmail-inbox", error, error.message);

  /* ── A MISSING SCOPE IS NOT A CRASH, IT IS AN INSTRUCTION (§24) ───────────
     The connected account has gmail.send but was never asked for gmail.readonly, and the
     only cure is a human clicking Connect once. Saying "0 messages" every minute would be
     the same silence that hid the forwarder for two days. */
  const readable = (accounts ?? []).filter((a) => (a.scopes ?? "").includes(READ_SCOPE));
  if (readable.length === 0) {
    const who = (accounts ?? []).map((a) => a.google_email).filter(Boolean).join(", ");
    return NextResponse.json(reportCron("gmail-inbox", {
      ok: false, failed: 1, accounts: (accounts ?? []).length,
      errors: [
        `No connected Google account has ${READ_SCOPE}` +
        (who ? ` — ${who} is connected but for sending only.` : " — no account is connected.") +
        " Reconnect it from Settings → Integrations to grant reading, or enquiries will not arrive.",
      ],
    }));
  }

  let fetched = 0, ingested = 0, skipped = 0, deferred = 0, failed = 0;
  const errors: string[] = [];

  for (const acct of readable) {
    try {
      const token = await refreshAccessToken(acct.refresh_token as string, creds);
      const access = token.access_token;
      if (!access) throw new Error("Google returned no access token for the refresh token.");

      const ids = await listRecentMessageIds(access);
      fetched += ids.length;
      if (ids.length === 0) continue;

      /* ── ASK THE DATABASE WHAT IT ALREADY HAS, IN ONE QUERY ───────────────
         The alternative is to hand every id to the pipeline and let the UNIQUE constraint
         reject the repeats. That works — it is why the cutover is safe — but at a
         one-minute cadence over a two-day window it would re-download and re-read every
         message in the mailbox, forever, and each one can reach Gemini. */
      const { data: known } = await admin
        .from("inbound_emails")
        .select("message_id")
        .eq("tenant_id", acct.tenant_id)
        .in("message_id", ids);
      const seen = new Set((known ?? []).map((k) => k.message_id as string));

      const fresh = ids.filter((id) => !seen.has(id));
      skipped += ids.length - fresh.length;

      const batch = fresh.slice(0, MAX_PER_RUN);
      deferred += fresh.length - batch.length;

      /* Newest-first is what Gmail returns; reversed so a conversation is ingested in the
         order it happened. The thread matcher reads earlier messages of a lead, and giving
         it the reply before the enquiry makes it answer about a thread that does not
         exist yet. */
      for (const id of batch.reverse()) {
        try {
          const msg = await fetchMessage(access, id);
          const payload = toIngestPayload(msg);
          if (!payload.from) { skipped++; continue; }
          const res = await ingestInboundEmail(payload as unknown as Record<string, unknown>);
          if (res.status >= 400) {
            failed++;
            errors.push(`${id}: pipeline returned ${res.status}`);
          } else {
            ingested++;
          }
        } catch (e) {
          /* One bad message must not abort the batch — that is how a single malformed mail
             would stop every enquiry behind it. */
          failed++;
          errors.push(`${id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      failed++;
      const why = (e as Error).message;
      errors.push(`${acct.google_email ?? acct.user_id}: ${why}`);
      await admin.from("user_google_tokens").update({ last_error: why }).eq("user_id", acct.user_id);
    }
  }

  /* `deferred` is reported rather than swallowed: a cap that goes unmentioned reads as
     "everything was processed" on exactly the run where it was not. */
  return NextResponse.json(reportCron("gmail-inbox", {
    ok: failed === 0,
    accounts: readable.length, fetched, ingested, skipped, deferred, failed, errors,
  }));
}

export const GET = handle;
export const POST = handle;
