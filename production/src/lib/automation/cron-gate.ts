/**
 * R-897: the gate every cron route goes through FIRST.
 *
 *   export const GET = gatedCron("invoice-dunning", handle);
 *
 * With a valid CRON_SECRET bearer, before the route does anything:
 *   · OFF everywhere → 200 { skipped: "off" } — nothing is read, nothing is sent — and the
 *     run is stamped on the platform company's row ("Skipped — turned off").
 *   · ON for some companies → the route runs once, LIVE, and may only work on those
 *     companies (cronTenantAllowed). Customer messages for any other company are refused at
 *     sendCustomerMessage() as a second wall.
 *   · in practice run (dry_run) for some companies → the route runs once more in DRY mode for
 *     those companies only: its own `?dry=1` is set, and sendCustomerMessage() sends nothing
 *     and counts "would send N to X" instead. A job with no safe practice mode does nothing.
 *   · the switches cannot be read → 503, nothing runs (fail closed).
 * Every run stamps last_run_at / last_result on the companies it covered.
 *
 * Without a valid bearer the gate answers itself and the route is NOT called (R-1552,
 * 18 Oct 2026): CRON_SECRET unset → 503 (fail closed), missing/wrong bearer → 401. Until then
 * the gate handed such a request to the route OUTSIDE any run context, where
 * cronTenantAllowed() says yes to every company — so a route that also accepted a signed-in
 * owner (the four provisioning crons) ran for ALL companies, automation switches ignored.
 * The one exception is a route that declares `withoutBearer` (health-digest's owner preview):
 * it is called inside a run context that allows NO company, so it must scope itself to the
 * caller's own tenant, and any customer message from it is refused (sendCustomerMessage).
 * The gate never tells an anonymous caller anything, and never records a run for one.
 * "platform" jobs (backup, demo reset, error digest) follow the platform company's switch.
 */
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { AUTOMATION_JOBS, isDefaultOn, platformTenantId, stateOf, type AutomationJob } from "./jobs";
import { cronTenants, ensureDefaultOnRow, readJobRow, recordRun } from "./gate.server";

export interface CronRunContext {
  job: AutomationJob;
  mode: "live" | "dry";
  /** Companies this pass may work on. */
  tenants: ReadonlySet<string>;
  /** Platform job: the pass covers every company (the switch is the platform's). */
  allTenants: boolean;
  /** Filled by sendCustomerMessage() in a dry pass. */
  wouldSend: { tenantId: string; to: string; channel: "email" | "whatsapp"; kind: string | null }[];
}

const als = new AsyncLocalStorage<CronRunContext>();

/** The pass this code is running in, or null outside a cron. */
export function currentCronRun(): CronRunContext | null {
  return als.getStore() ?? null;
}

/** Inside a cron pass: may this company be worked on? Outside a cron: always true. */
export function cronTenantAllowed(tenantId: string | null | undefined): boolean {
  const ctx = als.getStore();
  if (!ctx) return true;
  if (ctx.allTenants) return true;
  return Boolean(tenantId) && ctx.tenants.has(tenantId as string);
}

/** Inside a cron pass: is this a practice run? */
export function isCronDryRun(): boolean {
  return als.getStore()?.mode === "dry";
}

type Handler<R extends Request> = (req: R) => Promise<Response>;

function bearerOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return timingSafeEqualStr(provided, expected);
}

/** Same request with the route's own dry-run flags set. */
function asDry<R extends Request>(req: R): R {
  const url = new URL(req.url);
  url.searchParams.set("dry", "1");
  url.searchParams.set("dryRun", "1");
  url.searchParams.delete("on");
  /* A NextRequest, so routes typed (req: NextRequest) get one; it is also a Request. */
  return new NextRequest(url.toString(), { method: req.method, headers: req.headers }) as unknown as R;
}

const NUMBER_KEYS = /^(sent|emails_sent|considered|processed|skipped|failed|created|raised|invoices|greeted|reminded|expired|tenants|customers|calls|retried|closed|synced|imported|deleted|ok|errors?)$/i;

/** A short line for last_result from the route's JSON body. Never copies strings out of it. */
export function summarise(status: number, body: unknown, mode: "live" | "dry", wouldSend: CronRunContext["wouldSend"]): string {
  const parts: string[] = [];
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (!NUMBER_KEYS.test(k)) continue;
      if (typeof v === "number") parts.push(`${k} ${v}`);
      else if (Array.isArray(v)) parts.push(`${k} ${v.length}`);
    }
  }
  const head = status >= 400 ? `Failed (${status})` : mode === "dry" ? "Practice run" : "Ran";
  let line = parts.length ? `${head}: ${parts.join(", ")}` : head;
  if (mode === "dry") {
    const n = wouldSend.length;
    line += ` — would send ${n} message${n === 1 ? "" : "s"}`;
    if (n) line += ` to ${wouldSend.slice(0, 3).map((w) => w.to).join(", ")}${n > 3 ? ` and ${n - 3} more` : ""}`;
    line += "; nothing was sent";
  }
  return line.slice(0, 500);
}

