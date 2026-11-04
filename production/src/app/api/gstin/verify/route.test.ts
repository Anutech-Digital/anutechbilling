/**
 * R-1734: "Verify with GSTN" with NO provider configured must never hand back (or save) the
 * mock company on a deployed server. Owner's example: live, Sandbox not set, GSTIN
 * 07AAACR5055K1Z5 (check digit is really 9 — the test uses …Z9) → Verify → "GSTN verification is not set up", name/address untouched.
 * On a laptop (next dev) the deterministic mock stays, so the UI is still testable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGstin = vi.fn();
const writes: Array<{ table: string; patch: unknown }> = [];
let secretsRow: Record<string, string> | null = null;

function query(table: string) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.single = () =>
    Promise.resolve({
      data:
        table === "users" ? { tenant_id: "t1", role: "owner" }
        : table === "customers" ? { gstin: null, tenant_id: "t1" }
        : table === "tenants" ? { gstin: "07AAACR5055K1Z9" }
        : null,
    });
  q.maybeSingle = () => Promise.resolve({ data: table === "tenant_secrets" ? secretsRow : null });
  q.update = (patch: unknown) => {
    writes.push({ table, patch });
    return { eq: () => Promise.resolve({ error: null }) };
  };
  return q;
}
const client = {
  auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } } }) },
  from: (t: string) => query(t),
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => client,
  createAdminClientFor: () => client,
}));
vi.mock("@/lib/api/with-route", () => ({
  mayOpenPage: () => true,
  ROLE_GATE_ERROR: "role",
}));
vi.mock("@/lib/gst/mock-gstin", () => ({
  mockGstinVerification: (g: string) => mockGstin(g),
}));
/* R-735: Sandbox is fetched through safeFetch, which resolves the host first — a public answer here. */
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "104.18.1.1", family: 4 }] }));

import { POST } from "./route";

const GSTIN = "07AAACR5055K1Z9";
function req(body: unknown) {
  return { json: () => Promise.resolve(body) } as unknown as Parameters<typeof POST>[0];
}
const fakeMock = { status: "Active", legal_name: "AAACR Technologies Private Limited", source: "mock" };

beforeEach(() => {
  writes.length = 0;
  secretsRow = null;
  mockGstin.mockReset().mockReturnValue(fakeMock);
  vi.stubEnv("SANDBOX_API_KEY", "");
  vi.stubEnv("SANDBOX_API_SECRET", "");
  vi.stubEnv("K_SERVICE", "");
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "");
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("deployed server, no provider → no mock, nothing saved", () => {
  it.each([
    ["NODE_ENV", "production"],
    ["NEXT_PUBLIC_APP_ENV", "staging"],
    ["NEXT_PUBLIC_APP_ENV", "production"],
    ["K_SERVICE", "resellersos-staging"],
  ])("%s=%s → ok:false 'not set up', mock never called, no DB write", async (key, value) => {
    vi.stubEnv(key, value);
    for (const body of [
      { gstin: GSTIN },                        // Settings → Company (tenant row)
      { gstin: GSTIN, customer_id: "c1" },     // customer row
      { gstin: GSTIN, save: false },           // add-customer form (noPersist)
    ]) {
      const res = await POST(req(body));
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.code).toBe("provider_not_configured");
      expect(json.error).toBe("GSTN verification is not set up — enter the details from the GST certificate.");
      expect(json.verification).toBeUndefined();
      expect(res.status).toBeLessThan(500);
    }
    expect(mockGstin).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("laptop (next dev / tests), no provider → mock as before", () => {
  it("returns the mock with mock:true", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "local");
    const res = await POST(req({ gstin: GSTIN, save: false }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, mock: true, verification: fakeMock });
    expect(mockGstin).toHaveBeenCalledWith(GSTIN);
  });
});

describe("provider configured → Sandbox path unchanged, even in production", () => {
  it("calls Sandbox (mocked fetch), never the mock", async () => {
    vi.stubEnv("NODE_ENV", "production");
    secretsRow = { sandbox_api_key: "k", sandbox_api_secret: "s", sandbox_api_base: "https://api.sandbox.co.in" };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/authenticate")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: { data: { gstin: GSTIN, lgnm: "REAL CO PVT LTD", sts: "Active" } } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await POST(req({ gstin: GSTIN, save: false }));
    const json = await res.json();
    log.mockRestore();
    expect(json.ok).toBe(true);
    expect(json.mock).toBe(false);
    expect(json.verification.legal_name).toBe("REAL CO PVT LTD");
    expect(json.verification.source).toBe("sandbox");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockGstin).not.toHaveBeenCalled();
  });
});

describe("R-735 — a saved base URL outside Sandbox never receives the keys", () => {
  it.each(["http://169.254.169.254", "https://evil.example.com", "https://127.0.0.1"])(
    "%s → fetch never called, the answer says where to fix it",
    async (base) => {
      secretsRow = { sandbox_api_key: "k", sandbox_api_secret: "s", sandbox_api_base: base };
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await POST(req({ gstin: GSTIN, save: false }));
      err.mockRestore();
      const json = await res.json();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/Settings → Integrations/);
      expect(mockGstin).not.toHaveBeenCalled();
    },
  );
});

