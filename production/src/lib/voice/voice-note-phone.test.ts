import { describe, it, expect } from "vitest";
import { hasPhone, noPhoneNotice, NO_PHONE_CODE, NO_PHONE_STATUS } from "./voice-note-phone";

describe("R-1452 voice-note phone check", () => {
  it("hasPhone: blank / missing is no phone; digits are a phone", () => {
    expect(hasPhone(null)).toBe(false);
    expect(hasPhone(undefined)).toBe(false);
    expect(hasPhone("")).toBe(false);
    expect(hasPhone("  ")).toBe(false);
    expect(hasPhone("+91 98765 43210")).toBe(true);
  });

  it("noPhoneNotice gives what happened, why + next step, and the customer link", () => {
    const n = noPhoneNotice("c 1", "Ravi Traders");
    expect(n.code).toBe(NO_PHONE_CODE);
    expect(n.error).toBe("No phone number for this customer — add one");
    expect(n.description).toContain("Ravi Traders");
    expect(n.description).toContain("Nothing was sent");
    expect(n.href).toBe("/customers/c%201");
    expect(n.actionLabel).toBe("Open customer");
    expect(NO_PHONE_STATUS).toBeGreaterThanOrEqual(400);
    expect(NO_PHONE_STATUS).not.toBe(400);
  });
});
