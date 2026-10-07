"use client";

/**
 * Runs the browser Sentry init, once, with a DSN fetched at RUNTIME.
 *
 * ─── WHY IT FETCHES, AFTER TWO BUILD-TIME TRAPS ─────────────────────────────
 * Two earlier versions both failed on 23 Aug 2026 with the identical symptom — an event id
 * minted in the browser and no transport behind it:
 *
 *   1. Read `process.env.NEXT_PUBLIC_SENTRY_DSN` in the client module. NEXT_PUBLIC_* is
 *      substituted into the bundle at BUILD time; the DSN is a Cloud Run runtime variable,
 *      so the bundle had nothing.
 *   2. Read `process.env.SENTRY_DSN` in the root layout and pass it as a prop. The layout
 *      IS a Server Component, which sounded like the fix — but the pages under it are
 *      statically prerendered (`○` in the build output), so that read happened at build
 *      time too and `null` was baked into the HTML.
 *
 * Both looked right. The lesson is that "read it on the server" is not the same as "read
 * it while serving", and only a `force-dynamic` route handler is reliably the latter.
 *
 * ─── THE COST, STATED ───────────────────────────────────────────────────────
 * One small uncached request per page load. That is the price of a value that can change
 * without a rebuild, and it buys the thing two rebuilds failed to: monitoring that is
 * actually on. Mounted in the ROOT layout, so a crash in `(public)/` or `(auth)/` reports
 * too — `(app)/layout.tsx` is `"use client"` and could not have read server env at all.
 *
 * Renders nothing. A failed fetch or an absent DSN leaves Sentry uninitialised and the app
 * behaves exactly as it does today — no error, no console noise.
 */
import * as React from "react";
import { initClientSentry } from "@/lib/sentry-client";

export function SentryBoot() {
  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/monitoring/sentry-dsn", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { dsn?: string | null; release?: string | null };
        if (cancelled) return;
        initClientSentry(json.dsn, json.release);
      } catch {
        /* Swallowed deliberately, and this is the one place it is right to. Monitoring
           failing to start must never be the thing that breaks the page it was meant to
           watch — and there is nowhere to report it TO, since the reporter is what did
           not start. The dev test page is how this is checked instead. */
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return null;
}
