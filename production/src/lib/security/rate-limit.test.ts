/**
 * Rate limiter ke test — ginti, khidki, aur wiring teeno.
 *
 * Wiring wala hissa isliye hai kyunki limiter ka sabse aasan failure mode
 * "bana par kahin laga nahi" hai — wahi haal money-check.yml ka tha (likha
 * gaya, kabhi chala nahi).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  rateLimit, resetRateLimiter, clientIp, publicApiLimit, rateLimitShared, resetSharedStoreState,
} from "./rate-limit";

beforeEach(() => resetRateLimiter());
afterEach(() => vi.useRealTimers());

describe("rateLimit — ginti aur khidki", () => {
  it("seema ke andar sab paas, uske baad 429-yogya", () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit("k", { limit: 5, windowMs: 60_000 }).ok).toBe(true);
    }
    const sixth = rateLimit("k", { limit: 5, windowMs: 60_000 });
    expect(sixth.ok).toBe(false);
    expect(sixth.retryAfterSec).toBeGreaterThan(0);
  });

  it("khidki beetne par ginti nayi", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
    expect(rateLimit("w", { limit: 1, windowMs: 10_000 }).ok).toBe(true);
    expect(rateLimit("w", { limit: 1, windowMs: 10_000 }).ok).toBe(false);
    vi.setSystemTime(new Date("2026-09-01T10:00:11Z"));
    expect(rateLimit("w", { limit: 1, windowMs: 10_000 }).ok).toBe(true);
  });

  it("alag keys alag baltiyan", () => {
    expect(rateLimit("a", { limit: 1, windowMs: 60_000 }).ok).toBe(true);
    expect(rateLimit("b", { limit: 1, windowMs: 60_000 }).ok).toBe(true);
  });
});

describe("clientIp — XFF ki RIGHT se, kyunki left client khud likhta hai (S20)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("seedha Cloud Run (1 hop): aakhri entry client hai", () => {
    /* Cloud Run ka front-end asli IP AAKHIR me jodta hai. */
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("SPOOF: client ki bheji pehli entry ko nahi maanta — ASLI JAAL", () => {
    /* curl -H "X-Forwarded-For: 1.2.3.4" → Cloud Run use aage rakh kar asli IP peeche
       jodta hai. Pehli entry lene par har request nayi balti = rate limit zero. */
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" });
    expect(clientIp(h)).toBe("203.0.113.9");
  });

  it("har request par badalta spoof bhi ek hi balti me girta hai", () => {
    const keys = new Set(
      [1, 2, 3, 4, 5].map((i) => clientIp(new Headers({ "x-forwarded-for": `10.9.9.${i}, 203.0.113.9` }))),
    );
    expect([...keys]).toEqual(["203.0.113.9"]);
  });

  it("2 hops (LB / Cloudflare-proxy aage): aakhri se ek pehle wali", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 130.211.0.5" });
    expect(clientIp(h, 2)).toBe("203.0.113.9");
  });

  it("TRUSTED_PROXY_HOPS env padhta hai; bekaar value par 1", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 130.211.0.5" });
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIp(h)).toBe("203.0.113.9");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "abc");
    expect(clientIp(h)).toBe("130.211.0.5");
  });

  it("hops se kam entries: sabse left wali (wo bhi infra ki hai)", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }), 2)).toBe("203.0.113.9");
  });

  it("khaali/space wali entries chhod deta hai", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9 , " }))).toBe("203.0.113.9");
  });

  it("header hi na ho to 'unknown' — sab ek bounded balti me", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("rateLimitShared — Postgres ginti, memory par fallback", () => {
  beforeEach(() => {
    resetSharedStoreState();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://db.example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-test");
  });
  afterEach(() => vi.unstubAllEnvs());

  const rpcOk = (allowed: boolean, hits: number, retry = 0) =>
    vi.fn(async () => new Response(JSON.stringify([{ allowed, hits, retry_after_sec: retry }]), { status: 200 }));

  it("RATE_LIMIT_STORE set nahi → DB ko chhoota bhi nahi (memory)", async () => {
    const f = rpcOk(true, 1);
    const r = await rateLimitShared("m", { limit: 1, windowMs: 60_000 }, f);
    expect(r.ok).toBe(true);
    expect(f).not.toHaveBeenCalled();
    expect((await rateLimitShared("m", { limit: 1, windowMs: 60_000 }, f)).ok).toBe(false);
  });

  it("postgres par RPC ka faisla maanta hai, key hash karke bhejta hai", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "postgres");
    const f = rpcOk(false, 11, 42);
    const r = await rateLimitShared("pub:/api/public/agent:203.0.113.9", { limit: 10, windowMs: 60_000 }, f);
    expect(r).toEqual({ ok: false, retryAfterSec: 42, remaining: 0 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://db.example.test/rest/v1/rpc/rate_limit_hit");
    const body = JSON.parse(String(init.body));
    expect(body.p_key).toMatch(/^[0-9a-f]{64}$/);
    expect(String(init.body)).not.toContain("203.0.113.9");
  });

  it("RPC 5xx / network error → memory, aur 30s tak DB ko nahi chhoota", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "postgres");
    const bad = vi.fn(async () => new Response("nope", { status: 503 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await rateLimitShared("f", { limit: 1, windowMs: 60_000 }, bad)).ok).toBe(true);
    /* Doosri call memory se — aur memory ne pehli ko gin liya tha, to ab 429. */
    expect((await rateLimitShared("f", { limit: 1, windowMs: 60_000 }, bad)).ok).toBe(false);
    expect(bad).toHaveBeenCalledTimes(1);

    const thrower = vi.fn(async () => { throw new Error("ECONNRESET"); });
    resetSharedStoreState();
    expect((await rateLimitShared("g", { limit: 5, windowMs: 60_000 }, thrower)).ok).toBe(true);
  });

  it("ajeeb jawab (khaali array) bhi fallback hai, 'sab paas' nahi", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "postgres");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const empty = vi.fn(async () => new Response("[]", { status: 200 }));
    await rateLimitShared("e", { limit: 1, windowMs: 60_000 }, empty);
    expect((await rateLimitShared("e", { limit: 1, windowMs: 60_000 }, empty)).ok).toBe(false);
  });
});

