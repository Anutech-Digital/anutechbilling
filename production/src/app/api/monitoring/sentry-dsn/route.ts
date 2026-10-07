/**
 * GET /api/monitoring/sentry-dsn — hands the browser its Sentry DSN, at runtime.
 *
 * ─── WHY A ROUTE, AFTER TWO BUILD-TIME TRAPS ────────────────────────────────
 * Getting the DSN into the browser failed twice on 23 Aug 2026, both times because the
 * value was read while BUILDING rather than while SERVING:
 *
 *   1. `process.env.NEXT_PUBLIC_SENTRY_DSN` inside the client module. Next.js substitutes
 *      NEXT_PUBLIC_* into the bundle at build time; the DSN is a Cloud Run runtime
 *      variable, so the bundle got nothing.
 *   2. `process.env.SENTRY_DSN` in the ROOT LAYOUT, passed down as a prop. The layout is a
 *      Server Component, which sounded like the fix — but the pages under it are
 *      statically prerendered (`○` in the build output), so that read ALSO happened at
 *      build time and `null` was baked into the static HTML.
 *
 * Both attempts looked correct and produced the identical symptom: an event id minted in
 * the browser and no transport behind it.
 *
 * A route handler is the one thing here that genuinely runs per request. `force-dynamic`
 * says so explicitly, so no future prerender pass can quietly fold it into the build the
 * way it folded the layout.
 *
 * ─── AND THE DSN IS SAFE TO SERVE UNAUTHENTICATED ───────────────────────────
 * A DSN is a write-only ingest endpoint — Sentry's own design ships it inside browser
 * bundles for every site that uses them. It cannot read anything; the worst somebody can
 * do with it is send junk events into the project's quota. Requiring a session here would
 * mean no error reporting on /login or the public buy pages, which is where a first-time
 * visitor's crash matters most.
 */
import { NextResponse } from "next/server";
import { sentryRelease } from "@/lib/sentry-env";

/* Not negotiable for this route: the entire point is that the value is read while
   serving. Without it a prerender pass would capture the build-time env and reintroduce
   the exact bug this file exists to end. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const dsn = process.env.SENTRY_DSN?.trim() || null;
  /* R-333: the build SHA, so browser events carry the same release as server ones. Read
     here because BUILD_SHA is a runtime env (the Dockerfile keeps it out of the bundle). */
  const release = sentryRelease(process.env.BUILD_SHA ?? process.env.COMMIT_SHA) ?? null;

  return NextResponse.json(
    { dsn, release },
    {
      /* Never cached. A cached null would pin monitoring off for the CDN's whole TTL, and
         the failure would look exactly like a missing variable again. */
      headers: { "cache-control": "no-store, max-age=0" },
    },
  );
}
