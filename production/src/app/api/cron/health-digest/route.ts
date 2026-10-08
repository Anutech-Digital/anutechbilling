/**
 * GET|POST /api/cron/health-digest — production ke logs padho, kuch bigda ho to email karo.
 *
 * R-220 (6 Oct 2026): ab ye OWNER KA MORNING DIGEST bhi hai — kal aaya paisa, overdue, aapki haan
 *   (held AI actions + approval wale quotes), 30-din renewal risk (lib/digest/owner-digest.ts). Isliye
 *   mail ROZ jaata hai, sirf ek owner ko; logs ka hissa usi mail ke neeche. Logs na padh paye
 *   to bhi number jaate hain, galti ke saath. Schedule 08:00 IST chahiye — Cloud Scheduler
 *   badalna manager ka kaam (card R-220 par likha).
 *
 * Schedule (purana): roz 08:30 IST, Cloud Scheduler job `resellersos-health-digest` (GET — baaki 11
 *   cron bhi GET hain, aur khaali body wala POST Google ke front-end se 411 kha jata hai).
 *   `?hours=` se khidki badal sakti hai, 1 se 168 tak.
 * Haath se: `curl -H "Authorization: Bearer <CRON_SECRET>" .../api/cron/health-digest`
 *
 * R-112 DRY RUN: `?dryRun=1` — owner ke 4 number aur mail ka subject/text/html LAUTATA hai,
 *   bhejta KUCH nahi (na email, na logs padhna, na heartbeat). `&format=html` = seedha mail
 *   jaisa page. Kaun dekh sakta hai: CRON_SECRET wala (pehla owner, jaise cron) YA app me
 *   login owner (apne tenant ke number). Baaki sab 401/403. Preview me sirf business ka
 *   hissa hai; asli mail me neeche logs wala hissa bhi judta hai.
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * 28 Aug 2026 ko production ke logs pehli baar khule aur ek ghante me teen bug nikle jo
 * hafton se chal rahe the — ek kho gaya customer reply, 7 vendor invoice, aur har request
 * ke saath log me jaata hua secret. Teeno isliye mile ki us din kisi ne jaakar dekha.
 *
 * `npm run health:prod` usi din bana, par use bhi koi chalata hai tab hi chalta hai. Ye wahi
 * chaar sawaal roz poochhta hai, bina kisi ke.
 *
 * ─── CHUP RAHNA DEFAULT THA (R-220 se badla) ────────────────────────────────
 * R-220 ke baad mail roz jaata hai kyunki usme owner ke kaam ke 4 number hain; logs wala
 * hissa sab theek ho to ek line ("No server errors"). Purana tark neeche, itihaas ke liye:
 * Sab theek ho to ye kuch NAHI bhejta. Ek roz aane wali "sab theek hai" email do hafte me
 * padhi jaani band ho jaati hai, aur phir wo din bhi nahi padhi jaati jab usme kuch hota
 * hai. Isliye email sirf tab jab kuch kehne layak ho — aur response hamesha poora digest
 * lautata hai, taaki haath se chalane par sab dikhe.
 *
 * ─── IAM: KUCH NAHI CHAHIYE, AUR YE NAAPA HUA HAI ───────────────────────────
 * Likhte waqt maine maan liya tha ki runtime service account ko `roles/logging.viewer`
 * dena padega — uske paas project-level roles me wo nahi hai (artifactregistry.writer,
 * cloudbuild.builds.builder, iam.serviceAccountUser, run.admin). Us aadhaar par ye route
 * 403 par ek grant command lautata tha aur commit me bhi wahi likha gaya tha.
 *
 * 28 Aug 2026 ko live par thok kar dekha: **200, poora digest, koi 403 nahi.** Padhne ki
 * pahunch un maujooda role me se hi aa rahi hai. Command ki zaroorat nahi thi.
 *
 * 403 wala raasta phir bhi rakha gaya hai — role kabhi hataya ja sakta hai, aur us din ye
 * saaf batayega ki kya karna hai. Wo jaanch chalti rahni chahiye kyunki "kuch nahi mila"
 * aur "padh hi nahi paya" ek jaise dikhne se hi aaj ke teen bug hafton chhupe rahe the.
 *
 * Koi nayi dependency nahi: token metadata server se, logs REST se (CLAUDE.md §17).
 */
