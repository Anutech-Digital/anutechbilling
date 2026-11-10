import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashInviteLinkToken, inviteAcceptUrl, newInviteLinkToken } from "./invite-link-token";
import { inviteTokenShapeOk } from "./invite-link-request";

describe("R-2517 invite link token", () => {
  it("makes a fresh 43-char base64url token and its sha256 hex", () => {
    const a = newInviteLinkToken();
    const b = newInviteLinkToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(createHash("sha256").update(a.token).digest("hex"));
    expect(a.hash).not.toContain(a.token);
  });

  it("hashes like public.r2517_token_hash (sha256 of the UTF-8 text, hex)", () => {
    // same value the SQL test computes: encode(sha256(convert_to(tok,'UTF8')),'hex')
    expect(hashInviteLinkToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("accepts only the token shape the database hashes", () => {
    expect(inviteTokenShapeOk(newInviteLinkToken().token)).toBe(true);
    for (const bad of ["", "short", "has spaces in it but is long enough to pass", "a".repeat(129), null, 42, undefined]) {
      expect(inviteTokenShapeOk(bad)).toBe(false);
    }
  });

  it("builds the email link on the trusted origin, token in the fragment (never sent to the server)", () => {
    expect(inviteAcceptUrl("https://app.example", "Ab_-9".repeat(9))).toBe(`https://app.example/invites/accept#token=${"Ab_-9".repeat(9)}`);
  });
});

describe("R-2517 inviteTokenFromLocation (accept page)", () => {
  it("reads #token=… (the email link), falls back to ?token=…, trims", async () => {
    const { inviteTokenFromLocation } = await import("./company-invites");
    expect(inviteTokenFromLocation("#token=Abc_def", "")).toBe("Abc_def");
    expect(inviteTokenFromLocation("", "?token=Old-link_1")).toBe("Old-link_1");
    expect(inviteTokenFromLocation("#token=fromHash", "?token=fromQuery")).toBe("fromHash");
    expect(inviteTokenFromLocation("", "")).toBe("");
    expect(inviteTokenFromLocation("#other=1", "")).toBe("");
  });
});
