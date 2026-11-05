/**
 * R-2508 (R-2498 review, finding 6) — Reconnect to Zoho Books must not leave the OLD refresh
 * token alive at Zoho. After the new token is saved, the old one is revoked at Zoho's revoke
 * endpoint, best-effort: a failed revoke never loses the new connection, and no token is ever
 * written to a log. Zoho is never called — every dependency of the route is a mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const OLD = "1000.testonly-old-refresh.aaaa";
const NEW = "1000.testonly-new-refresh.bbbb";

const m = vi.hoisted(() => ({
  order: [] as string[],
  oldToken: null as string | null,
  readFails: false,
  saveFails: false,
  revoke: vi.fn(),
  exchange: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/integrations/zoho-books/config", async (orig) => ({
  ...(await orig<object>()),
  zohoBooksCreds: () => ({ clientId: "test-id", clientSecret: "test-secret" }),
}));
vi.mock("@/lib/integrations/zoho-books/state", () => ({ verifyState: () => ({ ok: true }) }));
vi.mock("@/lib/google/token-vault", () => ({ refuseConnectWithoutVault: () => false }));
vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => ({ admin: {}, tenantId: "t-acme", userId: "u-owner", role: "owner", canManage: true }),
  readConnection: async () => {
    m.order.push("read");
    if (m.readFails) throw new Error("Could not read the Zoho Books connection.");
    return { refreshToken: m.oldToken, orgId: null, orgName: null, connectedAt: null };
  },
  saveConnection: m.save,
}));
vi.mock("@/lib/integrations/zoho-books/api", async (orig) => ({
  ...(await orig<object>()),
  exchangeCode: m.exchange,
  revokeToken: m.revoke,
}));

import { GET } from "./route";

const call = () => GET(new NextRequest("http://localhost:3001/api/integrations/zoho-books/callback?code=good-code&state=s", {
  headers: { host: "localhost:3001", cookie: "zb_oauth_nonce=n" },
}));
const status = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("zoho");

let logs: string[] = [];
beforeEach(() => {
  m.order = []; m.oldToken = OLD; m.readFails = false; m.saveFails = false;
  m.exchange.mockReset().mockImplementation(async () => { m.order.push("exchange"); return { refreshToken: NEW }; });
  m.save.mockReset().mockImplementation(async () => {
    m.order.push("save");
    if (m.saveFails) throw new Error("Could not save the Zoho Books connection.");
  });
  m.revoke.mockReset().mockImplementation(async () => { m.order.push("revoke"); return true; });
  logs = [];
  for (const k of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  }
});
afterEach(() => { vi.restoreAllMocks(); });

const noTokenLogged = () => { for (const l of logs) { expect(l).not.toContain(OLD); expect(l).not.toContain(NEW); } };

describe("R-2508 — Reconnect revokes the old Zoho refresh token", () => {
  it("saves the new token first, then revokes the OLD one (not the new)", async () => {
    const res = await call();
    expect(status(res)).toBe("connected");
    expect(m.save).toHaveBeenCalledWith(expect.anything(), "t-acme", "u-owner", NEW);
    expect(m.revoke).toHaveBeenCalledTimes(1);
    expect(m.revoke.mock.calls[0][0]).toBe(OLD);
    expect(m.order.indexOf("save")).toBeLessThan(m.order.indexOf("revoke"));
    noTokenLogged();
  });

  it("revoke fails (false) → still connected with the new token, nothing secret logged", async () => {
    m.revoke.mockImplementation(async () => false);
    const res = await call();
    expect(status(res)).toBe("connected");
    expect(m.save).toHaveBeenCalledWith(expect.anything(), "t-acme", "u-owner", NEW);
    noTokenLogged();
  });

  it("revoke throws → still connected, nothing secret logged", async () => {
    m.revoke.mockImplementation(async () => { throw new Error(`revoke failed for ${OLD}`); });
    const res = await call();
    expect(status(res)).toBe("connected");
    noTokenLogged();
  });

  it("first connect (no old token) → no revoke", async () => {
    m.oldToken = null;
    expect(status(await call())).toBe("connected");
    expect(m.revoke).not.toHaveBeenCalled();
  });

  it("Zoho hands back the same token → it is not revoked", async () => {
    m.oldToken = NEW;
    expect(status(await call())).toBe("connected");
    expect(m.revoke).not.toHaveBeenCalled();
  });

  it("saving the new token fails → the old one is NOT revoked (the old connection keeps working)", async () => {
    m.saveFails = true;
    expect(status(await call())).toBe("error");
    expect(m.revoke).not.toHaveBeenCalled();
    noTokenLogged();
  });

  it("reading the old connection fails → the new one is still saved, no revoke", async () => {
    m.readFails = true;
    expect(status(await call())).toBe("connected");
    expect(m.save).toHaveBeenCalledTimes(1);
    expect(m.revoke).not.toHaveBeenCalled();
  });

  it("a code Zoho refuses → nothing read, saved or revoked", async () => {
    m.exchange.mockImplementation(async () => { throw new Error("invalid_code"); });
    expect(status(await call())).toBe("error");
    expect(m.save).not.toHaveBeenCalled();
    expect(m.revoke).not.toHaveBeenCalled();
  });
});
