/**
 * Sentry — browser client init.
 *
 * Runs once on the client side at app boot. Only initialises when
 * NEXT_PUBLIC_SENTRY_DSN is set — so local dev without the DSN stays
 * silent (no errors flooded to Sentry, no setup friction).
 */
import * as Sentry from "@sentry/nextjs";
import { sentryEnvironment, sentryRelease } from "./src/lib/sentry-env";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (DSN) {
  Sentry.init({
    dsn:                  DSN,
    // R-333: literal NEXT_PUBLIC_* reads so Next inlines them into the bundle. The live
    // browser init is lib/sentry-client.ts (release comes from /api/monitoring/sentry-dsn).
    environment:          sentryEnvironment(process.env.NEXT_PUBLIC_APP_ENV, process.env.NODE_ENV),
    release:              sentryRelease(process.env.NEXT_PUBLIC_BUILD_SHA),
    tracesSampleRate:     process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    replaysSessionSampleRate: 0,    // No session replay (privacy + cost)
    replaysOnErrorSampleRate: 0.1,  // Capture 10% of error sessions only
    ignoreErrors: [
      // Common browser noise we don't care about
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "Non-Error promise rejection captured",
    ],
  });
}
