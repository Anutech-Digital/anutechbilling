/**
 * Rate limiter — poore app ka PEHLA (audit A3, 1 Sep 2026).
 *
 * Us din tak 153 routes me 429 sirf teen jagah tha (vault PIN). 18 public
 * endpoints khule the: /api/public/agent/chat har message par PAID Gemini
 * jalata hai, /api/public/enquiry/* email + auto-quote bhejta hai, aur
 * expense-claim ka 4-digit PIN bina kisi ginti ke brute-force ho sakta tha
 * (10,000 koshish = pakka). Enquiry route ka apna comment kehta tha:
 * "Rate limit TODO: bolt on at the edge later" — edge kabhi aaya nahi.
 *
 * S20 (28 Sep 2026): IP ab XFF ki right se aati hai (clientIp), aur `rateLimitShared`
 * RATE_LIMIT_STORE=postgres par sab instances ki ek ginti rakhta hai — neeche dekho.
 *
 * ─── DESIGN: fixed-window, in-memory, PER-INSTANCE ──────────────────────────
 * Ye Cloud Armor/Cloudflare ka badla nahi hai — Cloud Run ke N instances me
 * har ek ki apni ginti hai (wahi seemā jo gemini.ts ke circuit-breaker par
 * likhi hai). Iska matlab: asli seema `limit × instances` tak dheeli ho
 * sakti hai. Wo bhi anant se bahut chhota hai, aur yahi is file ka kaam
 * hai: kharcha BOUNDED karna, perfect fairness nahi.
 *
 * Middleware (edge-runtime) se bhi chalta hai, isliye yahan sirf Map aur
 * Date.now() — koi node:crypto/fs nahi.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/* Memory ka tala: ~50k khaali hone par sabse purane aadha saaf. Ek hamla
   jitni entries banata hai unhe hi ginta rehna khud ek DoS hota. */
const MAX_KEYS = 50_000;

function prune(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
  if (buckets.size < MAX_KEYS) return;
  let toDrop = Math.floor(buckets.size / 2);
  for (const k of buckets.keys()) {
    if (toDrop-- <= 0) break;
    buckets.delete(k);
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** 429 ke saath bhejne ke liye — poore second me. */
  retryAfterSec: number;
  remaining: number;
}

/**
 * Ek koshish gino. `key` me route-class + pehchan dono hon
 * (jaise "public:103.25.1.9" ya "claim-pin:CLM-123").
 */
export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): RateLimitResult {
  const now = Date.now();
  prune(now);

  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, retryAfterSec: 0, remaining: opts.limit - 1 };
  }

  b.count += 1;
  if (b.count > opts.limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  return { ok: true, retryAfterSec: 0, remaining: opts.limit - b.count };
}

/** Test/dev ke liye — production code ise kabhi na bulaye. */
export function resetRateLimiter(): void {
  buckets.clear();
}

/**
 * Kitni proxy-hops HUMARI hain (right se ginti). Env `TRUSTED_PROXY_HOPS`, default 1.
 *
 * - 1 = seedha Cloud Run (domain mapping, Cloudflare DNS-only — aaj ka setup). Google ka
 *   front-end asli client IP ko XFF ke AAKHIR me jodta hai.
 * - 2 = Cloud Run ke aage ek aur proxy jo khud XFF me jodti hai (HTTPS Load Balancer, ya
 *   Cloudflare orange-cloud). Tab client aakhri se ek pehle hai.
 * Galat number: kam rakha to sab ek proxy-IP ki balti me (bounded, khula nahi); zyada rakha
 * to attacker phir se ek entry chun sakta hai. Isliye infra badle to ye bhi badlo.
 */
export function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

/**
 * Request ka IP — `x-forwarded-for` ki right se `hops`-vi entry.
 *
 * ⚠️ S20 (28 Sep 2026) tak ye PEHLI (left-most) entry leta tha. Wo entry CLIENT KHUD bhejta
 * hai: `curl -H "X-Forwarded-For: 1.2.3.$RANDOM"` par Cloud Run use aage bina chhede bhejta
 * hai aur apni entry peeche jodta hai. Yaani har request nayi balti = rate limit ZERO — chat
 * par anant paid Gemini, enquiry par anant email. Sirf right wali entries humari infra
 * likhti hai; wahi bharose layak hain.
 *
 * XFF me `hops` se kam entries hon (koi proxy chhoot gayi) to sabse left wali — wo bhi
 * infra ki likhi hai, client ki nahi. Header hi na ho (seedha container par curl) to sab
 * ek hi balti me — bounded hai, khula nahi.
 */
export function clientIp(headers: Headers, hops: number = trustedProxyHops()): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[Math.max(0, parts.length - hops)];
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/* ─── Shared store (Postgres) — opt-in, memory par fallback ──────────────────
 *
 * Per-instance ginti ka matlab asli seema `limit × instances`. `RATE_LIMIT_STORE=postgres`
 * par ginti `public.rate_limit_hit()` RPC (migration 20260928140000, service_role only) me
 * hoti hai — sab instances ek hi ginti dekhte hain.
 *
 * Default OFF: har public request par ek DB round-trip judta hai, to pehle naap kar on karo
 * (docs/SECURITY-RUNBOOK.md). DB dheema/band ho to memory wali ginti — limiter kabhi public
 * raasta band NAHI karta, aur kabhi khula bhi nahi chhodta. Ek baar fail hone par 30s tak DB
 * ko chhoda jaata hai, warna har request timeout ki keemat deti.
 */
