/**
 * POST /api/demo/session — "Try the demo" (R-524). Opens the READ-ONLY sample workspace for a
 * visitor, no signup. The homepage button is a plain form POST to here (works without JS, and a
 * link prefetch can never mint a session).
 *
 * Order, and why:
 *  1. DEMO_ENABLED=1 or nothing happens (default OFF — owner config).
 *  2. Per-IP rate limit before any database or auth call.
 *  3. A browser that already carries a sign-in (auth cookie, no live demo window) keeps it — we
 *     never swap a real account's session. Decided from the cookies alone: this route stays
 *     anonymous by design (admin-client-ratchet PUBLIC_BY_DESIGN) and never reads a session.
 *  4. The demo workspace must exist (made by the nightly /api/cron/demo-reset).
 *  5. Sign in as the visitor login (one-time token, no password).
 *  6. FAIL CLOSED: the database must say this session is read-only (demo_readonly_probe = 'on').
 *     If not, sign straight out and refuse — a writable demo session is never handed out.
 *  7. ros_demo cookie = the expiry; the middleware signs the visitor out after it.
 *
 * Every refusal goes back to the homepage with ?demo=<reason>, which shows one plain line.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { clientIp, rateLimitShared } from "@/lib/security/rate-limit";
import {
  DEMO_COOKIE, DEMO_SESSION_MINUTES, DEMO_START_LIMIT, DEMO_VISITOR_EMAIL,
  demoCookieLive, demoCookieValue, demoEnabled, demoHomePath, hasAuthCookie, publicOrigin,
} from "@/lib/demo/demo-account";
import { getDemoTenant, readOnlyWallUp, signInAs } from "@/lib/demo/demo-account.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function POST(req: Request) {
  const origin = publicOrigin(req.headers, req.url);
  const home = demoHomePath(req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
  const back = (reason: string) => NextResponse.redirect(`${origin}${home}?demo=${reason}`, 303);

  if (!demoEnabled()) return back("off");

  const verdict = await rateLimitShared(`demo-start:${clientIp(req.headers)}`, DEMO_START_LIMIT);
  if (!verdict.ok) return back("busy");

  const cookieHeader = req.headers.get("cookie");
  if (hasAuthCookie(cookieHeader) && !demoCookieLive(cookieValue(cookieHeader, DEMO_COOKIE), Date.now())) {
    return NextResponse.redirect(`${origin}/dashboard`, 303);
  }
  const supabase = createClient() as unknown as SupabaseClient;

  let admin: SupabaseClient;
  try {
    admin = createAdminClient() as unknown as SupabaseClient;
  } catch {
    return back("unavailable");
  }
  const demo = await getDemoTenant(admin);
  if (!demo) return back("unavailable");

  const signed = await signInAs(admin, supabase, DEMO_VISITOR_EMAIL);
  if (!signed.ok || signed.userId !== demo.visitor_user_id) {
    if (signed.ok) await supabase.auth.signOut({ scope: "local" });
    return back("unavailable");
  }

  if (!(await readOnlyWallUp(supabase))) {
    await supabase.auth.signOut({ scope: "local" });
    console.error("[demo] refused: read-only wall is not up (migration 20261009220000 / PostgREST db_pre_request)");
    return back("unavailable");
  }

  const res = NextResponse.redirect(`${origin}/dashboard`, 303);
  res.cookies.set(DEMO_COOKIE, demoCookieValue(Date.now()), {
    path: "/", sameSite: "lax", secure: origin.startsWith("https://"), maxAge: DEMO_SESSION_MINUTES * 60,
  });
  return res;
}
