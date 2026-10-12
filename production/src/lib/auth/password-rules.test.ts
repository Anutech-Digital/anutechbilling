import { describe, it, expect } from "vitest";
import { checkNewPassword, checkPasswordChange, PASSWORD_MIN_LENGTH } from "./password-rules";

const ok = (p: string, c?: string) => checkNewPassword(p, c) === null;
const msg = (p: string, c?: string) => checkNewPassword(p, c)?.message ?? "";

describe("checkNewPassword", () => {
  it("accepts an ordinary decent password", () => {
    expect(ok("chai-samosa-42")).toBe(true);
  });

  it("asks for something when the field is empty", () => {
    expect(msg("")).toMatch(/enter a new password/i);
  });

  it(`refuses anything under ${PASSWORD_MIN_LENGTH} characters`, () => {
    expect(ok("short7")).toBe(false);
    expect(ok("a".repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false);
  });

  it("refuses a trailing or leading space rather than trimming it", () => {
    /* Trimming silently would store a password different from the one they typed, and the
       next sign-in would fail with nothing on screen to explain it. */
    expect(msg("chai-samosa-42 ")).toMatch(/space/i);
    expect(msg(" chai-samosa-42")).toMatch(/space/i);
  });

  it("refuses company / product names (R-059: such passwords sat in this repo)", () => {
    expect(ok("Anutech@2025")).toBe(false);
    expect(ok("anutech digital 2025!")).toBe(false);
    expect(ok("MyResellerOS#99")).toBe(false);
    expect(ok("chai-samosa-42")).toBe(true);
  });

  it("refuses the usual guess-list entries whatever the case", () => {
    for (const p of ["password", "PASSWORD", "12345678", "Admin123", "welcome1"]) {
      expect(ok(p), p).toBe(false);
    }
  });

  it("refuses one character repeated", () => {
    expect(ok("aaaaaaaaaa")).toBe(false);
    expect(ok("::::::::::")).toBe(false);
  });

  it("catches a mismatched confirmation, and only when one was given", () => {
    expect(msg("chai-samosa-42", "chai-samosa-43")).toMatch(/do not match/i);
    expect(ok("chai-samosa-42", "chai-samosa-42")).toBe(true);
    /* No confirm passed at all — used by the field-level check while typing, before the
       second box has anything in it. */
    expect(ok("chai-samosa-42", undefined)).toBe(true);
  });

  it("reports the cheapest problem first, so the field never shows a wall of complaints", () => {
    /* Short AND banned AND repeated: the length message is the one that comes back. */
    expect(msg("aaa")).toMatch(new RegExp(String(PASSWORD_MIN_LENGTH)));
  });

  it("returns exactly one problem, never a list", () => {
    const out = checkNewPassword("aaa");
    expect(out).not.toBeNull();
    expect(Object.keys(out!)).toEqual(["message"]);
  });
});

describe("checkPasswordChange", () => {
  it("accepts a good, different password", () => {
    expect(checkPasswordChange("old-one-here", "chai-samosa-42")).toBeNull();
  });

  it("refuses the password they already have", () => {
    expect(checkPasswordChange("chai-samosa-42", "chai-samosa-42")?.message).toMatch(/already have/i);
  });

  it("judges the NEW password before comparing, so a weak one is named as weak", () => {
    /* Both faults at once: too short AND identical. The length message is the one that
       comes back, because being sent hunting for a typo in the old password when the real
       problem is the new one is the wrong hint. */
    expect(checkPasswordChange("abc", "abc")?.message).toMatch(new RegExp(String(PASSWORD_MIN_LENGTH)));
  });

  it("still applies every new-password rule", () => {
    expect(checkPasswordChange("whatever-old", "password")?.message).toMatch(/guess list/i);
    expect(checkPasswordChange("whatever-old", "chai-samosa-42 ")?.message).toMatch(/space/i);
  });
});