/**
 * POST /api/public/ux/events — the UX observer's batches (3 Oct 2026).
 *
 * Public on purpose (website visitors are not signed in); the middleware's public rate
 * limit applies (lib/security/rate-limit.ts#publicApiLimit). Every event is re-checked and
 * re-masked here (lib/ux/signals.ts#sanitizeEvent) — the browser's masking is not trusted.
 * A signed-in user's events carry their tenant; a visitor's do not. No IP is stored.
 * Always answers 204: the observer must never surface an error to the person.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { sanitizeEvent, surfaceFor } from "@/lib/ux/signals";
import { maybeAutoAnalyze } from "@/lib/ux/analyze.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EVENTS = 50;

export async function POST(req: NextRequest) {
  const done = () => new NextResponse(null, { status: 204 });
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") return done();
  let body: { sid?: unknown; events?: unknown };
  try {
    const text = await req.text();
    if (text.length > 64_000) return done();
    body = JSON.parse(text);
  } catch { return done(); }

  const sid = typeof body.sid === "string" && /^[a-z0-9]{8,64}$/i.test(body.sid) ? body.sid : null;
  if (!sid || !Array.isArray(body.events)) return done();

  const events = body.events.slice(0, MAX_EVENTS)
    .map((e) => sanitizeEvent(e as never))
    .filter((e): e is NonNullable<typeof e> => !!e);
  if (events.length === 0) return done();

  let tenantId: string | null = null;
  let userId: string | null = null;
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      userId = user.id;
      const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
      tenantId = me?.tenant_id ?? null;
    }
  } catch { /* a visitor */ }

  try {
    const admin = createAdminClient();
    await admin.from("ux_events" as never).insert(events.map((e) => ({
      tenant_id: tenantId, user_id: userId, session_id: sid, surface: surfaceFor(e.path),
      path: e.path, kind: e.kind, target: e.target, detail: e.detail, ms: e.ms, metrics: e.metrics ?? null,
    })) as never);
    /* The analysis runs on activity, not on a clock: enough new signals since the last
       run, and that run over an hour old (lib/ux/analyze.server.ts). */
    await maybeAutoAnalyze(admin as never, tenantId);
  } catch (err) {
    console.error("[ux/events] insert / analyse failed", (err as Error).message);
  }
  return done();
}
