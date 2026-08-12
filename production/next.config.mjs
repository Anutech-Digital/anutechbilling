import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // standalone output produces a self-contained server bundle that Cloud Run
  // can run with a tiny Node image — no node_modules at runtime.
  output: "standalone",
  experimental: {
    typedRoutes: true,
    // Force-enable instrumentation hook. Next 14.0.4+ enables it by default,
    // but in standalone output mode on Cloud Run we observed register() never
    // firing (boot logs proved it). Setting this explicitly makes 14.2.15
    // load instrumentation.ts reliably. Required for Sentry server init.
    instrumentationHook: true,
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "https", hostname: "upload.wikimedia.org" },
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
  async headers() {
    const isDev = process.env.NODE_ENV !== "production";
    return [
      {
        source: "/(.*)",
        headers: [
          ...(isDev ? [] : [{ key: "X-Frame-Options", value: "SAMEORIGIN" }]),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // camera=(self): the attendance kiosk needs the camera for check-in
          // selfies. Empty () would block getUserMedia in EVERY browser
          // regardless of OS/site settings. mic/geolocation stay disabled.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

// Wrap with Sentry only when the DSN+auth-token pair is available (production).
// In local dev without these env vars, `withSentryConfig` becomes a no-op
// wrapper so builds still work without Sentry credentials.
const sentryWebpackPluginOptions = {
  silent: true,                              // suppress source-map upload logs
  org:    process.env.SENTRY_ORG    || "",
  project: process.env.SENTRY_PROJECT || "",
  authToken: process.env.SENTRY_AUTH_TOKEN,  // required only for source-map upload
  // Don't upload source maps if no auth token (dev builds, fork builds).
  disableServerWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  disableClientWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  // Source maps stay private — Sentry needs them but they're not exposed.
  hideSourceMaps: true,
};

export default withSentryConfig(nextConfig, sentryWebpackPluginOptions);
