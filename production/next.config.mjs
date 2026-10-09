import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // standalone output produces a self-contained server bundle that Cloud Run
  // can run with a tiny Node image — no node_modules at runtime.
  output: "standalone",
  /**
   * `next dev` aur `next build` DONO `.next` likhte hain, to gate chalane ke liye kiya
   * gaya ek build chalte dev server ka bundle mita deta hai — page apne hi chunk par 404
   * deta hai aur "toota hua" dikhta hai, jabki kuch toota nahi.
   *
   * 28 Aug 2026 ko iski keemat saaf dikhi: build karne ke liye Pardeep ka chalta dev
   * server band karna pada, aur baad me wapas chalu karna pada.
   *
   * Isliye distDir env se badla ja sakta hai. Docker aur Cloud Build ise SET NAHI karte,
   * to prod ke liye kuch nahi badla — ye sirf local gate ke liye ek alag folder hai
   * (`npm run build:check`).
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /**
   * Client bundle me `fs` ek khaali module ban jata hai, build fail nahi hota.
   *
   * Wajah ek asli build failure hai: `lib/pdf/fonts.ts` server par font ki file
   * `existsSync` se jaanchta hai, aur wahi module client tak pahunchta hai — kyunki
   * `accounting/payroll/screens.tsx` ek client component hai aur `lib/pdf/index.tsx`
   * ke zariye `PayslipPDF` tak jata hai. Webpack ne kaha:
   *
   *     Module not found: Can't resolve 'fs'
   *
   * `fs` ka istemaal us function ke andar `typeof window !== "undefined"` ke peeche hai,
   * to browser me wo line kabhi chalti hi nahi — sirf webpack ko module HAL karna padta hai.
   * Yahi Next ka apna suggested hal hai (`resolve.fallback`), aur sirf client build par
   * lagta hai; server build me asli `fs` waisa hi rehta hai.
   *
   * ⚠️ Iska matlab ye NAHI hai ki client code me `fs` use kiya ja sakta hai. Client par
   * module khaali hai — koi bhi call `undefined is not a function` degi, build ke waqt
   * nahi, chalte app me. Server-only kaam ko `typeof window` ke peeche rakhna hi padega.
   */
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    }
    return config;
  },
  /* Next 15.5: typedRoutes is stable and lives at the top level (was experimental.typedRoutes).
     experimental.instrumentationHook is gone — instrumentation.ts is always loaded in Next 15,
     and the flag only produced a "not needed anymore" warning. The Sentry side-effect import in
     lib/supabase/server.ts stays as the belt-and-braces init path. */
  typedRoutes: true,
  /* 2 Oct 2026 go-live: `next build`'s own "Linting and checking validity of types" ran past
     the 30-minute Cloud Build limit, and lint is the part with a separate home — CI runs
     `next lint` on every push (.github/workflows/ci.yml) and the local gate runs it too.
     Type checking stays ON here: it is what catches typedRoutes, which plain tsc does not. */
  eslint: { ignoreDuringBuilds: true },
  /* R-182, 6 Oct 2026: the type check above took 3.9 of the 9.8 minutes of `next build` in
     Cloud Build (build 8f49a985). The image build now sets SKIP_BUILD_TYPECHECK=1 and the
     cloudbuild.yaml gate runs `next typegen` + `tsc --noEmit` instead — typegen writes the
     .next/types route files, so tsc catches typedRoutes there too. The gate runs beside the
     image build and `push` waits for it, so a type error still stops the deploy. A plain
     `npm run build` (local, CI) leaves the variable unset and checks types as before. */
  typescript: { ignoreBuildErrors: process.env.SKIP_BUILD_TYPECHECK === "1" },
  /* 5 Oct 2026: two Cloud Build runs died with SIGKILL inside `next build` on the 8 GB
     E2_HIGHCPU_8 machine (once in the morning, once after R-161 added `prisma generate`).
     The main process may take 6 GB (NODE_HEAP_MB) and Next starts cpus-1 = 7 worker
     processes beside it for page generation, each with its own heap — together past 8 GB.
     A bigger machine was measured on 29 Aug (cloudbuild.yaml): ~11% faster, 4x the price.
     So: fewer workers and webpack's own memory savings instead; same machine, same cost. */
  experimental: {
    cpus: 3,
    webpackMemoryOptimizations: true,
  },
  images: {
    /* Deep study 27 Sep 2026: next 14.2.35 carries an unauthenticated RCE advisory in the
       Image Optimization API (AVIF path). Until the Next 15/16 upgrade lands, serve images
       as-is — the app has 4 next/image call sites, nothing that needs on-the-fly resizing. */
    unoptimized: true,
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "https", hostname: "upload.wikimedia.org" },
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "*.supabase.co" },
      // Self-hosted data plane (Storage serves images from here). Same host the
      // CSP connect-src is derived from below — keep both in step.
      ...(() => {
        try {
          const u = new URL((process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, ""));
          /* Scheme from the URL, same reason as the CSP below: on a local stack this
             host is http://127.0.0.1:54321, and a hardcoded https here makes
             next/image refuse every logo and avatar Storage serves. */
          const protocol = u.protocol === "http:" ? "http" : "https";
          return u.host && !u.host.endsWith(".supabase.co")
            ? [{ protocol, hostname: u.hostname, port: u.port || undefined }]
            : [];
        } catch {
          return [];
        }
      })(),
    ],
  },
  async headers() {
    const isDev = process.env.NODE_ENV !== "production";
    /* CSP connect-src must name the Supabase host the browser actually talks to.
       Derive it from NEXT_PUBLIC_SUPABASE_URL (baked at build) so it can never drift
       from the client again — the way it did when the data plane moved to
       api.anutech.in but this list still only allowed *.supabase.co, and every
       client-side query silently died on a CSP error ("No workspace"/"Not signed
       in"). Keep *.supabase.co too so a rollback to hosted Supabase still works. */
    const supaUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
    let supaConnect = "https://*.supabase.co wss://*.supabase.co";
    /* img-src allows any https: image. The LOCAL stack serves storage (logos) over
       http://127.0.0.1:54321, which that blocks — the logo uploaded fine and showed as a
       broken image (2 Oct 2026). Added only when Supabase itself is on http. */
    let supaImg = "";
    try {
      if (supaUrl) {
        const u = new URL(supaUrl);
        /* Take the SCHEME from the URL, do not assume https. This line used to read
           `https://${h}`, and that is exactly the drift the comment above swears it
           prevents — just in the other direction. The local stack serves
           http://127.0.0.1:54321, so a hardcoded https:// emitted a connect-src that
           could never match it, the browser blocked every client-side Supabase call,
           and LOGIN FAILED SILENTLY: the form posts, nothing comes back, no error on
           screen. Measured 8 Sep 2026 on a fresh local setup.
           For a hosted https URL the output is byte-identical to before. */
        const isHttp = u.protocol === "http:";
        const scheme = isHttp ? "http" : "https";
        const wsScheme = isHttp ? "ws" : "wss";
        supaConnect = `${scheme}://${u.host} ${wsScheme}://${u.host} ${supaConnect}`;
        if (isHttp) supaImg = ` http://${u.host}`;
      }
    } catch {
      /* malformed env → fall back to the wildcard above */
    }
    return [
      {
        source: "/(.*)",
        headers: [
          ...(isDev ? [] : [{ key: "X-Frame-Options", value: "SAMEORIGIN" }]),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          /* ── CSP — pehli baar (audit C1, 1 Sep 2026) ─────────────────────────
             Jaan-boojh kar UDAAR script/style ('unsafe-inline'/'unsafe-eval' —
             Next ka runtime bina nonce-pipeline ke inhi par chalta hai) aur KASA
             wahan jahan asli hamla rukta hai: object-src 'none' (SVG/Flash-shailee
             embeds), base-uri (link-hijack), form-action (credential-exfil apne
             origin ke bahar form-post se), frame-src sirf Razorpay. connect-src me
             Supabase (REST+realtime), Razorpay, Sentry-ingest. Naya third-party
             jodo to yahan bhi jodna hoga — CSP-error console me saaf naam ke
             saath aata hai. Prod-only (isDev guard nahi: dev me bhi wahi niyam,
             taki todne wala badlav deploy se pehle dikhe). */
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              /* Google Ads conversion tag (R-139, 4 Oct 2026): loaded only after a landing-page form is
                 sent, and only when GOOGLE_ADS_SEND_TO is set (site/lib/google-ads.ts). */
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com https://challenges.cloudflare.com https://www.googletagmanager.com https://www.googleadservices.com",
              /* worker-src (R-525, 9 Oct 2026): without it the browser falls back to script-src,
                 which has no blob:, so the PDF renderer's blob: worker was refused and quote
                 "Download PDF" spun forever in the production build. blob: goes on WORKERS only —
                 never on script-src. Pinned by src/csp-worker-src.test.ts. */
              "worker-src 'self' blob:",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              `img-src 'self' data: blob: https:${supaImg}`,
              "font-src 'self' data: https://fonts.gstatic.com",
              /* data: (R-365, 7 Oct 2026): @react-pdf's layout engine, yoga-layout 3, inlines its
                 wasm and loads it with fetch("data:application/octet-stream;base64,AGFzbQ…").
                 Refused, yoga decoded the bytes itself and the PDF still came out, but every
                 Download PDF logged a CSP violation and AI Help showed "API FAILED". A data:
                 URL never leaves the browser, so this opens no way to send data out. script-src
                 is untouched (wasm compiles under its existing 'unsafe-eval'). */
              `connect-src 'self' data: ${supaConnect} https://api.razorpay.com https://lumberjack.razorpay.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://www.googletagmanager.com https://www.googleadservices.com https://www.google.com https://googleads.g.doubleclick.net`,
              "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com https://challenges.cloudflare.com https://td.doubleclick.net https://www.googletagmanager.com",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
            ].join("; "),
          },
          // camera=(self): the attendance kiosk needs the camera for check-in
          // selfies. Empty () would block getUserMedia in EVERY browser
          // regardless of OS/site settings. geolocation stays disabled.
          //
          // ── microphone: () → (self), 26 Aug 2026 ──────────────────────────
          // The leads drawer now dictates call notes (lib/voice/use-dictation.ts), and
          // `microphone=()` blocked it at the DOCUMENT level — above Chrome's own
          // permission. That produced the worst possible symptom: Chrome's site panel
          // said "Microphones — Allowed" with a live input meter, while
          // `navigator.permissions.query` returned `denied` and no prompt ever appeared.
          // Pardeep spent an hour in Chrome settings and across 11 profiles chasing a
          // block that was in this file.
          //
          // The comment above already warned that `()` blocks getUserMedia "regardless of
          // OS/site settings" — it was written for camera and was right about mic too.
          // Nothing read it, because nothing needed the mic until today.
          //
          // `(self)` — same-origin only, so an embedded third-party frame still cannot
          // reach the mic. That is the point of the header, and it is kept.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
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
