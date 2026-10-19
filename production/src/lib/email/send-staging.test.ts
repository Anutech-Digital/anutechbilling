/**
 * R-1403 — sendEmail() on staging mails only the team; live is unchanged.
 * Every external edge is mocked: no network, no database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EmailLogEntry } from "./log";
import type { EmailSendResult } from "./send";
import { sendEmail } from "./send";

const recorded: Array<{ entry: EmailLogEntry; result: EmailSendResult }> = [];
vi.mock("./log", () => ({
  recordEmail: vi.fn(async (entry: EmailLogEntry, result: EmailSendResult) => {
    recorded.push({ entry, result });
  }),
}));
vi.mock("./gmail-transport", () => ({ sendViaGmail: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from() {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
      return chain;
    },
  }),
}));

const TENANT = "2b6f4c1e-8a3d-4f7a-9c21-5d0e7b3a9f14";
const base = { subject: "Invite", text: "Join us", kind: "team_invite", route: { tenantId: TENANT } };

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  recorded.length = 0;
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("SMTP_HOST", "");
  vi.stubEnv("STAGING_MAIL_ALLOWLIST", "");
  vi.stubEnv("APP_ENV", "");
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

function staging() {
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
}

describe("staging (R-1403)", () => {
  it("blocks a customer address: nothing reaches the provider, no error, logged masked", async () => {
    staging();
    const r = await sendEmail({ ...base, to: "rahul.customer@gmail.com" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.status).toBe("stubbed");
    expect(r.errorMessage).toMatch(/staging-allowlist/);
    expect(recorded[0].result.status).toBe("stubbed");
    const line = String(warn.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("staging-allowlist");
    expect(line).toContain("r***@gmail.com");
    expect(line).not.toContain("rahul.customer");
  });

  it("lets an @anutech.in address through to the provider", async () => {
    staging();
    const r = await sendEmail({ ...base, to: "pardeep@anutech.in" });
    expect(r.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets a named test address from STAGING_MAIL_ALLOWLIST through", async () => {
    staging();
    vi.stubEnv("STAGING_MAIL_ALLOWLIST", "qa.tester@gmail.com, @anutech.test");
    expect((await sendEmail({ ...base, to: "QA.Tester@gmail.com" })).status).toBe("sent");
    expect((await sendEmail({ ...base, to: "x@anutech.test" })).status).toBe("sent");
    expect((await sendEmail({ ...base, to: "other@gmail.com" })).status).toBe("stubbed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a mixed list sends only to the allowed recipient", async () => {
    staging();
    await sendEmail({ ...base, to: "a@anutech.in, client@corp.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body));
    expect(JSON.stringify(body.to)).toContain("a@anutech.in");
    expect(JSON.stringify(body.to)).not.toContain("client@corp.com");
  });

  it("fails closed: an unreadable allowlist blocks even @anutech.in", async () => {
    staging();
    vi.stubEnv("STAGING_MAIL_ALLOWLIST", "not-an-address");
    const r = await sendEmail({ ...base, to: "pardeep@anutech.in" });
    expect(r.status).toBe("stubbed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("detects staging from the app URL too", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://resellersos-staging-abc-as.a.run.app");
    await sendEmail({ ...base, to: "rahul@gmail.com" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("live is unaffected", () => {
  it("sends to any customer address exactly as before", async () => {
    const r = await sendEmail({ ...base, to: "rahul.customer@gmail.com" });
    expect(r.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
