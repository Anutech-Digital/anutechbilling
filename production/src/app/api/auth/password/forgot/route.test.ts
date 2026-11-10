/**
 * R-2600 — POST /api/auth/password/forgot (Auth.js path, staging/live) builds the reset link
 * from trustedOrigin: a forged Host / X-Forwarded-Host and a client-sent redirect are ignored,
 * so the mailed link is always on the app's own URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const sendRecoveryLink = vi.fn(async (_email: string, _origin: string) => {});
vi.mock("@/server/auth/recovery", () => ({ sendRecoveryLink: (e: string, o: string) => sendRecoveryLink(e, o) }));
vi.mock("@/server/auth/http", async (orig) => {
  const real = await orig<typeof import("@/server/auth/http")>();
  return { ...real, authjsOff: () => null, limited: async () => null };
});

import { POST } from "./route";

function req(headers: Record<string, string>, body: unknown): NextRequest {
  return new NextRequest("https://evil.tld/api/auth/password/forgot", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("R-2600 /api/auth/password/forgot — link origin", () => {
  beforeEach(() => {
    sendRecoveryLink.mockClear();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("forged Host + X-Forwarded-Host + a client redirect → link still on the app URL", async () => {
    const res = await POST(req(
      { host: "evil.tld", "x-forwarded-host": "evil.tld", "x-forwarded-proto": "http" },
      { email: "victim@corp.test", redirectTo: "https://evil.tld/steal", origin: "https://evil.tld" },
    ));
    expect(res.status).toBe(200);
    expect(sendRecoveryLink).toHaveBeenCalledTimes(1);
    expect(sendRecoveryLink.mock.calls[0]).toEqual(["victim@corp.test", "https://reselleros.anutech.in"]);
  });

  it("[::1] in production is not the app either", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await POST(req({ host: "[::1]:3001" }, { email: "victim@corp.test" }));
    expect(sendRecoveryLink.mock.calls[0][1]).toBe("https://reselleros.anutech.in");
  });

  it("same answer and no mail for a non-email", async () => {
    const res = await POST(req({ host: "evil.tld" }, { email: "nope" }));
    expect(res.status).toBe(200);
    expect(sendRecoveryLink).not.toHaveBeenCalled();
  });
});
