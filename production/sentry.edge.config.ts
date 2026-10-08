/**
 * Sentry — Edge runtime init (middleware + edge API routes).
 *
 * Only initialises when SENTRY_DSN is set.
 */
import * as Sentry from "@sentry/nextjs";
import { serverSentryTags } from "./src/lib/sentry-env";

const DSN = process.env.SENTRY_DSN;

if (DSN && !Sentry.getClient()) {
  Sentry.init({
    dsn:              DSN,
    // R-333: local / staging / production from NEXT_PUBLIC_APP_ENV; release = BUILD_SHA.
    ...serverSentryTags(),
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  });
}
