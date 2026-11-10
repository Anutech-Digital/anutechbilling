/**
 * R-2639: a customer's phone gets the dialling code of the customer's country — never +91 for
 * an overseas customer, and never a second code on a number that already has one.
 */
import { describe, it, expect } from "vitest";
import { DIAL_CODES, dialCodeForCountry, formatInternationalPhone, isIndiaPhoneCountry, phoneDigitsForCountry, phoneE164ForCountry } from "./phone";
import { COUNTRIES, countryIsoCode } from "./gst/countries";
import { toWhatsAppDigits } from "./utils";
import { formatWhatsAppPhone, invoiceWhatsAppTarget } from "./whatsapp";

describe("dialCodeForCountry", () => {
  it("India and empty country → 91", () => {
    expect(dialCodeForCountry("India")).toBe("91");
    expect(dialCodeForCountry("")).toBe("91");
    expect(dialCodeForCountry(null)).toBe("91");
    expect(dialCodeForCountry(undefined)).toBe("91");
    expect(dialCodeForCountry("Bharat")).toBe("91");
  });
  it("overseas countries by name, alias or ISO code", () => {
    expect(dialCodeForCountry("United States")).toBe("1");
    expect(dialCodeForCountry("USA")).toBe("1");
    expect(dialCodeForCountry("Canada")).toBe("1");
    expect(dialCodeForCountry("Cayman Islands")).toBe("1");
    expect(dialCodeForCountry("United Kingdom")).toBe("44");
    expect(dialCodeForCountry("Estonia")).toBe("372");
    expect(dialCodeForCountry("EE")).toBe("372");
    expect(dialCodeForCountry("UAE")).toBe("971");
    expect(dialCodeForCountry("Singapore")).toBe("65");
    expect(dialCodeForCountry("Australia")).toBe("61");
  });
  it("unknown text → null", () => {
    expect(dialCodeForCountry("Atlantis")).toBeNull();
  });
  it("every country in the picker has a dialling code (the two lists cannot drift)", () => {
    const missing = COUNTRIES.filter((c) => { const iso = countryIsoCode(c); return !iso || !DIAL_CODES[iso]; });
    expect(missing).toEqual([]);
  });
});

