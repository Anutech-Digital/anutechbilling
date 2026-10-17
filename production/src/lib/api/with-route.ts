/**
 * withRoute() — ek API route handler ka common dhaancha (S21, 28 Sep 2026).
 *
 * Har route yahi chaar kaam alag-alag, thode alag tareeke se kar raha tha:
 *   1. getUser() → users row se tenant_id + role
 *   2. body/query ko parse karna (kahin zod, kahin `as { x?: string }`)
 *   3. role check ("owner/manager only")
 *   4. error: ~43 routes `error.message` seedha client ko bhejte hain — Postgres ka
 *      "duplicate key value violates unique constraint …" ek user ke screen par. Wo
 *      text schema batata hai aur user ke kisi kaam ka nahi (CLAUDE.md §24).
 *
 * Yahan:
 *   - 401 / 403 / 400 ke messages §24 wale (kya hua + ab kya karo).
 *   - `RouteError(status, publicMessage)` — author ka likha safe message client ko jata hai.
 *   - `dbFail(error, "…")` — DB error ho to RouteError throw; raw text sirf server log me.
 *   - koi aur throw → 500 + generic message + `ref`; log line `[api/…] METHOD failed (ref): …`
 *     — wahi `[route]` prefix jo lib/ops/cron-report stderr par likhta hai, taaki health
 *     digest ek hi filter se dono pakde. 5xx Sentry ko bhi jata hai.
 *   - response hamesha JSON: success `{ ok: true, ...data }`, error `{ ok: false, error, ref? }`.
 *
 * Status kaun chunega (AGENTS.md L6): tenant ki config/state → 4xx (409), hamari deployment
 * → 503, upstream fail → 502. RouteError me author khud chunta hai; catch-all sirf 500.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { Sentry } from "@/lib/sentry";
import { createClient } from "@/lib/supabase/server";
import { can, isUserRole, type Permissions, type UserRole } from "@/lib/auth/roles";
import { isRouteAllowed } from "@/lib/nav";

/**
 * R-1470: may this role open at least one of these app pages? Same rule as middleware's page
 * guard (nav.ts menu roles + ROUTE_DENY), so an API behind a page admits exactly the roles that
 * see that page — a sales login cannot call the bank-statement API from the browser console.
 * A missing or unknown role answers false (fail closed; canOpenRoute's "still loading → true"
 * is a UI rule, not a guard).
 */
export function mayOpenPage(role: string | null | undefined, pages: readonly string[]): boolean {
  if (!isUserRole(role)) return false;
  return pages.some((p) => isRouteAllowed(role, p));
}

/** The 403 text for a failed role gate (§24: what happened + whom to ask). */
export const ROLE_GATE_ERROR = "Ye kaam aapke role ko allowed nahi hai — workspace owner se kahiye.";

/** Author ka chuna hua status + wo message jo user ko dikhana safe hai. */
export class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    /** Sirf server log ke liye (raw DB text, upstream body…). Client ko kabhi nahi jata. */
    readonly detail?: string,
  ) {
    super(detail ? `${publicMessage} — ${detail}` : publicMessage);
    this.name = "RouteError";
  }
}

type DbErrorLike = { message: string; code?: string | null; details?: string | null } | null | undefined;

/**
 * Supabase `{ error }` ko safe RouteError me badlo. Raw text log me jata hai, client ko
 * `publicMessage`. Postgres guard ke `raise exception` messages (§24 wale "… pehle X karo")
 * user ke liye hi likhe gaye hain — unhe dikhana ho to `{ passGuardMessage: true }`.
 */
export function dbFail(error: DbErrorLike, publicMessage: string, opts: { status?: number; passGuardMessage?: boolean } = {}): void {
  if (!error) return;
  const detail = `${error.code ? `${error.code} ` : ""}${error.message}`;
  // P0001 = plpgsql `raise exception` — hamara apna likha guard message, schema leak nahi.
  if (opts.passGuardMessage && error.code === "P0001") throw new RouteError(opts.status ?? 409, error.message, detail);
  throw new RouteError(opts.status ?? 500, publicMessage, detail);
}

export type RouteContext<I> = {
  req: NextRequest;
  input: I;
  params: Record<string, string>;
  supabase: ReturnType<typeof createClient>;
  user: { id: string; email: string | null };
  tenantId: string;
  role: UserRole;
};

