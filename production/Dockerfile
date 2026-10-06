# Multi-stage Dockerfile for Next.js 14 (App Router) on Cloud Run.
#
# Outputs a ~150 MB final image using Next.js `output: "standalone"` mode,
# which bundles only the runtime files the production server needs (no
# node_modules, no source maps, no dev deps).
#
# Stages:
#   1. deps     — install npm packages (cached by package-lock.json)
#   2. builder  — run `next build`, produces .next/standalone
#   3. runner   — minimal node:alpine image running server.js
#
# Build args (set via cloudbuild.yaml or `docker build --build-arg`):
#   NEXT_PUBLIC_APP_URL — public base URL, baked into client bundle.
#
# Runtime env (set via `gcloud run deploy --set-secrets`):
#   SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, RESEND_API_KEY, RESEND_FROM_DEFAULT

# syntax=docker/dockerfile:1.7

# ── Stage 1: install dependencies ───────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Alpine doesn't ship libc — Next.js needs this for some binaries
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ── Stage 2: build the Next.js app ──────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Public env vars — designed to be exposed in the client bundle.
# Supabase URL and anon key are PUBLIC by design (RLS protects the data).
#
# ARG, not ENV — changed 17 Sep 2026. These were hardcoded, which meant the image
# could only ever be built to talk to PRODUCTION: a test or preview deployment had no
# way to point at a different data plane, because NEXT_PUBLIC_* values are compiled
# into the browser bundle and cannot be changed by a runtime env var afterwards.
# Found while standing up a development stack on its own VM.
#
# The defaults are unchanged, so a plain `docker build` still produces exactly the
# production image it did before. A test build overrides them:
#   --build-arg NEXT_PUBLIC_SUPABASE_URL=https://test-api.anutech.in #   --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<that stack's anon key>
ARG NEXT_PUBLIC_SUPABASE_URL="https://api.anutech.in"
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9udHBucWpveXNqZ3Jsc3VrZWNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjc1NjcsImV4cCI6MjA5NDg0MzU2N30.tulYYDQSzq7IpEQCFbP7qjsSUxg4c-0ku5uO80-TKXI"
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

# App URL — must be a valid URL (Next.js metadataBase calls `new URL(...)` at build).
# NOTE: this is baked into the bundle at build time. It defaults to the live
# Cloud Run URL so email/notification links actually resolve. `resellersos.app`
# was NOT live and produced dead links. Override via --build-arg once a real
# custom domain is mapped. (Customer-facing quote links now derive from the
# request host instead — see /api/quotes/[id]/send — so they're domain-agnostic.)
# The real custom domain, bound to whichever Cloud Run service is live. Baked in
# at build (NEXT_PUBLIC_* is inlined by `next build`, so a runtime env can't set
# it). Using the domain — not a run.app host — means OAuth redirects, email links
# and the Razorpay webhook URL survive a region move (asia-south1 →
# asia-southeast1, 5 Sep 2026). Override via --build-arg for a preview build.
ARG NEXT_PUBLIC_APP_URL="https://reselleros.anutech.in"
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

# Which environment this image is for — "" (production) or "staging". Baked in like the
# rest, because the topbar shows a STAGING banner from it and that must be in the bundle.
# docs/STAGING.md.
ARG NEXT_PUBLIC_APP_ENV=""
ENV NEXT_PUBLIC_APP_ENV=$NEXT_PUBLIC_APP_ENV

# R-161 no-VM switches, browser half (the server half is Cloud Run env: DATA_GATEWAY,
# AUTH_PROVIDER, STORAGE_BACKEND). "" = off. db/ops/README.md "Switching the VM off".
ARG NEXT_PUBLIC_DATA_GATEWAY=""
ENV NEXT_PUBLIC_DATA_GATEWAY=$NEXT_PUBLIC_DATA_GATEWAY
ARG NEXT_PUBLIC_AUTH_PROVIDER=""
ENV NEXT_PUBLIC_AUTH_PROVIDER=$NEXT_PUBLIC_AUTH_PROVIDER

# Web-push VAPID PUBLIC key. Public by design — the browser sends it to the push
# service when subscribing, so it ends up in the client bundle either way (RFC 8292).
#
# It has to be HERE and not a Cloud Run env var, and the difference is not cosmetic:
# NEXT_PUBLIC_* is substituted into the bundle by `next build`, so a value supplied only
# at runtime arrives as undefined in the browser. The Notifications card reads exactly
# this variable to decide whether push is configured — so setting it the obvious way
# would have shipped a production app telling every user "Push is not set up on the
# server yet" while the server held both keys and worked fine.
#
# The matching VAPID_PRIVATE_KEY is a real secret and is a Cloud Run runtime env var.
# It must never appear in this file. The pair must stay together: a public key that does
# not match the private one produces subscriptions the server cannot ever push to.
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY="BD4DQzE6L6cSqpFJH8_409BbMpIZ4tyQ6PpToNVqviGN2v5uWUO5T4WU99Z7eIL3vJXK8Z3axZrV3iMS6SmP2Qk"

