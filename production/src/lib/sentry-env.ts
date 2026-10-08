/**
 * Sentry `environment` and `release` — one answer for every init (R-333, 7 Oct 2026).
 *
 * Before this, all five inits (root sentry.*.config.ts, lib/sentry.ts, lib/sentry-client.ts)
 * sent `environment: process.env.NODE_ENV`. A Next.js build is always NODE_ENV=production,
 * so staging's errors arrived in Sentry looking exactly like live ones and no alert rule could
 * tell them apart. NEXT_PUBLIC_APP_ENV is the variable that already says which deployment
 * this is (cloudbuild `_APP_ENV` → Dockerfile build arg; the topbar badge reads it):
 *
 *   "local"    → local     (.env.local)
 *   "staging"  → staging   (staging trigger)
 *   ""         → falls back to NODE_ENV → "production" on the live build, which ships "".
 *
 * Release = the commit SHA the image was built from. The Dockerfile already bakes
 * `BUILD_SHA` (cloudbuild passes `--build-arg=BUILD_SHA=$SHORT_SHA`) as a RUNTIME env, and
 * /api/version reads the same one. "dev" (the Dockerfile default) and empty mean "no real
 * build" → no release, so local events do not pile into a fake "dev" release.
 *
 * Pure functions with explicit arguments — NOT a `process.env` object — because the browser
 * bundle only inlines literal `process.env.NEXT_PUBLIC_*` reads; a whole env object passed
 * in from a client file would be empty.
 */

export function sentryEnvironment(
  appEnv: string | null | undefined,
  nodeEnv: string | null | undefined,
): string {
  const app = (appEnv ?? "").trim().toLowerCase();
  if (app) return app;
  const node = (nodeEnv ?? "").trim().toLowerCase();
  return node || "development";
}

export function sentryRelease(sha: string | null | undefined): string | undefined {
  const s = (sha ?? "").trim();
  if (!s || s.toLowerCase() === "dev") return undefined;
  return s;
}

/** Server/edge: both values are real runtime env there. */
export function serverSentryTags(): { environment: string; release: string | undefined } {
  return {
    environment: sentryEnvironment(process.env.NEXT_PUBLIC_APP_ENV, process.env.NODE_ENV),
    release: sentryRelease(process.env.BUILD_SHA ?? process.env.COMMIT_SHA),
  };
}
