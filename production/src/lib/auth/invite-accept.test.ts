/** R-733 — invite expiry + mapping accept_team_invite's refusals to §24 answers. */
import { describe, it, expect } from "vitest";
import {
  INVITE_EXPIRED_MESSAGE, INVITE_USED_MESSAGE, inviteAcceptRefusal, inviteExpiresAt, isInviteExpired,
} from "./invite-accept";

const NOW = new Date("2026-10-19T00:00:00Z");

describe("isInviteExpired", () => {
  it("past → expired, future → not", () => {
    expect(isInviteExpired("2026-10-18T23:59:59Z", NOW)).toBe(true);
    expect(isInviteExpired("2026-10-19T00:00:01Z", NOW)).toBe(false);
  });
  it("exactly now counts as expired (SQL: expires_at > now())", () => {
    expect(isInviteExpired("2026-10-19T00:00:00Z", NOW)).toBe(true);
  });
  it("missing value is left to the database", () => {
    expect(isInviteExpired(null, NOW)).toBe(false);
    expect(isInviteExpired(undefined, NOW)).toBe(false);
  });
});

it("inviteExpiresAt is 7 days out", () => {
  expect(inviteExpiresAt(NOW)).toBe("2026-10-26T00:00:00.000Z");
});

describe("inviteAcceptRefusal — the SQL messages", () => {
  it("expired → 410 with a next step", () => {
    const r = inviteAcceptRefusal("This invite expired on 18 Oct 2026. Ask the workspace owner…");
    expect(r).toEqual({ status: 410, error: INVITE_EXPIRED_MESSAGE });
    expect(r.error).toMatch(/Team → Invite member/);
  });
  it("already used → 409", () => {
    expect(inviteAcceptRefusal("This invite has already been used. Sign in…")).toEqual({ status: 409, error: INVITE_USED_MESSAGE });
  });
  it("wrong token → 404", () => {
    expect(inviteAcceptRefusal("This invite link is not valid for this email.").status).toBe(404);
  });
  it("anything else → 500, says nothing was saved, never echoes the raw error", () => {
    const r = inviteAcceptRefusal('duplicate key value violates unique constraint "users_pkey"');
    expect(r.status).toBe(500);
    expect(r.error).toMatch(/nothing was saved/);
    expect(r.error).not.toContain("users_pkey");
  });
});