describe("phoneDigitsForCountry (card doneWhen)", () => {
  it("US customer 5551234567 → 15551234567", () => {
    expect(phoneDigitsForCountry("5551234567", "United States")).toBe("15551234567");
    expect(phoneE164ForCountry("(555) 123-4567", "USA")).toBe("+15551234567");
  });
  it("India 9876543210 → 919876543210", () => {
    expect(phoneDigitsForCountry("9876543210", "India")).toBe("919876543210");
    expect(phoneDigitsForCountry("9876543210", null)).toBe("919876543210");
    expect(phoneE164ForCountry("98765 43210", "")).toBe("+919876543210");
  });
  it("a number that already has a country code is kept as it is", () => {
    expect(phoneDigitsForCountry("+44 20 7946 0958", "India")).toBe("442079460958");
    expect(phoneDigitsForCountry("+44 7911 123456", "United States")).toBe("447911123456");
    expect(phoneDigitsForCountry("0044 7911 123456", "")).toBe("447911123456");
    expect(phoneDigitsForCountry("+91 98765 43210", "United States")).toBe("919876543210");
    expect(phoneDigitsForCountry("447911123456", "United Kingdom")).toBe("447911123456");
    expect(phoneDigitsForCountry("15551234567", "United States")).toBe("15551234567");
    expect(phoneDigitsForCountry("919876543210", "India")).toBe("919876543210");
    expect(phoneDigitsForCountry("971501234567", "United Arab Emirates")).toBe("971501234567");
  });
  it("an Indian mobile that starts with 91 is still a bare 10-digit number", () => {
    // The old quote page took "91…" as the country code and sent it to +91234…
    expect(phoneDigitsForCountry("9123456789", "India")).toBe("919123456789");
    expect(phoneDigitsForCountry("9123456789", "")).toBe("919123456789");
  });
  it("local trunk 0 is dropped before the code", () => {
    expect(phoneDigitsForCountry("07911 123456", "United Kingdom")).toBe("447911123456");
    expect(phoneDigitsForCountry("050 123 4567", "United Arab Emirates")).toBe("971501234567");
    expect(phoneDigitsForCountry("09876543210", "India")).toBe("919876543210");
    expect(phoneDigitsForCountry("5123 4567", "Estonia")).toBe("37251234567");
  });
  it("short local numbers of small countries", () => {
    expect(phoneDigitsForCountry("9123 4567", "Singapore")).toBe("6591234567");
    expect(phoneDigitsForCountry("6591234567", "Singapore")).toBe("6591234567");
  });
  it("country text we cannot read keeps the old India rule (no regression for messy imports)", () => {
    expect(phoneDigitsForCountry("9876543210", "Inida")).toBe("919876543210");
    expect(phoneDigitsForCountry("09876543210", "Delhi")).toBe("919876543210");
  });
  it("a national number that happens to start with the code digits still gets the code", () => {
    expect(phoneDigitsForCountry("3931234567", "Italy")).toBe("393931234567");
    expect(phoneDigitsForCountry("393931234567", "Italy")).toBe("393931234567");
    expect(phoneDigitsForCountry("55991234567", "Brazil")).toBe("5555991234567");
    expect(phoneDigitsForCountry("5511991234567", "Brazil")).toBe("5511991234567");
    expect(phoneDigitsForCountry("7011234567", "Kazakhstan")).toBe("77011234567");
  });
  it("Russia / Kazakhstan trunk 8 is dropped", () => {
    expect(phoneDigitsForCountry("8 916 123 4567", "Russia")).toBe("79161234567");
    expect(phoneDigitsForCountry("8 701 123 4567", "Kazakhstan")).toBe("77011234567");
    expect(phoneDigitsForCountry("79161234567", "Russia")).toBe("79161234567");
  });
  it("nothing usable → null", () => {
    expect(phoneDigitsForCountry("", "India")).toBeNull();
    expect(phoneDigitsForCountry(null, "India")).toBeNull();
    expect(phoneDigitsForCountry("12345", "India")).toBeNull();
    expect(phoneE164ForCountry("abc", "India")).toBe("");
  });
});

describe("the WhatsApp helpers use the country", () => {
  it("toWhatsAppDigits: old India behaviour without a country, country code with one", () => {
    expect(toWhatsAppDigits("9876543210")).toBe("919876543210");
    expect(toWhatsAppDigits("5551234567", "United States")).toBe("15551234567");
    expect(toWhatsAppDigits("+1 555 123 4567", "India")).toBe("15551234567");
  });
  it("formatWhatsAppPhone: same rule", () => {
    expect(formatWhatsAppPhone("9876543210")).toBe("919876543210");
    expect(formatWhatsAppPhone("5551234567", "Canada")).toBe("15551234567");
  });
  it("invoice reminder goes to the invoice's customer country", () => {
    const t = invoiceWhatsAppTarget(
      { id: "INV-1", customer_name: "Woollyes", customer_country: "United States", total_amount: 100, due_date: "2026-11-30" } as never,
      "5551234567",
      null,
    );
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url).toContain("wa.me/15551234567");
  });
});

describe("formatInternationalPhone (R-2645)", () => {
  it("groups US/India, else code + number", () => {
    expect(formatInternationalPhone("15551234567")).toBe("+1 555 123 4567");
    expect(formatInternationalPhone("919876543210")).toBe("+91 98765 43210");
    expect(formatInternationalPhone("447911123456")).toBe("+44 7911123456");
    expect(formatInternationalPhone("971501234567")).toBe("+971 501234567");
  });
  it("India / empty / unreadable country keeps the old +91 rule", () => {
    for (const c of [null, undefined, "", "India", "IN", "Inida"]) expect(isIndiaPhoneCountry(c)).toBe(true);
    for (const c of ["United States", "USA", "United Kingdom"]) expect(isIndiaPhoneCountry(c)).toBe(false);
  });
});