ENV NEXT_TELEMETRY_DISABLED=1

# ── THE BUILD RAN OUT OF MEMORY — 31 Aug 2026 ────────────────────────────────
# Build bf623310 died with "FATAL ERROR: Ineffective mark-compacts near heap limit
# Allocation failed - JavaScript heap out of memory", and the deploy simply did not happen.
# The same commit had built locally minutes earlier in 201s — a laptop has more headroom, so
# nothing in the gate could see this coming.
#
# It is NOT a shortage of machine. `cloudbuild.yaml` is E2_HIGHCPU_8, which is 8 vCPU and
# 8 GB, and the comment there already records that 32 cores bought 11% and was reverted. The
# shortage is Node's own heap: it sizes old-space from a fraction of what it detects and, in a
# container, that lands near 2 GB — a quarter of the RAM sitting there unused.
#
# 6 GB leaves ~2 GB for the OS, npm and the compiler's own child processes. Raising the
# machine instead would cost money for RAM Node was never going to ask for.
#
# If this returns, the next lever is real: 128 pages and 152 API routes type-checked in one
# pass. Splitting that is work, and buying heap first is the cheap half.
# ─── MADE OVERRIDABLE 29 Sep 2026, AND WHY ──────────────────────────────────
# The note above says "raising the machine instead would cost money for RAM Node was
# never going to ask for". On Next 14 that held — this app built on E2_HIGHCPU_8 as
# recently as 17 Sep. On Next 15 the first build after the upgrade died silently inside
# "Linting and checking validity of types" after 26 minutes: INTERNAL_ERROR, empty
# failureInfo, no error line. A kernel OOM kill writes nothing, which is that shape.
#
# The obvious answer — a 32 GB machine — is refused: E2_HIGHCPU_32 is quota-blocked in
# asia-south1 for this project ("Cloud Build cannot run builds of this machine type in
# this region"). So the build has to fit in 8 GB instead.
#
# 6144 of 8192 MB leaves ~2 GB for the OS, npm and the type-checker's child processes,
# and Next 15 evidently wants more than that margin. A LOWER cap is therefore not a
# downgrade: it makes Node collect earlier and stay inside the container, instead of the
# container being killed with no message.
#
# Default unchanged, so production's build is byte-identical to what has been shipping.
# Only the test build passes something else.
ARG NODE_HEAP_MB=6144
ENV NODE_OPTIONS=--max-old-space-size=${NODE_HEAP_MB}

# R-182 (6 Oct 2026): "1" skips next build's own type check (3.9 of its 9.8 min). Only
# cloudbuild.yaml passes it, because its gate step runs `next typegen` + `tsc` and push waits
# for the gate. A plain `docker build` leaves it empty and still type-checks. next.config.mjs.
ARG SKIP_BUILD_TYPECHECK=""
ENV SKIP_BUILD_TYPECHECK=$SKIP_BUILD_TYPECHECK

RUN npm run build

# ── Stage 3: minimal production image ───────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Copy only the standalone runtime + static assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# ─── Which build is this? ─────────────────────────────────────────────────────
# 26 Aug 2026. "Kya deploy aa gaya?" ka jawab aaj TEEN baar kahin se nahi mila:
# `gcloud` ka auth expire tha (aur `gcloud auth login` interactive hai), Cloud Build
# GitHub par commit status report nahi karta, aur app ke andar kuch nahi batata tha ki
# wo kaun sa commit chala rahi hai. Do baar timer par bharosa karna pada, jo naap nahi
# hai — aur ek baar wo andaza galat bhi nikla.
#
# `cloudbuild.yaml` pehle se image ko `$SHORT_SHA` se tag karta hai, aur uska comment
# kehta hai: "which build is live should never be a guess." Ye us iraade ko poora karta
# hai — tag repo me dikhta tha, chalti hui app me nahi.
#
# ⚠️ JAGAH SOCH KAR CHUNI HAI: ye COPY ke BAAD aur runner stage ke andar hai. Har commit
# par SHA badalta hai; upar rakhne par `npm install` aur `npm run build` ka cache har baar
# tootta aur deploy minute se badh kar bahut lamba ho jata. Yahan sirf ye do chhoti layer
# banti hain.
#
# NEXT_PUBLIC_ jaan-boojh kar NAHI — ye sirf server par chahiye. NEXT_PUBLIC_ hone par
# poore client bundle me chala jata, bina kisi faayde ke.
ARG BUILD_SHA="dev"
ARG BUILD_ID=""
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_ID=$BUILD_ID

USER nextjs
EXPOSE 8080

# server.js is generated by Next.js standalone build
CMD ["node", "server.js"]
