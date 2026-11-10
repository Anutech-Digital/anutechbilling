import { describe, it, expect } from "vitest";
import {
  liveGstin, checkGstin, gstinState,
  livePhone, commitPhone, checkPhone, recommitPhoneForCountry,
  liveDomain, checkDomain,
  liveMoney, parseMoney, commitMoney, checkMoney,
  liveEmail, checkEmail, companyDomainFromEmail,
} from "./poka-yoke";
import { GST_STATE_BY_CODE } from "@/lib/utils";

/** ANUTECH's own — Delhi, checksum-valid. See CLAUDE.md §1. */
const REAL_GSTIN = "07ABDCA0298H1ZP";

/**
 * ─── THE RULE THAT MATTERS MOST ─────────────────────────────────────────────
 * A field that refuses a keystroke because the value is not finished yet is unusable.
 * Nobody types the tenth digit of a phone number first.
 */
describe("live formatting never blocks a half-typed value", () => {
  it("accepts every prefix of a real GSTIN", () => {
    for (let i = 1; i <= REAL_GSTIN.length; i++) {
      const typed = REAL_GSTIN.slice(0, i);
      expect(liveGstin(typed)).toBe(typed);
    }
  });

  it("accepts every prefix of a real mobile", () => {
    const full = "9876543210";
    for (let i = 1; i <= full.length; i++) {
      expect(livePhone(full.slice(0, i))).toBe(full.slice(0, i));
    }
  });

  it("does not insert spaces into a phone while it is being typed", () => {
    /* Grouping mid-type is what moves the caret out from under the finger. */
    expect(livePhone("98765")).toBe("98765");
    expect(livePhone("987654")).toBe("987654");
  });

  it("calls a half-typed value 'typing', never an error", () => {
    /* A form that greets you by shouting is a form people stop reading. */
    expect(checkGstin("07ABD").tone).toBe("typing");
    expect(checkPhone("98765").tone).toBe("typing");
    expect(checkEmail("pardeep").tone).toBe("typing");
  });

  it("an untouched field is 'empty' — not wrong", () => {
    for (const check of [checkGstin, checkPhone, checkDomain, checkMoney, checkEmail]) {
      expect(check("").tone).toBe("empty");
      expect(check("   ").tone).toBe("empty");
    }
  });
});

describe("GSTIN", () => {
  it("upper-cases and strips the spaces a PDF paste brings", () => {
    expect(liveGstin(" 07abdca 0298h1zp ")).toBe(REAL_GSTIN);
  });

  it("accepts the real one and names its state", () => {
    const c = checkGstin(REAL_GSTIN);
    expect(c.tone).toBe("ok");
    expect(c.detail).toBe("Delhi");
    expect(gstinState(REAL_GSTIN)).toEqual({ code: "07", name: "Delhi" });
  });

  /**
   * The checksum is the whole point. A 15-character string of the right SHAPE is exactly
   * what a typo produces, and lib/gst/gstin-state.ts refuses to let one decide a tax head.
   */
  it("rejects a 15-character string whose check digit is wrong, and says so", () => {
    const typo = "07ABDCA0298H1ZQ";           // last character changed
    const c = checkGstin(typo);
    expect(c.tone).toBe("error");
    expect(c.message).toMatch(/check digit|mistyped/i);
    expect(gstinState(typo)).toBeNull();
  });

  it("names the real fault when the STATE CODE is impossible", () => {
    /* Telling them the first two characters are not a state beats "invalid GSTIN" — it
       points at the two characters to look at.

       The code is DERIVED from the map rather than hardcoded, because my first attempt
       used "99" and "99" turns out to be a real entry (Centre Jurisdiction). A test that
       asserts a fact about a lookup table should ask the table. */
    const bogus = ["00", "80", "90", "58", "70"].find((c) => !GST_STATE_BY_CODE[c]);
    expect(bogus, "the map now covers every code this test tried").toBeDefined();

    const c = checkGstin(`${bogus}ABDCA0298H1ZP`);
    expect(c.tone).toBe("error");
    expect(c.message).toContain(bogus!);
    expect(c.message).toMatch(/state code/i);
  });

  it("counts the missing characters instead of saying 'invalid'", () => {
    expect(checkGstin("07ABDCA0298H1Z").message).toBe("1 more character — a GSTIN is 15.");
    expect(checkGstin("07ABDCA0298H1").message).toBe("2 more characters — a GSTIN is 15.");
  });

  it("never lets a field grow past 15", () => {
    expect(liveGstin(`${REAL_GSTIN}EXTRA`)).toBe(REAL_GSTIN);
  });
});

