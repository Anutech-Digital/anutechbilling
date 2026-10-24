/**
 * R-739 (23 Oct 2026): AGENT_QUEUE_TOKEN is one static token, and until now it read and wrote
 * EVERY company's feedback (select * across tenants). It is now scoped: the token reaches only
 * the workspaces named in AGENT_QUEUE_TENANT_IDS, or — when that is not set — only the platform
 * company (Anutech, CLAUDE.md §4a). Wrong-token guesses are counted per IP.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { agentTenantScope, authorizeAgent, AGENT_SCOPE_ENV } from "./agent-token";
import { resetRateLimiter } from "./rate-limit";

const PLATFORM = "fbb976f1-9090-4f10-9726-0901bd144e42";
const T1 = "93b38539-0a9b-4942-bb33-3daa6cff97df";
const T2 = "0b0e1c4e-2f43-4d3a-9d0e-5d6a3b2c1f00";

const req = (token: string | null, ip = "198.51.100.4") =>
  new Request("https://example.invalid/api/agent/feedback-queue", {
    headers: { "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });

beforeEach(() => {
  resetRateLimiter();
  vi.stubEnv("AGENT_QUEUE_TOKEN", "q-token");
  vi.stubEnv(AGENT_SCOPE_ENV, "");
  vi.stubEnv("BUY_PAGE_TENANT_ID", "");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("agentTenantScope", () => {
  it("defaults to the platform company only — never every tenant", () => {
    expect(agentTenantScope()).toEqual([PLATFORM]);
  });

  it("follows BUY_PAGE_TENANT_ID when that names the platform company on this deployment", () => {
    vi.stubEnv("BUY_PAGE_TENANT_ID", T1);
    expect(agentTenantScope()).toEqual([T1]);
  });

  it("takes an explicit list, dropping anything that is not a uuid", () => {
    vi.stubEnv(AGENT_SCOPE_ENV, ` ${T1}, nonsense ,${T2},*`);
    expect(agentTenantScope()).toEqual([T1, T2]);
  });

  it("a list with nothing valid in it is EMPTY (refuses), never 'all'", () => {
    vi.stubEnv(AGENT_SCOPE_ENV, "*, all");
    expect(agentTenantScope()).toEqual([]);
  });
});

describe("authorizeAgent", () => {
  it("no token configured → 503", async () => {
    vi.stubEnv("AGENT_QUEUE_TOKEN", "");
    const a = authorizeAgent(req("q-token"));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.response.status).toBe(503);
  });

  it("wrong or missing token → 401", () => {
    for (const t of [null, "guess", "q-token-longer"]) {
      const a = authorizeAgent(req(t));
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.response.status).toBe(401);
    }
  });

  it("right token → the scope it may touch", () => {
    vi.stubEnv(AGENT_SCOPE_ENV, T1);
    const a = authorizeAgent(req("q-token"));
    expect(a).toEqual({ ok: true, tenantIds: [T1] });
  });

  it("an unusable scope refuses with a §24 message naming the variable to fix", async () => {
    vi.stubEnv(AGENT_SCOPE_ENV, "all");
    const a = authorizeAgent(req("q-token"));
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.response.status).toBe(503);
      expect((await a.response.json()).error).toMatch(new RegExp(AGENT_SCOPE_ENV));
    }
  });

  it("guessing the token from one IP is cut off with 429 and a wait", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 25; i++) {
      const a = authorizeAgent(req("guess", "203.0.113.50"));
      if (!a.ok) last = a.response;
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBeTruthy();
    /* Another caller is not affected. */
    expect(authorizeAgent(req("q-token", "203.0.113.51")).ok).toBe(true);
  });
});
