import { describe, it, expect } from "vitest";
import {
  showsPartnersRegister, panError, dinError, isActivePartner, activePartners, shareTotal, shareWarning,
  partnerFormErrors, movementPartner, normalisePartnerInput, type FirmPartner,
} from "./partners";

const p = (over: Partial<FirmPartner>): FirmPartner => ({
  id: "p1", name: "Asha", pan: null, din_dpin: null, is_designated: false, profit_share_pct: 0,
  capital_contribution: 0, joined_on: null, left_on: null, note: null, ...over,
});

describe("showsPartnersRegister — only a firm or an LLP, through the one resolver", () => {
  it("partnership and llp yes; proprietor, pvt_ltd and an empty type (= Pvt Ltd) no", () => {
    expect(showsPartnersRegister("partnership")).toBe(true);
    expect(showsPartnersRegister("llp")).toBe(true);
    expect(showsPartnersRegister("proprietor")).toBe(false);
    expect(showsPartnersRegister("pvt_ltd")).toBe(false);
    expect(showsPartnersRegister(null)).toBe(false);
    expect(showsPartnersRegister(undefined)).toBe(false);
  });
});

describe("PAN / DIN checks (same rules as the database)", () => {
  it("accepts a valid PAN in any case, refuses a wrong shape", () => {
    expect(panError("abcde1234f")).toBeNull();
    expect(panError("")).toBeNull();
    expect(panError("ABCDE1234")).toMatch(/ABCDE1234F/);
    expect(panError("ABCD11234F")).toMatch(/PAN/);
  });
  it("DIN / DPIN is 8 digits", () => {
    expect(dinError("01234567")).toBeNull();
    expect(dinError("")).toBeNull();
    expect(dinError("1234567")).toMatch(/8 digits/);
    expect(dinError("1234567A")).toMatch(/8 digits/);
  });
});

describe("active partners and the ratio warning", () => {
  const a = p({ id: "a", name: "Asha", profit_share_pct: 60 });
  const b = p({ id: "b", name: "Bimal", profit_share_pct: 30 });
  const gone = p({ id: "g", name: "Gopal", profit_share_pct: 10, left_on: "2026-03-31" });

  it("a partner is active until the leaving date (inclusive)", () => {
    expect(isActivePartner(gone, "2026-03-31")).toBe(true);
    expect(isActivePartner(gone, "2026-04-01")).toBe(false);
    expect(isActivePartner(a, "2030-01-01")).toBe(true);
  });
  it("not active before joining", () => {
    expect(isActivePartner(p({ joined_on: "2026-05-01" }), "2026-04-30")).toBe(false);
  });
  it("lists active partners by name", () => {
    expect(activePartners([b, gone, a], "2026-10-01").map((x) => x.name)).toEqual(["Asha", "Bimal"]);
  });
  it("totals the active partners' shares; numeric strings from the API count too", () => {
    expect(shareTotal([a, b, gone], "2026-10-01")).toBe(90);
    expect(shareTotal([a, p({ id: "s", profit_share_pct: "40" as unknown as number })], "2026-10-01")).toBe(100);
  });
  it("warns (never blocks) when shares do not add up to 100", () => {
    expect(shareWarning([a, b], "2026-10-01")).toMatch(/90%.*100%/);
    expect(shareWarning([a, p({ id: "c", profit_share_pct: 40 })], "2026-10-01")).toBeNull();
    expect(shareWarning([], "2026-10-01")).toBeNull();
    expect(shareWarning([a, p({ id: "c", profit_share_pct: 50 })], "2026-10-01")).toMatch(/110%/);
  });
  it("shares like 33.33 × 3 count as 100", () => {
    const thirds = ["x", "y", "z"].map((id) => p({ id, name: id, profit_share_pct: 33.33 }));
    expect(shareWarning(thirds, "2026-10-01")).toBeNull();
  });
});

describe("partnerFormErrors — the add / edit form", () => {
  const existing = [p({ id: "a", name: "Asha Verma", pan: "ABCPV1234K" })];
  const ok = { name: "Bimal", pan: "", din_dpin: "", profit_share_pct: "40", capital_contribution: "50000", joined_on: "", left_on: "" };

  it("no errors for a good partner", () => {
    expect(partnerFormErrors(ok, existing, null)).toEqual({});
  });
  it("name required and unique (any case / spaces)", () => {
    expect(partnerFormErrors({ ...ok, name: "  " }, existing, null).name).toMatch(/name/);
    expect(partnerFormErrors({ ...ok, name: " asha verma " }, existing, null).name).toMatch(/already/);
    expect(partnerFormErrors({ ...ok, name: "Asha Verma" }, existing, "a")).toEqual({});
  });
  it("PAN shape and not used twice", () => {
    expect(partnerFormErrors({ ...ok, pan: "AB12" }, existing, null).pan).toMatch(/PAN/);
    expect(partnerFormErrors({ ...ok, pan: "abcpv1234k" }, existing, null).pan).toMatch(/already/);
  });
  it("share 0–100, capital whole rupees ≥ 0, leaving not before joining", () => {
    expect(partnerFormErrors({ ...ok, profit_share_pct: "101" }, existing, null).share).toMatch(/0 and 100/);
    expect(partnerFormErrors({ ...ok, profit_share_pct: "abc" }, existing, null).share).toMatch(/0 and 100/);
    expect(partnerFormErrors({ ...ok, capital_contribution: "-1" }, existing, null).capital).toMatch(/whole rupees/);
    expect(partnerFormErrors({ ...ok, capital_contribution: "10.5" }, existing, null).capital).toMatch(/whole rupees/);
    expect(partnerFormErrors({ ...ok, joined_on: "2026-04-01", left_on: "2026-03-01" }, existing, null).dates).toMatch(/joining/);
  });
  it("DIN / DPIN checked when given", () => {
    expect(partnerFormErrors({ ...ok, din_dpin: "12" }, existing, null).din).toMatch(/8 digits/);
  });
});

describe("normalisePartnerInput", () => {
  it("upper-cases PAN, trims, empty → null, numbers parsed", () => {
    expect(normalisePartnerInput({ name: " Bimal ", pan: " abcpv1234k ", din_dpin: "", profit_share_pct: "40", capital_contribution: "", joined_on: "", left_on: "" }))
      .toEqual({ name: "Bimal", pan: "ABCPV1234K", din_dpin: null, profit_share_pct: 40, capital_contribution: 0, joined_on: null, left_on: null });
  });
});

describe("movementPartner — what an entry shows", () => {
  const partners = [p({ id: "a", name: "Asha Verma" })];
  it("a linked entry shows the register name", () => {
    expect(movementPartner({ partner_id: "a", partner_name: "asha verma" }, partners)).toEqual({ name: "Asha Verma", linked: true });
  });
  it("an old free-text entry keeps its own name and is not linked", () => {
    expect(movementPartner({ partner_id: null, partner_name: "Asha (old)" }, partners)).toEqual({ name: "Asha (old)", linked: false });
  });
  it("no partner at all", () => {
    expect(movementPartner({ partner_id: null, partner_name: null }, partners)).toBeNull();
  });
  it("partner_id missing from the list (still loading) falls back to the stored name", () => {
    expect(movementPartner({ partner_id: "zzz", partner_name: "Asha" }, partners)).toEqual({ name: "Asha", linked: true });
  });
});
