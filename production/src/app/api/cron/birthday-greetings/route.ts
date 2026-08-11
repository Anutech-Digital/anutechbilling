/**
 * Birthday / anniversary greeting cron — runs nightly.
 *
 * Schedule: 21:01 IST daily (Cloud Scheduler job `resellersos-birthday-greetings`
 * → GET this URL with `Authorization: Bearer <CRON_SECRET>`). Also declared in
 * vercel.json for parity. Local dev:
 *   curl http://localhost:3000/api/cron/birthday-greetings -H "Authorization: Bearer <CRON_SECRET>"
 *
 * What it does, for every contact (across tenants) whose birthday OR anniversary
 * falls TODAY (IST, month-day match, year ignored) and who has an email:
 *   1. Claim a (tenant, contact, kind, channel, year) row in contact_greeting_log
 *      via a unique-constraint upsert — this is the idempotency gate, so re-runs
 *      / retries never double-send within the same year.
 *   2. Send a warm Hinglish greeting via lib/email/send (real Resend if
 *      configured; stub otherwise — both are recorded).
 *   3. On send-failure, release the claim so a later run the same day retries.
 *
 * Auth: FAIL CLOSED. Requires CRON_SECRET (mirrors the renewals cron). Sending
 * on the owner's behalf is an explicit, owner-requested automation.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GreetingResult {
  ran_at:        string;
  email_mode:    "real" | "stub";
  matched:       number;
  sent:          number;
  stubbed:       number;
  skipped_no_email: number;
  already_done:  number;
  failed:        number;
  errors:        { contact_id: string; message: string }[];
}

type Kind = "birthday" | "anniversary";

/** First name for a warm greeting; falls back to the whole name. */
function firstName(full: string | null): string {
  const n = (full ?? "").trim();
  return n.split(/\s+/)[0] || "there";
}

/** Hinglish greeting copy. Customer-facing → stays Hinglish (app UI is English). */
function greetingCopy(kind: Kind, name: string, tenantName: string): { subject: string; text: string } {
  const first = firstName(name);
  if (kind === "birthday") {
    return {
      subject: `Happy Birthday, ${first}! 🎂`,
      text:
`Namaste ${first},

Aapko janamdin ki dher saari shubhkaamnaayein! 🎂🎉
Aapka aane wala saal khushiyon, sehat aur safalta se bhara ho.

Warm wishes,
${tenantName}`,
    };
  }
  return {
    subject: `Happy Anniversary, ${first}! 💐`,
    text:
`Namaste ${first},

Aapko anniversary ki dil se dher saari shubhkaamnaayein! 💐🎉
Yeh khaas din aur aane wale saal aapke liye yaadgaar rahein.

Warm wishes,
${tenantName}`,
  };
}

export async function GET(req: Request)  { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request): Promise<NextResponse<GreetingResult | { error: string }>> {
  // ── Auth — FAIL CLOSED ────────────────────────────────────────────────
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const result: GreetingResult = {
    ran_at:     new Date().toISOString(),
    email_mode: isEmailConfigured() ? "real" : "stub",
    matched: 0, sent: 0, stubbed: 0, skipped_no_email: 0, already_done: 0, failed: 0,
    errors: [],
  };

  // ── Today in IST (month-day match, year ignored) ──────────────────────
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayMonth = istNow.getUTCMonth() + 1;  // 1-12
  const todayDay   = istNow.getUTCDate();
  const year       = istNow.getUTCFullYear();

  // Contacts with a birthday or anniversary set. Small table → filter month-day
  // in JS (no date-part index needed; keeps the SQL portable).
  const { data: contacts, error } = await admin
    .from("contacts")
    .select("id, tenant_id, full_name, email, birthday, anniversary")
    .or("birthday.not.is.null,anniversary.not.is.null");
  if (error) {
    return NextResponse.json({ error: `contacts fetch failed: ${error.message}` }, { status: 500 });
  }

  const isToday = (d: string | null): boolean => {
    if (!d) return false;
    const dt = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(dt.getTime())) return false;
    return dt.getUTCMonth() + 1 === todayMonth && dt.getUTCDate() === todayDay;
  };

  // Cache tenant name/email so we don't refetch per contact.
  const tenantCache = new Map<string, { name: string; email: string | null } | null>();
  const getTenant = async (tid: string) => {
    if (tenantCache.has(tid)) return tenantCache.get(tid)!;
    const { data } = await admin.from("tenants").select("name, email").eq("id", tid).maybeSingle();
    const t = data ? { name: data.name, email: data.email } : null;
    tenantCache.set(tid, t);
    return t;
  };

  for (const c of contacts ?? []) {
    const kinds: Kind[] = [];
    if (isToday((c as { birthday?: string | null }).birthday ?? null))    kinds.push("birthday");
    if (isToday((c as { anniversary?: string | null }).anniversary ?? null)) kinds.push("anniversary");
    if (kinds.length === 0) continue;

    for (const kind of kinds) {
      result.matched += 1;

      if (!c.email) { result.skipped_no_email += 1; continue; }

      // ── Idempotency claim: unique (tenant, contact, kind, channel, year) ──
      const { data: claimed, error: claimErr } = await admin
        .from("contact_greeting_log")
        .upsert(
          { tenant_id: c.tenant_id, contact_id: c.id, kind, channel: "email", greeting_year: year, recipient: c.email, status: "sending" },
          { onConflict: "tenant_id,contact_id,kind,channel,greeting_year", ignoreDuplicates: true },
        )
        .select("id")
        .maybeSingle();

      if (claimErr) {
        result.errors.push({ contact_id: c.id, message: claimErr.message });
        continue;
      }
      if (!claimed) { result.already_done += 1; continue; }  // already greeted this year

      const tenant = await getTenant(c.tenant_id);
      const { subject, text } = greetingCopy(kind, c.full_name, tenant?.name ?? "Your team");

      const send = await sendEmail({
        to:      c.email,
        subject,
        text,
        from:    tenant?.email ?? undefined,
        replyTo: tenant?.email ?? undefined,
      });

      if (send.status === "failed") {
        // Release the claim so a later run today can retry.
        await admin.from("contact_greeting_log").delete().eq("id", claimed.id);
        result.failed += 1;
        result.errors.push({ contact_id: c.id, message: send.errorMessage ?? "send failed" });
        continue;
      }

      await admin.from("contact_greeting_log")
        .update({ status: send.status, provider_id: send.providerId, subject, sent_at: new Date().toISOString() })
        .eq("id", claimed.id);

      if (send.status === "sent") result.sent += 1;
      else result.stubbed += 1;
    }
  }

  return NextResponse.json(result);
}