type Options<S extends z.ZodTypeAny | undefined> = {
  /** Log prefix, jaise "api/marketing/ads" → `[api/marketing/ads]`. */
  route: string;
  /** Body (POST/PUT/PATCH/DELETE) ya query string (GET/HEAD) ka zod schema. */
  input?: S;
  /** Sirf ye roles. Na do to koi bhi signed-in workspace member. */
  roles?: readonly UserRole[];
  /** R-732: ya PERMISSIONS table ka ek sawaal — can(role, permission) false ho to 403. `roles` ke saath bhi de sakte ho (dono lagte hain). */
  permission?: keyof Permissions;
  /** R-1470: un pages ki list jinke peeche ye API hai — caller in me se koi ek page khol sakta ho
   *  (mayOpenPage), warna 403. `roles` / `permission` ke saath bhi de sakte ho (sab lagte hain). */
  pages?: readonly string[];
  /** 403 par dikhne wala "ab kya karo" (role check fail hone par). */
  roleHint?: string;
};

type Handler<S extends z.ZodTypeAny | undefined> = (
  ctx: RouteContext<S extends z.ZodTypeAny ? z.infer<S> : undefined>,
) => Promise<Response | Record<string, unknown>>;

const fail = (status: number, error: string, ref?: string) =>
  NextResponse.json(ref ? { ok: false, error, ref } : { ok: false, error }, { status });

/** Chhota correlation id — user support ko bata sake, hum log me dhoondh sakein. */
function newRef(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function readInput(req: NextRequest): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (req.method === "GET" || req.method === "HEAD") {
    return { ok: true, value: Object.fromEntries(new URL(req.url).searchParams) };
  }
  const text = await req.text();
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/* Next 15: segment params arrive as a Promise (awaited below), and the route-type check
   wants the second argument REQUIRED ({ params: Promise<…> }). The req-only overload keeps
   tests and internal callers working; the last overload is the one Next checks. */
type WrappedRoute = {
  (req: NextRequest): Promise<Response>;
  (req: NextRequest, ctx: { params: Promise<Record<string, string>> }): Promise<Response>;
};

export function withRoute<S extends z.ZodTypeAny | undefined = undefined>(opts: Options<S>, handler: Handler<S>): WrappedRoute {
  const tag = `[${opts.route}]`;
  return async function route(req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }): Promise<Response> {
    try {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (!auth?.user) return fail(401, "Aap signed in nahi hain — dobara login karke try kariye.");

      const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", auth.user.id).maybeSingle();
      if (!me?.tenant_id) {
        return fail(403, "Aapka account kisi workspace se juda nahi hai — workspace owner se invite maangiye.");
      }
      const role: UserRole = me.role;
      if (opts.roles && !opts.roles.includes(role)) {
        return fail(403, opts.roleHint ?? `Ye kaam sirf ${opts.roles.join(" / ")} kar sakte hain — unse kahiye.`);
      }
      if (opts.permission && !can(role, opts.permission)) {
        return fail(403, opts.roleHint ?? ROLE_GATE_ERROR);
      }
      if (opts.pages && !mayOpenPage(role, opts.pages)) {
        return fail(403, opts.roleHint ?? ROLE_GATE_ERROR);
      }

      let input: unknown = undefined;
      if (opts.input) {
        const raw = await readInput(req);
        if (!raw.ok) return fail(400, "Request ka data padha nahi gaya (JSON galat hai) — page refresh karke dobara try kariye.");
        const parsed = opts.input.safeParse(raw.value);
        if (!parsed.success) {
          return fail(400, parsed.error.issues.map((i) => i.message).join(", ") || "Kuch fields galat hain — form check kariye.");
        }
        input = parsed.data;
      }

      const out = await handler({
        req,
        input: input as S extends z.ZodTypeAny ? z.infer<S> : undefined,
        params: (await ctx?.params) ?? {},
        supabase,
        user: { id: auth.user.id, email: auth.user.email ?? null },
        tenantId: me.tenant_id,
        role,
      });
      return out instanceof Response ? out : NextResponse.json({ ok: true, ...out });
    } catch (e) {
      return errorResponse(tag, req.method, e);
    }
  };
}

/** Exported for tests and for routes that cannot use the wrapper yet. */
export function errorResponse(tag: string, method: string, e: unknown): Response {
  if (e instanceof RouteError) {
    if (e.status >= 500) {
      const ref = newRef();
      console.error(`${tag} ${method} failed (${ref}): ${e.message}`);
      Sentry.captureException(e, { tags: { route: tag, ref } });
      return fail(e.status, e.publicMessage, ref);
    }
    // 4xx = user/tenant ki state; fault nahi, isliye warn (L6) — aur sirf jab detail ho.
    if (e.detail) console.warn(`${tag} ${method} ${e.status}: ${e.message}`);
    return fail(e.status, e.publicMessage);
  }
  const ref = newRef();
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`${tag} ${method} failed (${ref}): ${msg}`);
  Sentry.captureException(e, { tags: { route: tag, ref } });
  return fail(500, `Server par kuch galat ho gaya — thodi der baad dobara try kariye. Baar-baar ho to support ko ye ref bataiye: ${ref}`, ref);
}
