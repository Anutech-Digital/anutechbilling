import { describe, expect, test } from "vitest";
import { base32Decode, base32Encode, codeAt, matchStep, newSecret, otpauthUri, stepAt } from "./totp";

// RFC 6238 Appendix B test vectors (SHA-1, secret "12345678901234567890"), last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const VECTORS: [number, string][] = [
  [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
  [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
];

describe("TOTP", () => {
  test.each(VECTORS)("RFC 6238 vector at t=%i → %s", (t, code) => {
    expect(codeAt(RFC_SECRET, stepAt(t * 1000))).toBe(code);
  });

  test("base32 round-trips", () => {
    const s = newSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
  });

  test("accepts the current code and one step of drift, nothing further", () => {
    const s = newSecret();
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(matchStep(s, codeAt(s, step), now)).toBe(step);
    expect(matchStep(s, codeAt(s, step - 1), now)).toBe(step - 1);
    expect(matchStep(s, codeAt(s, step + 1), now)).toBe(step + 1);
    expect(matchStep(s, codeAt(s, step - 3), now)).toBeNull();
  });

  test("rejects malformed codes", () => {
    const s = newSecret();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 456"]) expect(matchStep(s, bad)).toBeNull();
  });

  test("otpauth URI carries the secret and issuer", () => {
    expect(otpauthUri("ABC", "a@b.in")).toBe("otpauth://totp/ResellerOS%3Aa%40b.in?secret=ABC&issuer=ResellerOS&algorithm=SHA1&digits=6&period=30");
  });
});