async function runPass<R extends Request>(job: AutomationJob, mode: "live" | "dry", tenants: string[], allTenants: boolean, req: R, handler: Handler<R>): Promise<Response> {
  const ctx: CronRunContext = { job, mode, tenants: new Set(tenants), allTenants, wouldSend: [] };
  let res: Response;
  try {
    res = await als.run(ctx, () => handler(mode === "dry" ? asDry(req) : req));
  } catch (e) {
    await recordRun(job, tenants, `Failed: ${(e as Error).message ?? "error"}`.slice(0, 200));
    throw e;
  }
  let body: unknown = null;
  try { body = await res.clone().json(); } catch { /* not JSON */ }
  if (mode === "dry") console.info(`[cron/${job}] practice run — would send ${ctx.wouldSend.length} message(s)`);
  await recordRun(job, tenants, summarise(res.status, body, mode, ctx.wouldSend));
  return res;
}

export interface GatedCronOptions<R extends Request> {
  /**
   * Called (instead of a 401/503) for a request WITHOUT a valid cron bearer. Runs inside a
   * pass that allows no company — cronTenantAllowed() is false for every tenant — so it must
   * do its own auth and work only on the caller's own tenant. Keep it read-only.
   */
  withoutBearer?: Handler<R>;
}

/** R-1552: what the gate answers when the cron bearer is missing or wrong. */
function refuseWithoutBearer(): Response {
  if (!process.env.CRON_SECRET?.trim()) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export function gatedCron<R extends Request>(job: AutomationJob, handler: Handler<R>, opts: GatedCronOptions<R> = {}): Handler<R> {
  return async function gated(req: R): Promise<Response> {
    /* R-1552: no valid secret → the route is never reached (fail closed). */
    if (!bearerOk(req)) {
      const own = opts.withoutBearer;
      if (!own) return refuseWithoutBearer();
      const none: CronRunContext = { job, mode: "live", tenants: new Set(), allTenants: false, wouldSend: [] };
      return als.run(none, () => own(req));
    }

    const spec = AUTOMATION_JOBS[job];

    /* Safety jobs (backup) are ON unless the platform company's row says otherwise, and a
       failed read RUNS them: for a backup, "could not check the switch" must not mean "no
       backup tonight". The kill switch is for customer-facing automation, not backups. */
    if (isDefaultOn(job)) {
      const p = platformTenantId();
      const row = await readJobRow(p, job);
      const state = row === undefined ? "on" : stateOf(row, job);
      if (state === "off") {
        await recordRun(job, [p], "Skipped — turned off");
        return NextResponse.json({ ok: true, skipped: "off", job });
      }
      if (row === null) await ensureDefaultOnRow(p, job);
      return runPass(job, "live", [p], true, req, handler);
    }

    const where = await cronTenants(job);
    if (!where) {
      return NextResponse.json({ ok: false, skipped: "gate_unreadable", job }, { status: 503 });
    }

    let on = where.on;
    let dry = where.dry;
    if (spec.scope === "platform") {
      const p = platformTenantId();
      on = on.includes(p) ? [p] : [];
      dry = on.length === 0 && dry.includes(p) ? [p] : [];
    }

    if (on.length === 0 && dry.length === 0) {
      await recordRun(job, [platformTenantId()], "Skipped — turned off");
      return NextResponse.json({ ok: true, skipped: "off", job });
    }

    let live: Response | null = null;
    if (on.length > 0) live = await runPass(job, "live", on, spec.scope === "platform", req, handler);

    let practice: Response | null = null;
    if (dry.length > 0) {
      if (spec.dryRun) {
        practice = await runPass(job, "dry", dry, spec.scope === "platform", req, handler);
      } else {
        await recordRun(job, dry, "Practice run is not available for this job — nothing was done");
      }
    }
    return live ?? practice ?? NextResponse.json({ ok: true, skipped: "dry_run_unavailable", job });
  };
}

/** A practice run records what it WOULD have sent (shown as "would send N to X" under Last run). */
export function noteWouldSend(entry: CronRunContext["wouldSend"][number]): void {
  als.getStore()?.wouldSend.push(entry);
}
