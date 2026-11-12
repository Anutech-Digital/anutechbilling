/**
 * R-2696 — a send that must NOT use the tenant's own mail route (the R-2517 membership-invite
 * email) still leaves an email_log row for that tenant, and a Resend refusal is written to the
 * server log with the provider's reason.
 *
 * Measured on staging 12 Nov 2026: two invites to an existing login answered 502 and email_log had
 * NO row — recordEmail skips a row without tenantId, and that send carries no `route` on purpose.
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
const gmail = vi.hoisted(() => vi.fn());
vi.mock("./gmail-transport", () => ({ sendViaGmail: gmail }));
const tenantReads = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from() {
      tenantReads.n++;
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
      return chain;
    },
  }),
}));

const TENANT = "2b6f4c1e-8a3d-4f7a-9c21-5d0e7b3a9f14";
const base = { subject: "Invite", text: "Join us", kind: "team_invite", to: "pratik@example.com" };

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  recorded.length = 0;
  tenantReads.n = 0;
  gmail.mockReset();
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

describe("R-2696: logTenantId", () => {
  it("logs the row under that tenant without using the tenant's mail route", async () => {
    const r = await sendEmail({ ...base, logTenantId: TENANT });
    expect(r.status).toBe("sent");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].entry.tenantId).toBe(TENANT);
    expect(recorded[0].entry.kind).toBe("team_invite");
    /* platform sender, not the tenant's route: no tenant lookup, no Gmail */
    expect(tenantReads.n).toBe(0);
    expect(gmail).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a Resend refusal is logged with the provider's reason", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ statusCode: 403, message: "You can only send testing emails to your own email address (owner@anutech.in)." }),
      { status: 403 },
    ));
    const r = await sendEmail({ ...base, logTenantId: TENANT });
    expect(r.status).toBe("failed");
    expect(recorded[0].entry.tenantId).toBe(TENANT);
    expect(recorded[0].result.errorMessage).toMatch(/Resend 403: .*only send testing emails/);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("resend FAILED"));
    expect(line).toBeDefined();
    expect(line).toMatch(/403/);
    expect(line).toMatch(/only send testing emails/);
    /* recipient masked in the server log */
    expect(line).not.toContain("pratik@example.com");
  });

  it("keeps Resend's whole test-mode refusal (≈250 chars) as parseable JSON", async () => {
    const body = JSON.stringify({ statusCode: 403, message: "You can only send testing emails to your own email address (owner@anutech.in). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.", name: "validation_error" });
    expect(body.length).toBeGreaterThan(200);
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 403 }));
    const r = await sendEmail({ ...base, logTenantId: TENANT });
    expect(r.errorMessage).toBe(`Resend 403: ${body}`);
  });

  it("route.tenantId still wins when both are given", async () => {
    await sendEmail({ ...base, route: { tenantId: TENANT }, logTenantId: "99999999-9999-4999-8999-999999999999" });
    expect(recorded[0].entry.tenantId).toBe(TENANT);
  });

  it("without either, nothing changes (no row — recordEmail's own rule)", async () => {
    await sendEmail({ ...base });
    expect(recorded[0].entry.tenantId).toBeNull();
  });
});
