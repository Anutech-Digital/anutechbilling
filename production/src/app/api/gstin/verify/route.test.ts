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
    secretsRow = { sandbox_api_key: "k", sandbox_api_secret: "s", sandbox_api_base: "https://sandbox.invalid" };
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