describe("publicApiLimit — kaun si raah kis seema par", () => {
  it("AI chat, likhne wale, PIN, aur GET sab par KOI na koi seema hai", () => {
    for (const p of [
      "/api/public/agent/chat",
      "/api/public/enquiry/workspace",
      "/api/public/enquiry/general",
      "/api/public/checkout/workspace",
      "/api/public/trial/workspace",
      "/api/public/expense-claim/verify",
      "/api/public/catalog/workspace",
      "/api/public/coupons/validate",
      "/api/auth/signup",
    ]) {
      expect(publicApiLimit(p), p).not.toBeNull();
    }
  });

  it("PIN-jaanch wali seema sabse kasi hui hai", () => {
    const pin = publicApiLimit("/api/public/expense-claim/verify")!;
    const chat = publicApiLimit("/api/public/agent/chat")!;
    expect(pin.limit / (pin.windowMs / 60_000)).toBeLessThan(chat.limit / (chat.windowMs / 60_000));
  });

  /* R-050 (7 Oct 2026): /api/v1 (API-key + vendor webhooks) aur attendance/punch (ingest key)
     bhi session ke bina chalte hain, par middleware unhe ginta hi nahi tha. */
  it("R-050: /api/v1 aur attendance/punch par bhi seema hai", () => {
    for (const p of [
      "/api/v1/customers",
      "/api/v1/customers/C-1/invoices",
      "/api/v1/telecalling/make-call",
      "/api/v1/telecalling/webhook",
      "/api/v1/integrations/support-whatsapp-inbound",
      "/api/v1/documents/invoice/INV-1/pdf",
      "/api/attendance/punch",
    ]) {
      expect(publicApiLimit(p), p).not.toBeNull();
    }
  });

  it("R-050: paise wali make-call ki seema padhne wale v1 routes se kasi hai", () => {
    const call = publicApiLimit("/api/v1/telecalling/make-call")!;
    const read = publicApiLimit("/api/v1/customers/C-1")!;
    const perMin = (l: { limit: number; windowMs: number }) => l.limit / (l.windowMs / 60_000);
    expect(perMin(call)).toBeLessThan(perMin(read));
  });

  it("R-050: v1 ki seema poori hone par 429-yogya (middleware wali key se)", () => {
    const lim = publicApiLimit("/api/v1/telecalling/make-call")!;
    const key = "pub:/api/v1/telecalling:203.0.113.9";
    for (let i = 0; i < lim.limit; i++) expect(rateLimit(key, lim).ok).toBe(true);
    expect(rateLimit(key, lim).ok).toBe(false);
  });

  it("R-050: attendance ke baaki (session wale) routes ko nahi chhoota", () => {
    expect(publicApiLimit("/api/attendance/mark")).toBeNull();
    expect(publicApiLimit("/api/attendance/self")).toBeNull();
  });

  it("authenticated app-routes ko chhoota hai", () => {
    expect(publicApiLimit("/api/quotes/abc/send")).toBeNull();
    expect(publicApiLimit("/dashboard")).toBeNull();
  });
});

describe("wiring — limiter LAGA bhi hai", () => {
  it("middleware public raaste par rateLimit bulata hai, auth se pehle", () => {
    const src = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    const gate = src.indexOf("publicApiLimit(");
    const auth = src.indexOf("updateSession(request)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(auth);
    expect(src).toContain("429");
  });

  it("PIN-verify route per-employee tala rakhta hai", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/api/public/expense-claim/verify/route.ts"),
      "utf8",
    );
    const gate = src.indexOf("claim-pin:");
    const rpc = src.indexOf('rpc("verify_claim_access"');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(rpc);
  });
});
