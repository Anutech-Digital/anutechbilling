/**
 * Root middleware — runs on every matched request.
 *
 * Responsibilities:
 * 1. Refresh Supabase auth session cookies
 * 2. Gate (app)/* routes behind authentication
 * 3. Redirect authenticated users away from (auth)/* routes
 */
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { authjsMiddlewareSession } from "@/server/auth/middleware-session";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { isRouteAllowed, ROLE_HOME, type UserRole } from "@/lib/nav";
import { rateLimitShared, clientIp, publicApiLimit } from "@/lib/security/rate-limit";
import { CHANGE_PASSWORD_PATH, mustChangePassword, safeNextPath } from "@/lib/auth/must-change-password";

// Routes that require authentication (the entire app shell).
// Keep this in sync with APP_NAV in src/lib/nav.ts — any new section's
// prefix must be added here for the auth gate + role guard to fire.
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/learn",           // Apprentice Academy — the apprentice's own area (R-149)
  "/academy",         // Apprentice Academy — staff side (R-149)
  "/today",           // S29 ranked inbox across every queue
  "/ux-insights",     // UX observer findings (3 Oct 2026)
  "/ui-insights",     // UI agent design scores (3 Oct 2026)
  "/quality",         // Quality Score — targets vs real numbers (R-263)
  "/ai-entry",
  "/leads",
  "/deals",
  "/tasks",
  "/customers",
  "/contacts",
  "/items",
  "/online-orders",
  "/quotes",
  "/payments",
  "/invoices",
  "/subscriptions",
  "/renewals",
  "/purchase-orders",
  "/projects",        // Project Sales (financials) — was missing from the gate
  "/performance",     // Team performance / bonus — was missing
  "/assessments",     // employee reasoning tests (owner view; public take page is /assessment/[token])
  "/enquiries",       // inbound enquiries inbox — was missing
  "/compliance",      // Pvt Ltd statutory compliance tracker
  "/accounting",      // /accounting/bills, /accounting/pnl, etc.
  "/whatsapp",
  "/automation",     // was "/automations" — the page was never gated (deep study, 27 Sep 2026)
  "/activity",
  "/help",
  "/scorecard",
  "/purchases",
  "/campaigns",
  "/online-promos",
  "/coupons",
  "/reports",
  "/support",
  "/setup",
  "/settings",
  "/team",
  "/partners",
  "/mobile",
  "/lead-gen",
  "/marketing",       // Hub, Spend, ROAS & CAC, Tracking links — was missing, so the shells rendered signed-out
  /* Internal bug-report triage queue. The role gate is the nav-derived one further
     down (owner + manager); this list is only the "must be signed in" half. */
  "/admin",
  /* ─── BOTH ADDED 19 Aug 2026, AND BOTH WERE ALREADY MISSING ──────────────────
     Found by curling the live service right after a deploy: `/dashboard` answered 307
     to /login as expected, and `/vault` and `/attendance/me` answered **200** — the app
     shell rendered for a request with no session at all.

     No data was exposed: every query underneath runs through PostgREST under RLS, and
     with no session there is no `auth.uid()`, so nothing comes back. But rendering the
     Password Vault and the private vault to a signed-out visitor is wrong on its own
     terms, and it is precisely the shape of thing a security review reads as a leak.

     `/vault` predates this session — the customer-console Password Vault has been
     reachable this way the whole time. `/attendance` covers /attendance/me and the
     kiosk; the kiosk is safe to gate because its own header says the office tablet runs
     it "logged in as the owner", so it always had a session. */
  "/vault",
  "/attendance",
  /* Onboarding fork for a signed-in person who has no workspace yet. It is
     PROTECTED (you must be authenticated to see it) but deliberately NOT in
     AUTH_PREFIXES below — those bounce a signed-in user to their role home,
     and this page exists precisely for people who do not have one yet. The
     role guard further down is skipped for them too, because `role` is null
     until a users row exists. */
  "/welcome",
];

