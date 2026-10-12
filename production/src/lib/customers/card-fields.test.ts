import { describe, it, expect } from "vitest";
import {
  mapScannedCard,
  toIndianE164,
  cleanEmail,
  cleanDomain,
  cleanPin,
  cleanGstin,
  filledCount,
} from "./card-fields";

/** A real, checksum-valid GSTIN — the tenant's own, from tenants.gstin. */
const GOOD_GSTIN = "07ABDCA0298H1ZP";

describe("toIndianE164 — the shapes a card actually prints", () => {
  it.each([
    ["+91 98765 43210", "+919876543210"],
    ["098765 43210",    "+919876543210"],
    ["91-9876543210",   "+919876543210"],
    ["9876543210",      "+919876543210"],
    ["0091 9876543210", "+919876543210"],
    ["(+91) 98765-43210", "+919876543210"],
  ])("%s -> %s", (raw, expected) => {
    expect(toIndianE164(raw)).toBe(expected);
  });

  it("refuses anything that is not a plausible Indian number", () => {
    // A half-cleaned number is worse than an empty box: an operator trusts a
    // filled field and will not re-read it.
    for (const bad of [
      "12345",              // too short
      "5876543210",         // Indian mobiles do not start with 5
      "98765432101234",     // too long
      "+1 415 555 0100",    // not India — belongs in a different flow
      "",
      null,
      undefined,
      12345,
    ]) {
      expect(toIndianE164(bad)).toBeNull();
    }
  });
});

describe("cleanEmail", () => {
  it("lower-cases a valid address", () => {
    expect(cleanEmail("  Vinay@TruHomes.IN ")).toBe("vinay@truhomes.in");
  });
  it("rejects OCR noise rather than passing a broken address on", () => {
    for (const bad of ["vinay(at)truhomes.in", "vinay@", "@truhomes.in", "vinay truhomes.in", "vinay@truhomes", ""]) {
      expect(cleanEmail(bad)).toBeNull();
    }
  });
});

describe("cleanDomain", () => {
  it("strips scheme, www and path", () => {
    expect(cleanDomain("https://www.AcmeCorp.com/about?x=1")).toBe("acmecorp.com");
  });
  it("recovers the domain when a card printed the email in the website slot", () => {
    expect(cleanDomain("sales@acmecorp.com")).toBe("acmecorp.com");
  });
  it("rejects junk", () => {
    for (const bad of ["acmecorp", "http://", "", null]) expect(cleanDomain(bad)).toBeNull();
  });
});

describe("cleanPin", () => {
  it("accepts a six-digit Indian PIN", () => {
    expect(cleanPin("110 085")).toBe("110085");
    expect(cleanPin(560001)).toBe("560001");
  });
  it("rejects the wrong length, and a leading zero", () => {
    // No Indian PIN begins with 0.
    for (const bad of ["01008", "0110085", "11008", "1100855", "abcdef", ""]) {
      expect(cleanPin(bad)).toBeNull();
    }
  });
});

describe("cleanGstin — the strictest rule here, on purpose", () => {
  it("accepts a GSTIN that passes the checksum", () => {
    expect(cleanGstin(` ${GOOD_GSTIN.toLowerCase()} `)).toBe(GOOD_GSTIN);
  });

  it("REJECTS a GSTIN with one character misread", () => {
    // OCR confuses 0/O, 1/I, 5/S, 8/B constantly. Such a GSTIN looks perfectly
    // normal by eye and would be carried onto every GST invoice for this
    // customer. The checksum is what catches it.
    const broken = GOOD_GSTIN.replace("0", "O");
    expect(broken).not.toBe(GOOD_GSTIN);
    expect(cleanGstin(broken)).toBeNull();
  });

  it("rejects the wrong length and empty input", () => {
    for (const bad of [GOOD_GSTIN.slice(0, 14), `${GOOD_GSTIN}X`, "", null]) {
      expect(cleanGstin(bad)).toBeNull();
    }
  });
});

describe("mapScannedCard", () => {
  const card = {
    company_name: "  A IOTA   TECHNOLOGIES ",
    contact_name: "Vinay Kumar",
    designation:  "Director",
    email:        "VINAY@truhomes.in",
    phone:        "+91 98765 43210",
    mobile:       "not a number",
    address:      "Plot 9, Sector 5",
    city:         "Delhi",
    pin_code:     "110085",
    domain:       "www.truhomes.in/contact",
    gstin:        GOOD_GSTIN,
  };

  it("normalises everything it can", () => {
    const f = mapScannedCard(card);
    expect(f.name).toBe("A IOTA TECHNOLOGIES");   // collapsed whitespace
    expect(f.contact_email).toBe("vinay@truhomes.in");
    expect(f.contact_phone).toBe("+919876543210");
    expect(f.domain).toBe("truhomes.in");
    expect(f.pin_code).toBe("110085");
    expect(f.gstin).toBe(GOOD_GSTIN);
  });

  it("blanks a field it could not trust instead of guessing", () => {
    expect(mapScannedCard(card).contact_mobile).toBeNull();
  });

  it("NEVER returns state, state_code, country, group or payment terms", () => {
    // state decides CGST+SGST vs IGST. A guessed state silently produces the
    // wrong tax split, so it comes from the verified GSTIN and nowhere else.
    // group and payment terms are commercial decisions a card cannot evidence.
    const f = mapScannedCard({ ...card, city: "Delhi" }) as unknown as Record<string, unknown>;
    for (const forbidden of ["state", "state_code", "country", "group_id", "payment_terms_days"]) {
      expect(f[forbidden]).toBeUndefined();
    }
  });

  it("survives an empty or missing reading without throwing", () => {
    for (const empty of [null, undefined, {}]) {
      const f = mapScannedCard(empty);
      expect(Object.values(f).every((v) => v === null)).toBe(true);
    }
  });

  it("ignores non-string junk in every field", () => {
    const f = mapScannedCard({
      company_name: 42, contact_name: {}, email: [], phone: true,
      domain: null, gstin: 12345, pin_code: {}, address: undefined,
    } as never);
    expect(Object.values(f).every((v) => v === null)).toBe(true);
  });
});

describe("filledCount", () => {
  it("counts only what was actually filled", () => {
    expect(filledCount(mapScannedCard({}))).toBe(0);
    expect(filledCount(mapScannedCard({ company_name: "Acme", email: "a@b.in" }))).toBe(2);
  });
});
