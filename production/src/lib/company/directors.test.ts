/**
 * R-1850 — directors register rules (pure). Written before directors.ts.
 */
import { describe, it, expect } from "vitest";
import {
  showsDirectorsRegister, isActiveDirector, dscStatus, kycDue, directorFormErrors,
  normaliseDirectorInput, DESIGNATION_LABEL, contactChanged, type DirectorFormInput,
} from "./directors";

const FORM: DirectorFormInput = {
  name: "Asha Verma", din: "01234567", pan: "ABCPV1234K", designation: "director",
  appointed_on: "2024-04-01", ceased_on: "", dsc_expiry: "2027-03-31", last_kyc_year: "2025",
  email: "asha@example.in", phone: "98100 12345",
};

describe("who sees the directors register", () => {
  it("Pvt Ltd and an empty type (empty = Pvt Ltd) see it; others do not", () => {
    expect(showsDirectorsRegister("pvt_ltd")).toBe(true);
    expect(showsDirectorsRegister(null)).toBe(true);
    expect(showsDirectorsRegister(undefined)).toBe(true);
    expect(showsDirectorsRegister("proprietor")).toBe(false);
    expect(showsDirectorsRegister("partnership")).toBe(false);
    expect(showsDirectorsRegister("llp")).toBe(false);
  });
  it("labels every designation", () => {
    expect(DESIGNATION_LABEL.managing_director).toBe("Managing Director");
    expect(DESIGNATION_LABEL.whole_time_director).toBe("Whole-time Director");
    expect(Object.keys(DESIGNATION_LABEL)).toHaveLength(5);
  });
});

describe("current vs ceased", () => {
  it("a director is current until the cessation date (inclusive), then ceased", () => {
    expect(isActiveDirector({ ceased_on: null }, "2026-10-25")).toBe(true);
    expect(isActiveDirector({ ceased_on: "2026-10-25" }, "2026-10-25")).toBe(true);
    expect(isActiveDirector({ ceased_on: "2026-10-24" }, "2026-10-25")).toBe(false);
  });
});

describe("DSC expiry", () => {
  const today = "2026-10-25";
  it("says how many days are left, and warns inside 30 days", () => {
    expect(dscStatus("2027-03-31", today)).toEqual({ kind: "ok", days: 157, text: "DSC expires in 157 days" });
    expect(dscStatus("2026-11-14", today)).toEqual({ kind: "soon", days: 20, text: "DSC expires in 20 days" });
    expect(dscStatus("2026-10-26", today).text).toBe("DSC expires tomorrow");
    expect(dscStatus("2026-10-25", today)).toEqual({ kind: "soon", days: 0, text: "DSC expires today" });
  });
  it("an expired DSC says so, and a missing date asks for it", () => {
    expect(dscStatus("2026-10-15", today)).toEqual({ kind: "expired", days: -10, text: "DSC expired 10 days ago" });
    expect(dscStatus("2026-10-24", today).text).toBe("DSC expired yesterday");
    expect(dscStatus(null, today)).toEqual({ kind: "none", days: null, text: "DSC expiry not added" });
  });
});

describe("DIR-3 KYC due (R-1856 rule: once every 3 years by 30 June)", () => {
  it("last KYC in 2025 → due 30 Jun 2028, not overdue in Oct 2026", () => {
    expect(kycDue(2025, "2026-10-25")).toEqual({ dueDate: "2028-06-30", overdue: false, fromCycle: false, text: "KYC due 30 Jun 2028" });
  });
  it("last KYC in 2026 → due 30 Jun 2029", () => {
    expect(kycDue(2026, "2026-10-25").dueDate).toBe("2029-06-30");
  });
  it("last KYC in 2022 → 30 Jun 2025 has passed: overdue", () => {
    expect(kycDue(2022, "2026-10-25")).toEqual({ dueDate: "2025-06-30", overdue: true, fromCycle: false, text: "KYC overdue since 30 Jun 2025" });
  });
  it("no last KYC year → the common cycle from the Compliance Calendar (30 Jun 2028), marked as such", () => {
    const k = kycDue(null, "2026-10-25");
    expect(k.dueDate).toBe("2028-06-30");
    expect(k.fromCycle).toBe(true);
    expect(k.overdue).toBe(false);
    expect(k.text).toBe("KYC due 30 Jun 2028");
  });
  it("on 30 Jun itself it is not overdue yet; on 1 Jul it is", () => {
    expect(kycDue(2025, "2028-06-30").overdue).toBe(false);
    expect(kycDue(2025, "2028-07-01").overdue).toBe(true);
  });
});

