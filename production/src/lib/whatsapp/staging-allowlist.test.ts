/** R-1403 — sendWhatsApp() on staging reaches only STAGING_PHONE_ALLOWLIST; live unchanged. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
const credsLookups = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    credsLookups();
    const chain = {
      select: () => chain, eq: () => chain, insert: () => chain, update: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
    };
    return { from: () => chain };
  },
}));

import { sendWhatsApp } from "./client";
import { WhatsAppNotConfiguredError } from "./send-failure";

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  credsLookups.mockReset();
  vi.stubEnv("APP_ENV", "");
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "");
  vi.stubEnv("STAGING_MAIL_ALLOWLIST", "");
  vi.stubEnv("STAGING_PHONE_ALLOWLIST", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

const send = () => sendWhatsApp({ tenantId: "t1", to: "+91 98765 43210", message: { kind: "text", text: "hi" } });

describe("sendWhatsApp staging guard", () => {
  it("staging: a customer number is dropped before creds, Meta or the outbox row", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    const r = await send();
    expect(r.status).toBe("failed");
    expect(r.wamid).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(credsLookups).not.toHaveBeenCalled();
    const line = String(warn.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("+91 *******210");
    expect(line).not.toContain("9876543210");
  });

  it("staging: a listed test number goes on to the normal path", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    vi.stubEnv("STAGING_PHONE_ALLOWLIST", "9876543210");
    // No creds in the mocked DB → the ordinary "not configured" error proves it got past the guard.
    await expect(send()).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
  });

  it("live: unaffected — goes straight to the normal path", async () => {
    await expect(send()).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
    expect(warn).not.toHaveBeenCalled();
  });
});
