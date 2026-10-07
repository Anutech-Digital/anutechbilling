/** R-361: mail to `.invalid` (demo data's addresses) is refused before any provider. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isUndeliverableAddress } from "./reserved-address";

describe("isUndeliverableAddress", () => {
  it("catches .invalid in every shape a caller passes", () => {
    expect(isUndeliverableAddress("rohit.delhi@example.invalid")).toBe(true);
    expect(isUndeliverableAddress("ROHIT@EXAMPLE.INVALID")).toBe(true);
    expect(isUndeliverableAddress("Rohit Mehra <rohit@example.invalid>")).toBe(true);
    expect(isUndeliverableAddress("a@b.in, rohit@example.invalid")).toBe(true);
    expect(isUndeliverableAddress(["a@b.in", "x@foo.invalid"])).toBe(true);
    expect(isUndeliverableAddress("x@invalid")).toBe(true);
    expect(isUndeliverableAddress("x@example.invalid.")).toBe(true);
  });

  it("leaves real and ordinary test addresses alone", () => {
    for (const a of ["pardeep@anutech.in", "a@example.com", "x@invalid.in", "x@notinvalid.com", "invalid@gmail.com", "", null, undefined, []]) {
      expect(isUndeliverableAddress(a as string), String(a)).toBe(false);
    }
  });
});

describe("sendEmail uses it before the provider", () => {
  const src = readFileSync(join(__dirname, "send.ts"), "utf8");
  it("checks the address before sendEmailInner and records the refusal", () => {
    const check = src.indexOf("isUndeliverableAddress(msg.to)");
    expect(check).toBeGreaterThan(0);
    const inner = src.indexOf("await sendEmailInner(msg)");
    expect(check).toBeLessThan(inner);
    // the refusal flows into the same recordEmail call as a real send
    expect(src.slice(check, check + 600)).toMatch(/recordEmail\(/);
  });
});
