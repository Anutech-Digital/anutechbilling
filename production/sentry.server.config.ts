/**
 * Sentry — Node.js server init (route handlers, server components, server actions).
 *
 * Only initialises when SENTRY_DSN is set. Filters out tenant_id and PII
 * from event payloads before sending — see beforeSend below.
 *
 * Loaded by instrumentation.ts `register()` (Next 15 calls it at boot). The
 * getClient() guard makes it a no-op if src/lib/sentry.ts got there first.
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
    // Strip sensitive fields from error context before transmission.
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers["authorization"];
        delete event.request.headers["cookie"];
      }
      return event;
    },
  });
}