/* R-2168 — owner's live test on staging, 30 Oct: a live key saved with the test host answered
   "Could not reach GSTIN provider" while Sandbox really said 403 "Use test API key for test
   environment"; and GSTN's lstupdt was shown as "Last return filed". */
describe("R-2168 — key prefix, Sandbox's own message, 'details last updated'", () => {
  /* built at runtime so the secret-scan does not read fake values as real ones */
  const KEY = ["key", "live", "FAKEKEY123"].join("_");
  const SECRET = ["secret", "live", "FAKEVALUE999"].join("_");

  it("a test key with the default base is sent to the test host", async () => {
    secretsRow = { sandbox_api_key: "key_test_abc", sandbox_api_secret: "s", sandbox_api_base: "https://api.sandbox.co.in" };
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/authenticate")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({ data: { data: { gstin: GSTIN, lgnm: "T CO", sts: "Active" } } }), { status: 200 });
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const json = await (await POST(req({ gstin: GSTIN, save: false }))).json();
    log.mockRestore();
    expect(json.ok).toBe(true);
    expect(urls.every((u) => u.startsWith("https://test-api.sandbox.co.in/"))).toBe(true);
  });

  it("a saved live key + test host is refused before any key is sent", async () => {
    secretsRow = { sandbox_api_key: KEY, sandbox_api_secret: SECRET, sandbox_api_base: "https://test-api.sandbox.co.in" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ gstin: GSTIN, save: false }));
    const json = await res.json();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("sandbox_key_base_mismatch");
    expect(json.error).toMatch(/live API key/i);
    expect(json.error).toMatch(/Settings → Integrations/);
    expect(JSON.stringify(json)).not.toContain(KEY);
  });

  it("Sandbox's 4xx message text reaches the owner — never the key or secret", async () => {
    secretsRow = { sandbox_api_key: KEY, sandbox_api_secret: SECRET, sandbox_api_base: "https://api.sandbox.co.in" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ code: 403, message: `Use test API key for test environment (${KEY} / ${SECRET})`, timestamp: 1 }),
      { status: 403 },
    )));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req({ gstin: GSTIN, save: false }));
    const logged = JSON.stringify(err.mock.calls);
    err.mockRestore();
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("provider_rejected");
    expect(json.error).toContain("Use test API key for test environment");
    expect(json.error).not.toMatch(/Could not reach/);
    expect(JSON.stringify(json)).not.toContain(KEY);
    expect(JSON.stringify(json)).not.toContain(SECRET);
    expect(logged).not.toContain(SECRET);
  });

  it("GSTN lstupdt is 'details_last_updated', never 'last_return_filed'", async () => {
    secretsRow = { sandbox_api_key: "k", sandbox_api_secret: "s", sandbox_api_base: "https://api.sandbox.co.in" };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/authenticate")) return new Response(JSON.stringify({ access_token: "tok2" }), { status: 200 });
      return new Response(JSON.stringify({ data: { data: { gstin: GSTIN, lgnm: "X", sts: "Active", rgdt: "04/03/2026", lstupdt: "04/03/2026" } } }), { status: 200 });
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const json = await (await POST(req({ gstin: GSTIN, save: false }))).json();
    log.mockRestore();
    expect(json.verification.details_last_updated).toBe("04/03/2026");
    expect(json.verification).not.toHaveProperty("last_return_filed");
  });
});
