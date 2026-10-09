/**
 * POST /api/demo/end — leave the demo (R-524). Signs the visitor login out, drops the ros_demo
 * cookie and goes to "/" or, from the banner's "Sign up" button, to /signup. The only write a
 * demo visitor's request may make (see demoRequestVerdict).
 *
 * A real (non-demo) account that posts here is left signed in — this route only ever ends a
 * demo session.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { DEMO_COOKIE, demoExitTarget, demoHomePath, isDemoVisitor, publicOrigin } from "@/lib/demo/demo-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const origin = publicOrigin(req.headers, req.url);
  const exit = demoExitTarget(new URL(req.url).searchParams.get("next"));
  const target = exit === "/signup" ? exit : demoHomePath(req.headers.get("x-forwarded-host") ?? req.headers.get("host"));

  const supabase = createClient() as unknown as SupabaseClient;
  const { data: { user } } = await supabase.auth.getUser();
  if (user && isDemoVisitor(user)) await supabase.auth.signOut({ scope: "local" });

  const res = NextResponse.redirect(`${origin}${target}`, 303);
  res.cookies.set(DEMO_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