import { reportCron } from "@/lib/ops/cron-report";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { sendEmail } from "@/lib/email/send";
import { buildDigest, digestText, type Digest, type LogRow } from "@/lib/ops/health-digest";
import { errorMessage } from "@/lib/ops/fetch-all";
import { buildOwnerDigest, ownerDigestSubject, ownerDigestText, type OwnerDigest } from "@/lib/digest/owner-digest";
import { loadOwnerDigestFacts, type DigestDb } from "@/lib/digest/owner-digest-facts";
import { buildDigestEmail } from "@/lib/digest/owner-digest-html";
import { getCurrentUser } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROJECT = "resellsubsos-prod";
const SERVICE = "resellersos";
const LOG_SA = "1005662057478-compute@developer.gserviceaccount.com";
const GRANT_CMD =
  `gcloud projects add-iam-policy-binding ${PROJECT} ` +
  `--member="serviceAccount:${LOG_SA}" --role="roles/logging.viewer" --condition=None`;

/** Cloud Run ke metadata server se token — koi key file, koi env var nahi. */
async function metadataToken(): Promise<string | null> {
  try {
    const r = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) return null;
    return ((await r.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    /* Local dev me metadata server hota hi nahi — wahan ye route chalega hi nahi, aur
       chalna bhi nahi chahiye. */
    return null;
  }
}

interface Entry {
  timestamp?: string;
  textPayload?: string;
  httpRequest?: { status?: number; requestUrl?: string };
}

async function readLogs(token: string, filter: string, limit: number): Promise<Entry[] | "denied"> {
  const r = await fetch("https://logging.googleapis.com/v2/entries:list", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT}`],
      filter,
      orderBy: "timestamp desc",
      pageSize: limit,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status === 403) return "denied";
  if (!r.ok) throw new Error(`logging ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { entries?: Entry[] }).entries ?? [];
}

const toRows = (e: Entry[]): LogRow[] => e.map((x) => ({
  timestamp: x.timestamp ?? "",
  status: x.httpRequest?.status ?? null,
  url: x.httpRequest?.requestUrl ?? null,
  text: x.textPayload ?? null,
}));

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request) {
  const params = new URL(req.url).searchParams;
  const dryRun = ["1", "true"].includes(params.get("dryRun") ?? "");
  const asHtml = params.get("format") === "html";

  /* Fail closed, baaki cron ki tarah: ye route production ke logs padhta hai. */
  const expected = process.env.CRON_SECRET?.trim();
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const cronOk = !!expected && !!provided && timingSafeEqualStr(provided, expected);

  /* R-112: preview bina secret ke sirf login OWNER ko — apne tenant ke number, apna pata. */
  if (dryRun && !cronOk) {
    const me = await getCurrentUser().catch(() => null);
    if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (me.user.role !== "owner") return NextResponse.json({ error: "owner only" }, { status: 403 });
    return preview(me.user.tenant_id, me.email, asHtml);
  }

  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!cronOk) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (dryRun) {
    const first = await firstOwner();
    if (!first.tenantId) {
      return NextResponse.json({ ok: false, dryRun: true, emailed: false, error: "no owner tenant" }, { status: 404 });
    }
    return preview(first.tenantId, first.to, asHtml);
  }

  const hours = Math.min(168, Math.max(1, Number(new URL(req.url).searchParams.get("hours")) || 24));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const base =
    `resource.type="cloud_run_revision" AND resource.labels.service_name="${SERVICE}" ` +
    `AND timestamp>="${since}"`;

  const logs = await readHealth(base, hours);

  /* Kise bhejein: platform ka pehla owner (Pardeep) — sirf ek pata, aur usi ke tenant ke
     number. Ye ops + owner ka mail hai, kisi customer ka nahi (R-220: pehle sirf Pardeep). */
  const admin = createAdminClient();
  const { to, tenantId } = await firstOwner();

  /* R-220: owner ke 4 number. Padhne me galti ho to mail phir bhi jaata hai, galti ke saath —
     "kuch nahi aaya" aur "padh hi nahi paye" ek jaise nahi dikhne chahiye. */
  let owner_digest: OwnerDigest | null = null;
  let businessError: string | null = null;
  if (tenantId) {
    try {
      owner_digest = buildOwnerDigest(await loadOwnerDigestFacts(admin as unknown as DigestDb, tenantId, new Date()));
    } catch (e) {
      businessError = errorMessage(e);
    }
  } else {
    businessError = "no owner tenant";
  }

  if (!to) {
    return NextResponse.json({ ok: true, emailed: false, reason: "no owner email", owner_digest, businessError, logs: logs.digest ?? logs.error });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const parts: string[] = [];
  if (owner_digest) parts.push(ownerDigestText(owner_digest, appUrl));
  else parts.push(`The business numbers could not be read today: ${businessError}`);
  parts.push("", "─── App health (production logs) ───");
  if (logs.error) parts.push(`Logs were not read: ${logs.error}${logs.fix ? `\nFix: ${logs.fix}` : ""}`);
  else if (logs.digest && !logs.digest.clean) parts.push(digestText(logs.digest, appUrl));
  else parts.push(`No server errors in the last ${hours}h.`);

  const worst = logs.digest ? (logs.digest.serverErrors[0] ?? logs.digest.refused[0] ?? logs.digest.appErrors[0]) : undefined;
  const subject = owner_digest
    ? ownerDigestSubject(owner_digest) + (worst ? " · app needs a look" : "")
    : `ResellerOS — ${worst ? worst.what.slice(0, 60) : "morning digest (numbers missing)"}`;

  const sent = await sendEmail({ to, subject, text: parts.join("\n") });

  return NextResponse.json(reportCron("health-digest", {
    ok: true, clean: logs.digest?.clean ?? false, emailed: sent.status === "sent", to,
    owner_digest, digest: logs.digest ?? null,
    logsError: logs.error ?? null,
    businessError,
    failed: (sent.status === "sent" ? 0 : 1) + (logs.error ? 1 : 0) + (businessError ? 1 : 0),
    emailError: sent.errorMessage,
  }));
}

