/**
 * What email_log is TOLD about each send.
 *
 * These tests exist because of one real production row:
 *
 *   provider=resend, status=failed, error="Gmail reauth_required: ..."
 *
 * The tenant was on Gmail. Gmail was attempted. Gmail failed. Resend never saw
 * the message — and the log said Resend. The cause was not the hardcoded
 * `provider: "resend"` on the blocked path that the handoff blamed; it was the
 * Gmail-failure return in `sendEmailInner` OMITTING `provider` entirely, and a
 * `?? "resend"` default at the log call filling in a confident wrong answer.
 *
 * So every assertion here is about the same question: does the row name the
 * transport this send was actually about? Getting that wrong does not lose mail,
 * it loses the ability to FIND lost mail — `where provider='gmail' and
 * status='failed'`, the query you run when a tenant says nothing is going out,
 * silently returns nothing.
 *
 * The log write is asserted through a mocked `recordEmail`, not by inspecting the
 * return value, because the return value is not what anyone reads later.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EmailLogEntry } from "./log";
import type { EmailSendResult } from "./send";
// R-541: imported statically, not with `await import("./send")` inside beforeEach. A dynamic
// import there made the FIRST test pay for loading send.ts and its whole graph (AI autonomy,
// transports, …) inside the 10s hook budget; under a full parallel `vitest run` that load
// queues behind every other file and timed out. A static import loads during collection, which
// has no per-test timeout. vi.mock calls are hoisted above it, so the doubles still apply.
import { sendEmail } from "./send";

// ── Doubles ───────────────────────────────────────────────────────────────────
// Every external edge is mocked: no network, no database, no Google.

const recorded: Array<{ entry: EmailLogEntry; result: EmailSendResult }> = [];

vi.mock("./log", () => ({
  recordEmail: vi.fn(async (entry: EmailLogEntry, result: EmailSendResult) => {
    recorded.push({ entry, result });
  }),
}));

const sendViaGmail = vi.fn();
vi.mock("./gmail-transport", () => ({
  sendViaGmail: (...args: unknown[]) => sendViaGmail(...args),
}));

/** What `routeForTenant` will read out of the `tenants` row. */
let tenantRow: { email_provider: string | null; gmail_sender_user_id: string | null } | null = null;
/** What it will read out of `user_google_tokens`. */
let tokenRow: Record<string, unknown> | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const data = table === "tenants" ? tenantRow : tokenRow;
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data, error: null }),
      };
      return chain;
    },
  }),
}));

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TENANT = "11111111-1111-1111-1111-111111111111";

/** A tenant on Gmail with a fully connected, send-capable account. */
function tenantOnGmail() {
  tenantRow = { email_provider: "gmail", gmail_sender_user_id: "user-1" };
  tokenRow = {
    access_token: "at-1",
    refresh_token: "rt-1",
    scopes: `openid email ${GMAIL_SEND_SCOPE}`,
    google_email: "owner@tenant.in",
  };
}

const msg = {
  to: "customer@example.com",
  subject: "Renewal due",
  text: "Your subscription renews soon.",
  kind: "renewal_reminder",
  route: { tenantId: TENANT, messageClass: "reminder" as const },
};

/** The single row this send produced in email_log. */
function loggedRow() {
  expect(recorded, "expected exactly one email_log write").toHaveLength(1);
  return recorded[0];
}

beforeEach(() => {
  recorded.length = 0;
  sendViaGmail.mockReset();
  tenantRow = null;
  tokenRow = null;
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── The regression ────────────────────────────────────────────────────────────

describe("a failed Gmail send is logged as Gmail", () => {
  it("does not blame Resend for a transport Resend never touched", async () => {
    tenantOnGmail();
    sendViaGmail.mockResolvedValue({
      ok: false,
      failure: "reauth_required",
      retryable: false,
      detail: "The stored Google token could not be refreshed.",
    });

    const result = await sendEmail(msg);

    // The exact production row, inverted.
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/^Gmail reauth_required:/);
    expect(result.provider).toBe("gmail");
    expect(loggedRow().entry.provider).toBe("gmail");
  });

  it("labels every Gmail failure mode as gmail, not just the one we saw", async () => {
    for (const failure of ["reauth_required", "scope_missing", "rate_limited", "rejected", "network"]) {
      recorded.length = 0;
      tenantOnGmail();
      sendViaGmail.mockResolvedValue({ ok: false, failure, retryable: false, detail: "…" });

      await sendEmail(msg);

      expect(loggedRow().entry.provider, failure).toBe("gmail");
    }
  });

  it("still labels a SUCCESSFUL Gmail send as gmail", async () => {
    tenantOnGmail();
    sendViaGmail.mockResolvedValue({ ok: true, messageId: "19ffc9c8fff7efe8" });

    const result = await sendEmail(msg);

    expect(result.status).toBe("sent");
    expect(loggedRow().entry.provider).toBe("gmail");
    expect(loggedRow().result.providerId).toBe("19ffc9c8fff7efe8");
  });
});

// ── The design call the handoff asked to settle ───────────────────────────────

describe("a blocked send names the provider the tenant CHOSE", () => {
  it("records gmail when the tenant is on Gmail and nothing can send", async () => {
    // Gmail selected but the account was never connected, AND no Resend key —
    // so no transport ran at all. Naming the fallback here would report a Gmail
    // problem as a Resend one.
    vi.stubEnv("RESEND_API_KEY", "");
    tenantRow = { email_provider: "gmail", gmail_sender_user_id: null };

    const result = await sendEmail(msg);

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/cannot be sent at all/);
    expect(loggedRow().entry.provider).toBe("gmail");
    expect(sendViaGmail).not.toHaveBeenCalled();
  });

  it("records resend when the tenant is on Resend and the key is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    tenantRow = { email_provider: "resend", gmail_sender_user_id: null };

    await sendEmail(msg);

    expect(loggedRow().entry.provider).toBe("resend");
  });
});

// ── The paths that were only accidentally right ───────────────────────────────

describe("the Resend and stub paths say so explicitly", () => {
  it("logs a silent fallback as resend, because Resend really did carry it", async () => {
    // Tenant asked for Gmail, the account cannot send, Resend IS configured.
    // Resend genuinely sent this one, so the row is truthful as resend.
    tenantRow = { email_provider: "gmail", gmail_sender_user_id: "user-1" };
    tokenRow = { access_token: null, refresh_token: null, scopes: null, google_email: null };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_abc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendEmail(msg);

    expect(result.status).toBe("sent");
    expect(loggedRow().entry.provider).toBe("resend");
    expect(sendViaGmail).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("logs stub mode as stub rather than as a Resend send", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    tenantRow = { email_provider: "resend", gmail_sender_user_id: null };
    // resendConfigured=false with requested=resend blocks, so use the no-route
    // path: no `route` means no tenant, and no tenant means no log row at all.
    // Stub mode is therefore asserted through the RESULT, which is what the
    // caller-side logs (renewal_email_log et al) still record.
    const result = await sendEmail({ to: "a@b.in", subject: "s", text: "t" });

    expect(result.status).toBe("stubbed");
    expect(result.provider).toBe("stub");
  });
});