// Routes that should redirect to /dashboard if user is logged in
const AUTH_PREFIXES = ["/login", "/signup"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /* ── /dev is not for the internet ──────────────────────────────────────────
     CLAUDE.md §7 has claimed since May that dev pages are "NOT included in production
     builds (middleware redirect if NODE_ENV=production)". Measured 23 Aug 2026:

         GET https://<prod>/dev/pdf-test   →   200, with no session

     There was no such redirect anywhere in this file. `/dev/pdf-test` renders a sample
     tax invoice from hardcoded fixtures — including the fabricated GSTIN
     27AABCE9876D1Z3 that lib/invoices/supplier-identity.ts exists to keep off real
     documents — served publicly under the company's own domain.

     Placed before the auth work below because this is not an authorisation question: a
     dev page should not exist in production for anybody, signed in or not. 404 rather
     than a redirect, so the answer is the same one a nonexistent route gives and the
     surface is not advertised.

     ALLOW_DEV_PAGES=1 reopens it for a deliberate session — the same shape as
     ALLOW_SENTRY_TEST, and set the same way: on, use it, off. */
  if (pathname === "/dev" || pathname.startsWith("/dev/")) {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_PAGES !== "1") {
      return new NextResponse(null, { status: 404 });
    }
  }

  /* ─── Rate limit: unauthenticated public surface (audit A3, 1 Sep 2026) ────
     Auth se PEHLE, kyunki ye routes bina session ke hi chalte hain — aur inme
     paid Gemini (agent/chat), email + auto-quote (enquiry), aur PIN-jaanch
     (expense-claim) baithe hain. Seemayein aur unke kyun: lib/security/
     rate-limit.ts. Cloud Armor ka badla nahi, kharche ka dhakkan hai.
     S20: RATE_LIMIT_STORE=postgres par ginti sab instances me saanjhi; warna
     (aur DB gadbad par) per-instance memory. */
  const rl = publicApiLimit(pathname);
  if (rl) {
    const verdict = await rateLimitShared(`pub:${pathname.split("/").slice(0, 4).join("/")}:${clientIp(request.headers)}`, rl);
    if (!verdict.ok) {
      return NextResponse.json(
        {
          error: "Bahut tez — thodi der ruk kar dobara koshish kariye.",
          retryAfterSec: verdict.retryAfterSec,
        },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfterSec) } },
      );
    }
  }

  // If Supabase isn't configured yet, just let everything pass.
  // (Until the operator pastes real env vars, we don't enforce auth.)
  if (!isSupabaseConfigured()) {
    return NextResponse.next();
  }

  // DEMO_MODE: bypass auth in local dev for screenshots / UI review.
  // Controlled by NEXT_PUBLIC_DEMO_MODE=true in .env.local only.
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true" && process.env.NODE_ENV === "development") {
    return NextResponse.next();
  }

  /* AUTH_PROVIDER=authjs: the session is Auth.js's (src/server/auth); same answers, same gates. */
  const { response, user, role, canViewDeals, needsMfa } = process.env.AUTH_PROVIDER === "authjs"
    ? await authjsMiddlewareSession(request)
    : await updateSession(request);
  const isAuthed = !!user;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAuthPage = AUTH_PREFIXES.some((p) => pathname.startsWith(p));

  // Not logged in → block protected routes
  if (!isAuthed && isProtected) {
    const url = request.nextUrl.clone();
    /* Two fixes in three lines, both found by curling the deployed app.

       The QUERY has to survive. `next` used to carry the pathname alone, so a signed-out
       click on "Lifetime paid" (/payments?customer=<id>) landed on a bare /payments after
       logging in — the filter silently gone, which reads as the link being broken.

       And the inherited params have to go. `url` is a CLONE of the original request, so
       /payments?customer=abc produced /login?customer=abc&next=%2Fpayments — the app's own
       query strings leaking onto the login screen, where they mean nothing. */
    const target = pathname + request.nextUrl.search;
    url.search = "";
    url.pathname = "/login";
    url.searchParams.set("next", target);
    return NextResponse.redirect(url);
  }

  /* R-048 part 2: two-factor on, code not given yet → every app page (and the login/signup
     bounce below, which would otherwise loop) goes to /mfa first. /mfa itself is neither
     protected nor an auth page, so it never redirects to itself. */
  if (isAuthed && needsMfa && (isProtected || isAuthPage)) {
    const url = request.nextUrl.clone();
    const target = isProtected ? pathname + request.nextUrl.search : "";
    url.search = "";
    url.pathname = "/mfa";
    if (target) url.searchParams.set("next", target);
    return NextResponse.redirect(url);
  }

  /* R-391: the forced password-change screen needs a session (it re-checks the current,
     temporary password), so a signed-out visit goes to login and comes back. */
  if (!isAuthed && pathname === CHANGE_PASSWORD_PATH) {
    const url = request.nextUrl.clone();
    url.search = "";
    url.pathname = "/login";
    url.searchParams.set("next", CHANGE_PASSWORD_PATH);
    return NextResponse.redirect(url);
  }

  /* R-391: an owner set a temporary password for this account (app_metadata flag, written
     only with the service role). Every app page goes to /change-password until the member
     picks their own — after that the owner no longer knows it. After the MFA step, before the
     role guard. On R-161's Auth.js session the middleware user carries no app_metadata, so
     this reads false there and the client gate in (app)/layout.tsx redirects instead. */
  if (isAuthed && (isProtected || isAuthPage) && mustChangePassword(user)) {
    const url = request.nextUrl.clone();
    const next = isProtected ? safeNextPath(pathname + request.nextUrl.search, "") : "";
    url.search = "";
    url.pathname = CHANGE_PASSWORD_PATH;
    if (next) url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }

  /* Apprentice Academy (R-149): an apprentice may use /learn and the academy API, nothing
     else. The database already hides every company table from them (they have no
     public.users row, so current_tenant_id() is null); this keeps them off staff pages and
     off every other API route too, so no admin-client route can be reached by one. */
  if (isAuthed && role === "apprentice") {
    const apiOk = pathname.startsWith("/api/academy/") || pathname.startsWith("/api/auth/");
    if (pathname.startsWith("/api/") && !apiOk) {
      return NextResponse.json({ error: "Not available for apprentice accounts." }, { status: 403 });
    }
    if (isAuthPage || (isProtected && !pathname.startsWith("/learn"))) {
      const url = request.nextUrl.clone();
      url.pathname = "/learn";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return response;
  }

  // Logged in → redirect away from auth pages, sending each role to its
  // own home page (sales lands on /leads, others on /dashboard).
  if (isAuthed && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = ROLE_HOME[(role as UserRole) ?? "owner"] ?? "/dashboard";
    url.searchParams.delete("next");
    return NextResponse.redirect(url);
  }

  // Role-based route guard. Sales users only have /leads + /tasks in their
  // nav; visiting any other protected route bounces them to their home.
  // Owners + managers get the full app — no gate applied to them.
  if (isAuthed && isProtected && role && role !== "owner" && role !== "manager") {
    const userRole = role as UserRole;
    const isAllowedPath = isRouteAllowed(userRole, pathname, { canViewDeals });
    if (!isAllowedPath) {
      const url = request.nextUrl.clone();
      url.pathname = ROLE_HOME[userRole];
      url.searchParams.delete("next");
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  /* Node.js, not Edge (5 Oct 2026): with the VM gone, the role lookup below runs through the
     in-process data gateway (Prisma), which needs Node. Stable in Next 15.5. */
  runtime: "nodejs",
  // Run on everything except static assets + Next internals
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
