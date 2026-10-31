// @vitest-environment jsdom
/**
 * R-2175 (checker FAIL 1): for a PERSONAL session GET /api/platform/whoami is a 403 — the
 * GP-07b middleware wall (R-2116) keeps every non-personal /api route shut, and whoami is
 * deliberately NOT added to PERSONAL_OPEN_API_PREFIXES (the personal API surface stays as
 * R-2117's ratchet lists it). The 403 lit the help "error was caught" badge on every personal
 * page. A personal workspace never gets the founder's platform nav, so useCurrentUser does not
 * ask: isPlatformAdmin is false without a request. Business roles still ask (unchanged).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let role = "owner";
const chain = () => {
  const row = { id: "u-1", tenant_id: "t-1", role, full_name: "A", initials: "A", color: null, can_view_deals: false, tenants: { name: "T" } };
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data: row, error: null });
  return c;
};
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1", email: "a@x.in", user_metadata: {} } } }) },
    from: () => chain(),
  }),
}));

import { useCurrentUser } from "./useCurrentUser";

const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ isPlatformAdmin: true }), { status: 200 }));
beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const whoamiCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/platform/whoami")).length;

describe("useCurrentUser and /api/platform/whoami (R-2175)", () => {
  it("a business role still asks whoami (founder nav unchanged)", async () => {
    role = "owner";
    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(whoamiCalls()).toBe(1);
    expect(result.current.data?.isPlatformAdmin).toBe(true);
  });

  it("a personal session never calls whoami (it is 403 there) and is not a platform admin", async () => {
    role = "personal";
    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(whoamiCalls()).toBe(0);
    expect(result.current.data?.isPlatformAdmin).toBe(false);
    expect(result.current.data?.role).toBe("personal");
  });
});
