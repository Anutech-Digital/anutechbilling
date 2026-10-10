import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ status: "sent", providerId: "x", errorMessage: null })) }));
import { hashToken, newToken, verifyLink, verificationEmail, confirmEmailToken, startEmailVerification } from "./email-verification";
import { sendEmail } from "@/lib/email/send";

/** A tiny fake of the admin client: one email_verifications table + auth.admin.updateUserById. */
function fakeAdmin(rows: Array<Record<string, unknown>> = []) {
  const confirmed: string[] = [];
  const table = {
    insert: async (r: Record<string, unknown>) => { rows.push({ id: String(rows.length + 1), used_at: null, ...r }); return { error: null }; },
    select: () => ({
      eq: (_c: string, v: string) => ({ maybeSingle: async () => ({ data: rows.find((r) => r.token_hash === v) ?? null, error: null }) }),
    }),
    update: (patch: Record<string, unknown>) => ({ eq: async (_c: string, id: string) => { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, patch); return { error: null }; } }),
  };
  const admin = {
    from: () => table,
    auth: { admin: { updateUserById: async (id: string) => { confirmed.push(id); return { error: null }; } } },
  };
  return { admin: admin as never, rows, confirmed };
}

describe("email verification (R-048)", () => {
  it("tokens are random and only their hash is stored", async () => {
    expect(newToken()).not.toBe(newToken());
    const f = fakeAdmin();
    await startEmailVerification(f.admin, { userId: "u1", email: "a@x.in", name: "Asha Rao", origin: "https://app.x.in/" });
    expect(f.rows).toHaveLength(1);
    expect(String(f.rows[0].token_hash)).toMatch(/^[0-9a-f]{64}$/);
    const sent = vi.mocked(sendEmail).mock.calls.at(-1)![0];
    expect(sent.to).toBe("a@x.in");
    const token = decodeURIComponent(sent.text.match(/token=([^\s]+)/)![1]);
    expect(hashToken(token)).toBe(f.rows[0].token_hash);
    expect(sent.text).not.toContain(String(f.rows[0].token_hash));
  });

  it("a good token confirms once; a second use is refused", async () => {
    const t = newToken();
    const f = fakeAdmin([{ id: "1", user_id: "u1", email: "a@x.in", token_hash: hashToken(t), expires_at: new Date(Date.now() + 3600_000).toISOString(), used_at: null }]);
    expect(await confirmEmailToken(f.admin, t)).toMatchObject({ ok: true, email: "a@x.in" });
    expect(f.confirmed).toEqual(["u1"]);
    expect(await confirmEmailToken(f.admin, t)).toEqual({ ok: false, reason: "used" });
    expect(f.confirmed).toEqual(["u1"]);
  });

  it("expired, unknown and junk tokens never confirm anyone", async () => {
    const t = newToken();
    const f = fakeAdmin([{ id: "1", user_id: "u1", email: "a@x.in", token_hash: hashToken(t), expires_at: new Date(Date.now() - 1000).toISOString(), used_at: null }]);
    expect(await confirmEmailToken(f.admin, t)).toEqual({ ok: false, reason: "expired" });
    expect(await confirmEmailToken(f.admin, newToken())).toEqual({ ok: false, reason: "invalid" });
    expect(await confirmEmailToken(f.admin, "")).toEqual({ ok: false, reason: "invalid" });
    expect(f.confirmed).toEqual([]);
  });

  it("the link and the mail say what to do", () => {
    expect(verifyLink("https://app.x.in/", "a b")).toBe("https://app.x.in/verify-email?token=a%20b");
    const m = verificationEmail("<b>Ravi</b> Kumar", "https://app.x.in/verify-email?token=t");
    expect(m.subject).toMatch(/confirm/i);
    expect(m.html).not.toContain("<b>Ravi</b>");
    expect(m.text).toContain("48 hours");
  });
});