describe("phone", () => {
  it("strips +91, 0091 and a trunk 0", () => {
    for (const raw of ["+91 98765 43210", "0091-9876543210", "09876543210", "919876543210"]) {
      expect(livePhone(raw)).toBe("9876543210");
    }
  });

  it("formats on commit, not while typing", () => {
    expect(commitPhone("9876543210")).toBe("+91 98765 43210");
  });

  it("leaves an unfinished number alone on commit rather than mangling it", () => {
    /* Blur on a half-typed number must not produce something that looks complete. */
    expect(commitPhone("98765")).toBe("98765");
  });

  /**
   * The most common paste error in this market: a landline WITH its STD code is ten
   * digits and looks perfect right up until somebody tries to WhatsApp it.
   */
  it("catches a ten-digit landline", () => {
    const c = checkPhone("01142345678".slice(0, 10));
    expect(c.tone).toBe("error");
    expect(c.message).toMatch(/landline/i);
  });

  it("accepts a real mobile", () => {
    expect(checkPhone("+91 98765 43210")).toMatchObject({ tone: "ok" });
  });
});

/**
 * R-2645: the phone field used to force +91 and cut every number to 10 digits, whatever
 * the customer's country — a US "5551234567" saved as "+91 55512 34567" and "+44 7911 123456"
 * as "4479111234". The dialling code now comes from the form's country (R-2639 lib/phone.ts).
 */
describe("phone with the form's country (R-2645)", () => {
  it("US customer: 5551234567 saves as +1, not +91", () => {
    expect(livePhone("5551234567", "United States")).toBe("5551234567");
    expect(commitPhone("5551234567", "United States")).toBe("+1 555 123 4567");
    expect(commitPhone("(555) 123-4567", "USA")).toBe("+1 555 123 4567");
    expect(checkPhone("5551234567", "United States")).toMatchObject({ tone: "ok" });
  });

  it("a number typed with +CC is kept whole — any country, also India / empty", () => {
    for (const country of [undefined, "", "India", "United States"]) {
      expect(livePhone("+44 7911 123456", country)).toBe("+447911123456");
      expect(commitPhone("+44 7911 123456", country)).toBe("+44 7911123456");
      expect(checkPhone("+44 7911 123456", country)).toMatchObject({ tone: "ok" });
    }
    expect(commitPhone("0044 7911 123456", "")).toBe("+44 7911123456");
    expect(commitPhone("+1 (555) 123-4567")).toBe("+1 555 123 4567");
  });

  it("UK customer: national 07911 123456 gets +44, trunk 0 dropped", () => {
    expect(livePhone("07911 123456", "United Kingdom")).toBe("07911123456");
    expect(commitPhone("07911 123456", "United Kingdom")).toBe("+44 7911123456");
  });

  it("a foreign number is not cut to 10 digits while typing", () => {
    expect(livePhone("971501234567", "United Arab Emirates")).toBe("971501234567");
    expect(commitPhone("971501234567", "United Arab Emirates")).toBe("+971 501234567");
  });

  it("Indian numbers are unchanged (India, empty or unreadable country)", () => {
    for (const country of [undefined, "", "India", "IN", "Inida"]) {
      expect(livePhone("+91 98765 43210", country)).toBe("9876543210");
      expect(livePhone("09876543210", country)).toBe("9876543210");
      expect(livePhone("98765432109", country)).toBe("9876543210");
      expect(commitPhone("9876543210", country)).toBe("+91 98765 43210");
      expect(commitPhone("98765", country)).toBe("98765");
      expect(checkPhone("98765", country).tone).toBe("typing");
      expect(checkPhone("0114234567", country).tone).toBe("error");
    }
  });

  it("a +91 number for a foreign customer stays Indian (not re-coded)", () => {
    expect(commitPhone("+91 98765 43210", "United States")).toBe("+91 98765 43210");
  });

  it("half-typed foreign number: left alone on commit, 'typing' pill", () => {
    expect(commitPhone("555 12", "United States")).toBe("555 12");
    expect(checkPhone("55512", "United States").tone).toBe("typing");
    expect(checkPhone("+4", "").tone).toBe("typing");
  });

  it("an Indian landline written with +91 is still caught", () => {
    expect(checkPhone("+91 11 4234 5678", "").tone).toBe("error");
  });

  it("review: an Indian mobile with a stray '+' stays Indian, not Iran (+98)", () => {
    expect(livePhone("+9876543210", "India")).toBe("9876543210");
    expect(commitPhone("+98765 43210", "")).toBe("+91 98765 43210");
  });

  it("review: +1 / +91 need exactly 10 digits after the code; short foreign numbers are 'typing'", () => {
    expect(checkPhone("+1 555 123 456", "").tone).toBe("typing");
    expect(commitPhone("+1 555 123 456", "")).toBe("+1 555 123 456");
    expect(checkPhone("+91 98765 432109", "").tone).toBe("error");
    expect(checkPhone("+91 98765 4321", "United States").tone).toBe("typing");
    expect(checkPhone("791112", "United Kingdom").tone).toBe("typing");
    expect(commitPhone("791112", "United Kingdom")).toBe("791112");
  });

  it("review: an over-long paste is not cut silently — it shows Too long", () => {
    const c = checkPhone("+44 7911 123456 / +44 7911 654321", "");
    expect(c.tone).toBe("error");
    expect(c.message).toMatch(/too long/i);
  });
});