const SHARED_TIMEOUT_MS = 300;
const SHARED_COOLDOWN_MS = 30_000;
let sharedDownUntil = 0;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/* Key me IP hai; DB me kacha IP rakhne ki zaroorat nahi — ginti ke liye hash kaafi hai. */
async function hashKey(key: string): Promise<string> {
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sharedHit(
  key: string,
  opts: { limit: number; windowMs: number },
  fetchImpl: FetchLike,
): Promise<RateLimitResult | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SHARED_TIMEOUT_MS);
  try {
    /* DATA_GATEWAY=1 (5 Oct 2026): the RPC is answered in-process — over HTTP the gateway would
       refuse the service-role key, and this would silently fall back to per-instance memory. */
    if (fetchImpl === fetch && process.env.DATA_GATEWAY === "1") {
      const { gatewayFetch } = await import("@/server/postgrest/fetch");
      fetchImpl = gatewayFetch(url, { allowService: true }) as FetchLike;
    }
    const r = await fetchImpl(`${url.replace(/\/$/, "")}/rest/v1/rpc/rate_limit_hit`, {
      method: "POST",
      headers: { apikey: svc, authorization: `Bearer ${svc}`, "content-type": "application/json" },
      body: JSON.stringify({ p_key: await hashKey(key), p_limit: opts.limit, p_window_ms: opts.windowMs }),
      cache: "no-store",
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ allowed: boolean; hits: number; retry_after_sec: number }>;
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || typeof row.allowed !== "boolean") return null;
    return {
      ok: row.allowed,
      retryAfterSec: row.allowed ? 0 : Math.max(1, row.retry_after_sec),
      remaining: Math.max(0, opts.limit - row.hits),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `rateLimit` jaisa hi, par `RATE_LIMIT_STORE=postgres` par sab instances ki saanjhi ginti.
 * Koi bhi gadbad (env nahi, timeout, RPC nahi bani, 5xx) → memory wala `rateLimit`.
 */
export async function rateLimitShared(
  key: string,
  opts: { limit: number; windowMs: number },
  fetchImpl: FetchLike = fetch,
): Promise<RateLimitResult> {
  if (process.env.RATE_LIMIT_STORE !== "postgres" || Date.now() < sharedDownUntil) {
    return rateLimit(key, opts);
  }
  const shared = await sharedHit(key, opts, fetchImpl);
  if (shared) return shared;
  sharedDownUntil = Date.now() + SHARED_COOLDOWN_MS;
  console.warn("[rate-limit] shared store unavailable — memory fallback for 30s");
  return rateLimit(key, opts);
}

/** Test ke liye — cooldown saaf. */
export function resetSharedStoreState(): void {
  sharedDownUntil = 0;
}

/** R-050: ek API key ek ghante me itni hi AI phone calls maang sakti hai (make-call route, per KEY). */
export const MAKE_CALL_PER_KEY = { limit: 30, windowMs: 60 * 60_000 } as const;

/**
 * /api/public/*, signup, /api/v1/* aur attendance/punch ke liye ek hi jagah tay ki hui seemayein
 * (sab bina session ke chalte hain; middleware inhe auth se pehle IP par ginta hai).
 * Number chune hue hain, nape hue nahi — asli traffic aane par inhe
 * naap kar kasna/dheela karna (tab tak "bahut" ka matlab "anant nahi").
 */
export function publicApiLimit(pathname: string): { limit: number; windowMs: number } | null {
  /* R-050 (7 Oct 2026): machine-to-machine raaste. Inki seema UDAAR hai — DMS ka server ek hi
     IP se apne sab grahakon ke liye /api/v1 padhta hai, aur Meta/Retell webhooks jhund me aate
     hain; maqsad sirf "anant nahi" hai, asli traffic rokna nahi. */
  if (pathname.startsWith("/api/v1/")) {
    // Paisa kharch: har request ek AI phone call maang sakti hai. Route me per-KEY seema alag se.
    if (pathname.startsWith("/api/v1/telecalling/make-call")) return { limit: 30, windowMs: 10 * 60_000 };
    // Vendor webhooks (WhatsApp/email inbound, telecall result) — signature-checked, bursty.
    if (pathname.startsWith("/api/v1/integrations/") || pathname.startsWith("/api/v1/telecalling/")) {
      return { limit: 600, windowMs: 60_000 };
    }
    // PDF render CPU khaata hai; customer link par click karta hai, loop nahi.
    if (pathname.startsWith("/api/v1/documents/")) return { limit: 120, windowMs: 5 * 60_000 };
    // API-key reads (DMS billing status).
    return { limit: 600, windowMs: 60_000 };
  }
  // Office ka biometric bridge: kuch minute me ek batch. Galat ingest-key ka andaaza bhi yahi rokta hai.
  if (pathname === "/api/attendance/punch") return { limit: 120, windowMs: 5 * 60_000 };

  if (!pathname.startsWith("/api/public/") && pathname !== "/api/auth/signup") return null;

  // AI chat: har message Gemini hai. Ek insaan ki asli baat-cheet ~1 msg/8s
  // se tez nahi hoti.
  if (pathname.startsWith("/api/public/agent/")) return { limit: 30, windowMs: 5 * 60_000 };

  // Likhne wale (lead/email/auto-quote/checkout/trial/signup): ek IP se
  // itne form asli insaan nahi bharta.
  if (
    pathname.startsWith("/api/public/enquiry/") ||
    pathname.startsWith("/api/public/checkout/") ||
    pathname.startsWith("/api/public/trial/") ||
    pathname === "/api/auth/signup"
  ) {
    return { limit: 10, windowMs: 10 * 60_000 };
  }

  // PIN/token जांच — brute-force ka raasta. Sabse kasa hua.
  if (pathname.startsWith("/api/public/expense-claim")) return { limit: 15, windowMs: 15 * 60_000 };

  // Baaki public GET/POST (catalog, promo, coupons, quote-accept…):
  // udaar par bounded.
  return { limit: 120, windowMs: 5 * 60_000 };
}
