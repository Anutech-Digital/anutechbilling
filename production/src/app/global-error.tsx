"use client";

/**
 * Global error boundary — catches errors in the root layout that ordinary
 * error.tsx boundaries can't reach (e.g., errors in `app/layout.tsx`
 * itself, or in pages that haven't rendered a closer boundary).
 *
 * Per Next.js docs, this file MUST include `<html>` and `<body>` tags
 * because the regular layout doesn't render around it.
 *
 * Side-effects:
 * - Reports the error to Sentry (client-side `Sentry.captureException`).
 * - Renders a minimal apology UI with a Reload button.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Captures both the error and the Next.js error digest (for matching
    // against server-side logs / Sentry events).
    Sentry.captureException(error, {
      tags: { boundary: "global-error" },
      extra: { digest: error.digest },
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          background: "#FAFAF9",
          color: "#1C1917",
          padding: "1rem",
        }}
      >
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <p
            style={{
              fontSize: 12,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#A8A29E",
              marginBottom: 8,
            }}
          >
            Unexpected error
          </p>
          <h1
            style={{
              fontFamily: '"DM Serif Display", Georgia, serif',
              fontSize: 32,
              lineHeight: 1.2,
              margin: "0 0 12px",
            }}
          >
            Something went wrong.
          </h1>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.5,
              color: "#57534E",
              marginBottom: 24,
            }}
          >
            We have logged this error. Try reloading the page — if
            it keeps happening, contact <strong>support@resellersos.in</strong>.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              background: "#C2410C",
              color: "#FFFFFF",
              border: 0,
              borderRadius: 8,
              padding: "10px 20px",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p
              style={{
                marginTop: 24,
                fontSize: 11,
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                color: "#A8A29E",
              }}
            >
              ref: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