describe("the add / edit form", () => {
  it("a full, valid form has no errors", () => {
    expect(directorFormErrors(FORM, [], null, "2026-10-25")).toEqual({});
  });
  it("DIN must be 8 digits and is required", () => {
    expect(directorFormErrors({ ...FORM, din: "1234567" }, [], null, "2026-10-25").din).toBe("DIN must be 8 digits.");
    expect(directorFormErrors({ ...FORM, din: "" }, [], null, "2026-10-25").din).toBe("Enter the director's DIN (8 digits).");
    expect(directorFormErrors({ ...FORM, din: "1234567A" }, [], null, "2026-10-25").din).toBe("DIN must be 8 digits.");
  });
  it("a DIN already in the register is refused (but not against the row being edited)", () => {
    const existing = [{ id: "d1", name: "Asha Verma", din: "01234567" }];
    expect(directorFormErrors({ ...FORM, name: "Other" }, existing, null, "2026-10-25").din).toBe("DIN 01234567 is already in the directors register.");
    expect(directorFormErrors(FORM, existing, "d1", "2026-10-25")).toEqual({});
  });
  it("PAN format, email and phone are checked; PAN, email and phone may be empty", () => {
    expect(directorFormErrors({ ...FORM, pan: "ABC123" }, [], null, "2026-10-25").pan).toMatch(/PAN must be 10 characters/);
    expect(directorFormErrors({ ...FORM, email: "not-an-email" }, [], null, "2026-10-25").email).toBe("Enter a valid email, e.g. name@company.in.");
    expect(directorFormErrors({ ...FORM, phone: "12ab" }, [], null, "2026-10-25").phone).toBe("Enter a phone number of 10 to 15 digits.");
    expect(directorFormErrors({ ...FORM, pan: "", email: "", phone: "" }, [], null, "2026-10-25")).toEqual({});
  });
  it("a masked email / phone (shown to a role that cannot see contacts) is not an error", () => {
    expect(directorFormErrors({ ...FORM, email: "as••••@example.in", phone: "••••••2345" }, [], null, "2026-10-25")).toEqual({});
  });
  it("cessation before appointment and a KYC year in the future are refused", () => {
    expect(directorFormErrors({ ...FORM, ceased_on: "2024-01-01" }, [], null, "2026-10-25").dates).toBe("The cessation date cannot be before the appointment date.");
    expect(directorFormErrors({ ...FORM, last_kyc_year: "2027" }, [], null, "2026-10-25").kyc).toBe("Last KYC year must be between 2018 and 2026.");
    expect(directorFormErrors({ ...FORM, last_kyc_year: "20x5" }, [], null, "2026-10-25").kyc).toBe("Last KYC year must be between 2018 and 2026.");
  });
  it("the name is required", () => {
    expect(directorFormErrors({ ...FORM, name: "  " }, [], null, "2026-10-25").name).toBe("Enter the director's name.");
  });
});

describe("normalising for save", () => {
  it("trims, uppercases the PAN, turns blanks into null and the KYC year into a number", () => {
    expect(normaliseDirectorInput({ ...FORM, pan: " abcpv1234k ", ceased_on: "", email: " ", phone: "98100 12345" })).toEqual({
      name: "Asha Verma", din: "01234567", pan: "ABCPV1234K", designation: "director",
      appointed_on: "2024-04-01", ceased_on: null, dsc_expiry: "2027-03-31", last_kyc_year: 2025,
      email: null, phone: "9810012345",
    });
  });
  it("keeps a masked value as the masked string (the database keeps the stored one)", () => {
    expect(normaliseDirectorInput({ ...FORM, email: "as••••@example.in" }).email).toBe("as••••@example.in");
  });
});

describe("contactChanged (R-1857 — new email / phone → DIR-3 KYC Web in 30 days)", () => {
  const before = { email: "asha@example.in", phone: "9810012345" };
  it("a new email or a new phone is a change", () => {
    expect(contactChanged(before, { email: "asha.verma@example.in", phone: "9810012345" })).toBe(true);
    expect(contactChanged(before, { email: "asha@example.in", phone: "9899988877" })).toBe(true);
  });
  it("same values, email case, a masked value, a cleared value or a new director are not", () => {
    expect(contactChanged(before, { email: "asha@example.in", phone: "9810012345" })).toBe(false);
    expect(contactChanged(before, { email: "ASHA@example.in", phone: "9810012345" })).toBe(false);
    expect(contactChanged(before, { email: "as••••@example.in", phone: "••••••2345" })).toBe(false);
    expect(contactChanged(before, { email: null, phone: null })).toBe(false);
    expect(contactChanged(null, { email: "x@example.in", phone: null })).toBe(false);
  });
});
