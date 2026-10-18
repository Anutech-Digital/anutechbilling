import { describe, it, expect } from "vitest";
import { maskEmail, maskPhone, maskContactValue, redactContacts } from "./redact-contact";

describe("R-1610 — redact-contact", () => {
  it("masks an email to first letter + domain", () => {
    expect(maskEmail("pardeep@anutech.in")).toBe("p***@anutech.in");
    expect(maskEmail("  A.B@Example.co.in ")).toBe("A***@Example.co.in");
    expect(maskEmail("")).toBe("(none)");
    expect(maskEmail("not-an-email")).toBe("***");
  });

  it("masks a phone to country code, first two and the tail", () => {
    expect(maskPhone("+91 98765 43210")).toBe("+91 98***43210");
    expect(maskPhone("919876543210")).toBe("+91 98***43210");
    expect(maskPhone("9876543210")).toBe("98***43210");
    expect(maskPhone("123")).toBe("***");
  });

  it("picks the mask by shape, and masks a list item by item", () => {
    expect(maskContactValue("pardeep@anutech.in")).toBe("p***@anutech.in");
    expect(maskContactValue("+919876543210")).toBe("+91 98***43210");
    expect(maskContactValue(["a@x.in", "bob@y.com"])).toBe("a***@x.in, b***@y.com");
    expect(maskContactValue(null)).toBe("(none)");
  });

  it("never leaves the full value in the output", () => {
    for (const v of ["pardeep@anutech.in", "+91 98765 43210", "9876543210"]) {
      expect(maskContactValue(v)).not.toContain(v.replace(/\s/g, ""));
      expect(maskContactValue(v).replace(/\D/g, "")).not.toContain("9876543210");
    }
  });

  it("redacts contacts inside free text, keeping the rest", () => {
    const out = redactContacts("550 5.1.1 <pardeep@anutech.in>: mailbox unavailable; call +91 98765 43210 (id Q-12)");
    expect(out).toBe("550 5.1.1 <p***@anutech.in>: mailbox unavailable; call +91 98***43210 (id Q-12)");
    expect(redactContacts(undefined)).toBe("");
  });
});