/** Platform ka pehla owner (Pardeep) — cron ka ek hi pata aur tenant. */
async function firstOwner(): Promise<{ to: string | null; tenantId: string | null }> {
  const { data: owner } = await createAdminClient()
    .from("users").select("email, tenant_id").eq("role", "owner")
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  return {
    to: (owner as { email?: string } | null)?.email ?? null,
    tenantId: (owner as { tenant_id?: string } | null)?.tenant_id ?? null,
  };
}

/**
 * R-112 dry run: wahi 4 number aur mail ka body jo 8 baje jaata — par sendEmail, logs aur
 * heartbeat KUCH nahi chhoota. Sirf padhna (ek tenant, service-role, tenant_id filter).
 */
async function preview(tenantId: string, to: string | null, asHtml: boolean) {
  let owner_digest: OwnerDigest;
  try {
    owner_digest = buildOwnerDigest(
      await loadOwnerDigestFacts(createAdminClient() as unknown as DigestDb, tenantId, new Date()),
    );
  } catch (e) {
    return NextResponse.json({ ok: false, dryRun: true, emailed: false, businessError: errorMessage(e) }, { status: 500 });
  }
  const email = buildDigestEmail(owner_digest, process.env.NEXT_PUBLIC_APP_URL ?? "");
  if (asHtml) {
    return new NextResponse(email.html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return NextResponse.json(
    { ok: true, dryRun: true, emailed: false, to, owner_digest, email },
    { headers: { "cache-control": "no-store" } },
  );
}

/** Production ke logs — kabhi throw nahi karta; na padh paye to `error` (aur 403 par `fix`). */
async function readHealth(base: string, hours: number): Promise<{ digest?: Digest; error?: string; fix?: string }> {
  const token = await metadataToken();
  if (!token) return { error: "no metadata token — logs are only readable on Cloud Run" };

  let http: Entry[] | "denied";
  let stderr: Entry[] | "denied";
  try {
    [http, stderr] = await Promise.all([
      readLogs(token, `${base} AND (httpRequest.status>=500 OR httpRequest.status=401)`, 400),
      readLogs(token, `${base} AND logName:"stderr"`, 400),
    ]);
  } catch (e) {
    return { error: (e as Error).message };
  }

  if (http === "denied" || stderr === "denied") {
    /* §24: kya hua, kyun, ab kya karein — aur wo "ab kya" ek command hai jo paste ho sake. */
    return { error: "Cloud Logging refused this service account, so nothing could be read.", fix: GRANT_CMD };
  }
  return { digest: buildDigest(hours, { http: toRows(http), stderr: toRows(stderr) }) };
}