describe("recommitPhoneForCountry (R-2645 review: country picked after the phone)", () => {
  it("a bare number formatted as +91 before the country was picked gets the new code", () => {
    expect(recommitPhoneForCountry("+91 55512 34567", "United States")).toBe("+1 555 123 4567");
  });
  it("never touches a real Indian mobile, another code, or an India pick", () => {
    expect(recommitPhoneForCountry("+91 98765 43210", "United States")).toBeNull();
    expect(recommitPhoneForCountry("+44 7911123456", "United States")).toBeNull();
    expect(recommitPhoneForCountry("+91 55512 34567", "India")).toBeNull();
    expect(recommitPhoneForCountry("", "United States")).toBeNull();
  });
});

describe("domain", () => {
  it("strips scheme, www, path and query", () => {
    expect(liveDomain("https://www.acme.com/pricing?ref=x")).toBe("acme.com");
    expect(liveDomain("HTTP://Acme.CO.IN")).toBe("acme.co.in");
  });

  it("keeps a subdomain that is not www — mail.acme.com is a different host", () => {
    expect(liveDomain("https://mail.acme.com")).toBe("mail.acme.com");
  });

  it("asks for the ending rather than calling a half-typed domain wrong", () => {
    expect(checkDomain("acme").tone).toBe("typing");
  });

  it("accepts a real one", () => {
    expect(checkDomain("anutech.in").tone).toBe("ok");
  });

  it("rejects something that is not a domain at all", () => {
    expect(checkDomain("acme .com!").tone).toBe("error");
  });
});

/**
 * ─── MONEY IS WHOLE RUPEES, AND THE FIELD SAYS SO OUT LOUD ──────────────────
 * CLAUDE.md §13, corrected against live data after the file itself claimed paise.
 */
describe("money", () => {
  it("accepts a spreadsheet paste with commas and a rupee sign", () => {
    expect(parseMoney("₹ 1,50,000")).toBe(150000);
  });

  it("groups the Indian way on commit — 1,50,000, never 150,000", () => {
    expect(commitMoney("150000")).toBe("1,50,000");
    expect(commitMoney("₹1,34,138")).toBe("1,34,138");
  });

  it("REPORTS a rounding instead of performing it silently", () => {
    /* Quietly turning 1500.50 into 1501 is deciding something about somebody's money
       without telling them. */
    const c = checkMoney("1500.50");
    expect(c.tone).toBe("error");
    expect(c.message).toContain("₹1,501");
    expect(c.message).toMatch(/paise are not stored/i);
  });

  it("is happy with a whole amount and shows it formatted", () => {
    expect(checkMoney("134138")).toMatchObject({ tone: "ok", message: "₹1,34,138", detail: "whole rupees" });
  });

  it("refuses a negative amount rather than silently making it positive", () => {
    /* liveMoney keeps the minus ON PURPOSE so this can be reported. Stripping it would
       turn -500 into 500 without a word, and it is their money. */
    expect(liveMoney("-500")).toBe("-500");
    const c = checkMoney("-500");
    expect(c.tone).toBe("error");
    expect(c.message).toMatch(/credit note/i);
  });

  it("does not fight a trailing decimal point mid-type", () => {
    expect(liveMoney("1500.")).toBe("1500.");
    expect(liveMoney("15.00.5")).toBe("15.005");
  });
});

describe("email", () => {
  it("lower-cases and de-spaces a WhatsApp paste", () => {
    expect(liveEmail(" Pardeep@Anutech.IN ")).toBe("pardeep@anutech.in");
  });

  it("accepts a real address and rejects a broken one", () => {
    expect(checkEmail("pardeep@anutech.in").tone).toBe("ok");
    expect(checkEmail("pardeep@anutech").tone).toBe("error");
  });
});

/**
 * ─── "COMPANY", AS FAR AS IT CAN HONESTLY BE KNOWN ──────────────────────────
 * The brief asks smart-paste to extract a Company. The DOMAIN is the part of that which
 * is derivable; the NAME is not — "Acme", "Acme Corp" and "Acme Corporation Pvt Ltd" are
 * three strings for one business, and the one that lands on a tax invoice is a legal fact
 * nobody should guess from an email address.
 */
describe("the company domain behind a work email", () => {
  it("is the host of a work address", () => {
    expect(companyDomainFromEmail("rahul@acme.co.in")).toBe("acme.co.in");
    expect(companyDomainFromEmail(" Pardeep@ANUTECH.in ")).toBe("anutech.in");
  });

  it("is NULL for free mail — three gmail customers are not one company", () => {
    /* Without this, domain-matching would tie together every business whose contact
       happens to use gmail. */
    for (const e of ["a@gmail.com", "b@yahoo.co.in", "c@rediffmail.com", "d@outlook.com", "e@icloud.com"]) {
      expect(companyDomainFromEmail(e), e).toBeNull();
    }
  });

  it("is NULL when there is no usable address", () => {
    for (const e of [null, undefined, "", "not-an-email", "no@host"]) {
      expect(companyDomainFromEmail(e), String(e)).toBeNull();
    }
  });
});
