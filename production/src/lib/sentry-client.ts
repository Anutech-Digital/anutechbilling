"use client";

/**
 * Browser-side Sentry initialiser — the other half of `lib/sentry.ts`.
 *
 * ─── WHY THIS WAS MISSING, AND WHY THAT WAS INVISIBLE ───────────────────────
 * `lib/sentry.ts` is server-only; its own header says so. It reads `SENTRY_DSN`, which
 * Next.js never exposes to the browser, so nothing ever called `Sentry.init()` on the
 * client.
 *
 * Meanwhile `app/global-error.tsx` and `app/(app)/error.tsx` both call
 * `Sentry.captureException` from the client. With no init those calls mint an event ID
 * locally and the transport never runs — the events are dropped in silence. That is
 * EXACTLY the failure CLAUDE.md §22 documents for the server, repeating one level down,
 * and the boundaries' own comments say they "report to Sentry" as though it worked.
 *
 * So every crash a customer or a rep actually sees — a React render error, a bad client
 * component, a null in a chart — has been going nowhere. Found 23 Aug 2026 while wiring
 * the DSN up for the first time.
 *
 * ─── TWO DIFFERENT VARIABLES, DELIBERATELY ──────────────────────────────────
 * `NEXT_PUBLIC_SENTRY_DSN` here, `SENTRY_DSN` there. A DSN is not a secret — it is a
 * write-only ingest endpoint and shipping it to the browser is the intended design — but
 * the NEXT_PUBLIC_ prefix is what makes Next.js inline it at build time. They may hold
 * the same value; the prefix is the whole point.
 *
 * ─── AND IT SENDS LESS THAN THE SERVER ONE ──────────────────────────────────
 * Browser events carry whatever the page had on screen, and this app's pages have
 * customer names, emails and amounts on them. `sendDefaultPii` stays off and the
 * breadcrumb scrub below drops anything that looks like an address, because a monitoring
 * tool is not a place to accumulate a copy of the customer list.
 */
import * as Sentry from "@sentry/nextjs";
import { sentryEnvironment, sentryRelease } from "@/lib/sentry-env";

/**
 * Idempotent, same as the server one: `getClient()` is undefined until an init runs, so a
 * second call is free.
 *
 * ─── THE DSN IS PASSED IN, NOT READ FROM process.env ────────────────────────
 * The first version read `process.env.NEXT_PUBLIC_SENTRY_DSN` here, and the browser test
 * page immediately reported what that costs:
 *
 *     dsnPresent  false
 *     clientReady false
 *     flushed     false
 *     eventId     f489b180579d4c4ca9b01bfb50aa7616   <- minted, and went nowhere
 *
 * `NEXT_PUBLIC_*` is inlined by Next.js at BUILD time. The DSN had been set as a Cloud
 * Run RUNTIME variable, so it was never in the bundle — not in production, and not on
 * localhost either, where `.env.local` has no such line. Exactly the §22 failure with a
 * different cause: an event id created locally and no transport behind it.
 *
 * So the value now arrives as an argument, read by the ROOT layout (a Server Component)
 * from `process.env.SENTRY_DSN` at request time and handed down. That means ONE variable
 * instead of two, no rebuild when it changes, and no way for the build and the runtime to
 * disagree about whether monitoring is on.
 */
/* R-333: `release` is the build SHA. BUILD_SHA is a runtime-only env (deliberately not
   NEXT_PUBLIC_), so the DSN route hands it over alongside the DSN. */
export function initClientSentry(dsn: string | null | undefined, release?: string | null): void {
  const DSN = (dsn ?? "").trim();
  if (!DSN) return;
  if (Sentry.getClient()) return;

  Sentry.init({
    dsn: DSN,
    /* R-333: staging and live were both "production" (NODE_ENV of any build). The literal
       NEXT_PUBLIC_APP_ENV read is inlined at build: "local" / "staging" / "" -> production. */
    environment: sentryEnvironment(process.env.NEXT_PUBLIC_APP_ENV, process.env.NODE_ENV),
    release: sentryRelease(release),
    /* Lower than the server's 0.1. Browser traces are far noisier per user and this is a
       free-tier account; the reason to have this at all is exceptions, not performance. */
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.02 : 1.0,
    /* Off. Sentry's "default PII" means IP address and user agent, and this app has no
       need of either to identify a bug. */
    sendDefaultPii: false,

    beforeSend(event) {
      /* A browser event's request URL is the page the operator was on, and this app puts
         ids in paths — /quotes/Q-ADPL-2026-27-0042. Keep it: it is the single most useful
         field for reproducing, and a quote id is not personal data.

         What does get dropped is anything email-shaped, wherever it appears. A crash on
         the leads screen would otherwise carry the customer's address into a third-party
         service that nobody audits. */
      const scrub = (s: string) => s.replace(/[^\s@"']+@[^\s@"']+\.[^\s@"'.]+/g, "[email]");

      if (event.message) event.message = scrub(event.message);
      for (const ex of event.exception?.values ?? []) {
        if (ex.value) ex.value = scrub(ex.value);
      }
      if (event.breadcrumbs) {
        for (const b of event.breadcrumbs) {
          if (b.message) b.message = scrub(b.message);
        }
      }
      return event;
    },
  });
}
