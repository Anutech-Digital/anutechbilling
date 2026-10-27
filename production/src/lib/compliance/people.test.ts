import { describe, it, expect } from "vitest";
import { buildComplianceRows, obligationsFor, type ComplianceProfile } from "./obligations";
import { peopleFromDirectors, peopleFromPartners, type CompliancePerson } from "./people";
import { reminderStepFor, dueReminders } from "./reminders";
import { complianceTodayItems } from "@/lib/today/inbox";

/**
 * R-1857 — compliance per person. Rule 12A of the Companies (Appointment and Qualification of
 * Directors) Rules, as substituted by G.S.R. 943(E) (31 Dec 2025, in force 31 Mar 2026):
 *   (1) DIR-3 KYC Web once every third consecutive FY, by 30 June — per DIN holder;
 *   (2) a change in personal mobile, email or residential address → DIR-3 KYC Web within 30 days.
 * DSC: no ROC form can be signed without a valid DSC, so the register's expiry date is reminded
 * 30 days ahead.
 */

const OCT_25_2026 = new Date("2026-10-25T12:00:00+05:30");
const NONE = new Map<string, string>();

const asha: CompliancePerson = {
  name: "Asha Rao", din: "01234567", role: "director",
  ceasedOn: null, dscExpiry: "2026-11-14", lastKycYear: 2025, detailsChangedOn: null,
};
const bimal: CompliancePerson = {
  name: "Bimal Shah", din: "07654321", role: "director",
  ceasedOn: null, dscExpiry: null, lastKycYear: null, detailsChangedOn: null,
};
const chitra: CompliancePerson = {
  name: "Chitra Iyer", din: "05555555", role: "director",
  ceasedOn: "2026-09-30", dscExpiry: "2026-11-01", lastKycYear: 2025, detailsChangedOn: "2026-10-20",
};

const pvt = (people: CompliancePerson[]): ComplianceProfile => ({ businessType: "pvt_ltd", gstFiling: null, people });
const rocRows = (profile: ComplianceProfile, filed = NONE, today = OCT_25_2026) =>
  buildComplianceRows(today, filed, ["roc"], undefined, profile);
const row = (rows: ReturnType<typeof rocRows>, key: string) => rows.find((r) => r.ob.key === key);

describe("DIR-3 KYC — one row per director, with the name", () => {
  it("two directors → two DIR-3 KYC rows, and the one common row is gone", () => {
    const rows = rocRows(pvt([asha, bimal]));
    const kyc = rows.filter((r) => r.ob.key.startsWith("roc_dir3kyc"));
    expect(kyc.map((r) => r.ob.key).sort()).toEqual(["roc_dir3kyc:01234567", "roc_dir3kyc:07654321"]);
    expect(row(rows, "roc_dir3kyc")).toBeUndefined();
    expect(row(rows, "roc_dir3kyc:01234567")!.ob.name).toBe("DIR-3 KYC — Asha Rao (DIN 01234567)");
  });

  it("last KYC 2025 → due 30 Jun 2028; no KYC year → the common cycle (also 2028), and it says so", () => {
    const rows = rocRows(pvt([asha, bimal]));
    expect(row(rows, "roc_dir3kyc:01234567")!.inst.dueDate).toBe("2028-06-30");
    expect(row(rows, "roc_dir3kyc:01234567")!.status).toBe("upcoming");
    expect(row(rows, "roc_dir3kyc:01234567")!.ob.applies).toMatch(/Last DIR-3 KYC in 2025/);
    expect(row(rows, "roc_dir3kyc:07654321")!.inst.dueDate).toBe("2028-06-30");
    expect(row(rows, "roc_dir3kyc:07654321")!.ob.applies).toMatch(/No last KYC year/);
  });

  it("a KYC more than 3 years old stays OVERDUE — never skipped to the next cycle", () => {
    const rows = rocRows(pvt([{ ...asha, lastKycYear: 2022 }]));
    const r = row(rows, "roc_dir3kyc:01234567")!;
    expect(r.inst.dueDate).toBe("2025-06-30");
    expect(r.status).toBe("overdue");
  });

  it("marked filed for 2028 → the row moves to 30 Jun 2031", () => {
    const filed = new Map([["roc_dir3kyc:01234567|kyc2028", "2028-06-10"]]);
    const r = row(rocRows(pvt([asha]), filed, new Date("2028-07-02T12:00:00+05:30")), "roc_dir3kyc:01234567")!;
    expect(r.inst.dueDate).toBe("2031-06-30");
  });

  it("a ceased director has no rows; with only ceased directors the common row comes back", () => {
    const rows = rocRows(pvt([chitra]));
    expect(rows.some((r) => r.ob.key.includes("05555555"))).toBe(false);
    expect(row(rows, "roc_dir3kyc")).toBeDefined();
  });

  it("no register → the common DIR-3 KYC row exactly as before", () => {
    expect(row(rocRows(pvt([])), "roc_dir3kyc")!.inst.dueDate).toBe("2028-06-30");
    expect(row(rocRows({ businessType: "pvt_ltd", gstFiling: null }), "roc_dir3kyc")).toBeDefined();
  });

  it("a proprietor or partnership gets no director rows, even if rows were passed", () => {
    for (const businessType of ["proprietor", "partnership"] as const) {
      const keys = obligationsFor({ businessType, gstFiling: null, people: [asha] }).map((o) => o.key);
      expect(keys.some((k) => k.startsWith("roc_dir3kyc") || k.startsWith("roc_dsc"))).toBe(false);
    }
  });
});

describe("LLP — designated partners with a DPIN", () => {
  const partners = peopleFromPartners([
    { name: "Dev Mehta", din_dpin: "02222222", is_designated: true, left_on: null },
    { name: "Esha Gill", din_dpin: "03333333", is_designated: false, left_on: null },
    { name: "Farid Khan", din_dpin: null, is_designated: true, left_on: null },
  ]);

  it("only a designated partner with a DPIN gets a DIR-3 KYC row", () => {
    expect(partners.map((p) => p.din)).toEqual(["02222222"]);
    const keys = rocRows({ businessType: "llp", gstFiling: null, people: partners }).map((r) => r.ob.key);
    expect(keys).toContain("roc_dir3kyc:02222222");
    expect(keys).not.toContain("roc_dir3kyc");
    const ob = obligationsFor({ businessType: "llp", gstFiling: null, people: partners }).find((o) => o.key === "roc_dir3kyc:02222222")!;
    expect(ob.name).toBe("DIR-3 KYC — Dev Mehta (DPIN 02222222)");
  });

  it("a Pvt Ltd ignores partner rows (and an LLP ignores director rows)", () => {
    expect(obligationsFor(pvt(partners)).some((o) => o.key === "roc_dir3kyc:02222222")).toBe(false);
    expect(obligationsFor({ businessType: "llp", gstFiling: null, people: [asha] }).some((o) => o.key.includes("01234567"))).toBe(false);
  });
});

describe("DSC expiry — reminded 30 days ahead", () => {
  it("expiry 20 days away → a 'due soon' row with the name", () => {
    const r = row(rocRows(pvt([asha])), "roc_dsc:01234567")!;
    expect(r.ob.name).toBe("Renew DSC — Asha Rao (DIN 01234567)");
    expect(r.inst.dueDate).toBe("2026-11-14");
    expect(r.daysToDue).toBe(20);
    expect(r.status).toBe("due_soon");
  });

  it("more than 30 days away → no row yet; no expiry → no row", () => {
    expect(row(rocRows(pvt([{ ...asha, dscExpiry: "2026-11-25" }])), "roc_dsc:01234567")).toBeUndefined();
    expect(row(rocRows(pvt([bimal])), "roc_dsc:07654321")).toBeUndefined();
  });

  it("already expired → stays as overdue until the new expiry is saved", () => {
    const r = row(rocRows(pvt([{ ...asha, dscExpiry: "2026-08-01" }])), "roc_dsc:01234567")!;
    expect(r.status).toBe("overdue");
  });

  it("marked done → shown as done until the old date passes, then gone", () => {
    const filed = new Map([["roc_dsc:01234567|dsc2026-11-14", "2026-10-25"]]);
    expect(row(rocRows(pvt([asha]), filed), "roc_dsc:01234567")!.status).toBe("filed");
    expect(row(rocRows(pvt([asha]), filed, new Date("2026-11-20T12:00:00+05:30")), "roc_dsc:01234567")).toBeUndefined();
  });
});

describe("Details changed → DIR-3 KYC Web within 30 days (Rule 12A(2))", () => {
  const changed = { ...asha, detailsChangedOn: "2026-10-20" };

  it("email changed on 20 Oct → a row due 19 Nov, due soon", () => {
    const r = row(rocRows(pvt([changed])), "roc_dir3kyc_update:01234567")!;
    expect(r.ob.name).toBe("DIR-3 KYC Web — update Asha Rao's details");
    expect(r.inst.dueDate).toBe("2026-11-19");
    expect(r.status).toBe("due_soon");
  });

  it("filed → done; a month after the due date it drops off", () => {
    const filed = new Map([["roc_dir3kyc_update:01234567|chg2026-10-20", "2026-10-28"]]);
    expect(row(rocRows(pvt([changed]), filed), "roc_dir3kyc_update:01234567")!.status).toBe("filed");
    expect(row(rocRows(pvt([changed]), filed, new Date("2026-12-25T12:00:00+05:30")), "roc_dir3kyc_update:01234567")).toBeUndefined();
  });

  it("not filed → stays overdue after the 30 days", () => {
    const r = row(rocRows(pvt([changed]), NONE, new Date("2026-12-25T12:00:00+05:30")), "roc_dir3kyc_update:01234567")!;
    expect(r.status).toBe("overdue");
  });
});

describe("Today + reminder mails read the same rows", () => {
  it("Today: the DSC 20 days away shows; a KYC two years away does not", () => {
    const items = complianceTodayItems(OCT_25_2026, NONE, undefined, pvt([asha, bimal]));
    const dsc = items.find((i) => i.id === "roc_dsc:01234567|dsc2026-11-14")!;
    expect(dsc.title).toBe("Renew DSC — Asha Rao (DIN 01234567) · due in 20d");
    expect(dsc.kind).toBe("compliance_people");
    expect(dsc.href).toBe("/compliance/roc");
    expect(items.some((i) => i.id.startsWith("roc_dir3kyc:"))).toBe(false);
  });

  it("Today: a details change shows at once (30-day window)", () => {
    const items = complianceTodayItems(OCT_25_2026, NONE, undefined, pvt([{ ...asha, detailsChangedOn: "2026-10-20" }]));
    expect(items.some((i) => i.id === "roc_dir3kyc_update:01234567|chg2026-10-20")).toBe(true);
  });

  it("reminder ladder: a person row gets a 30-day rung; others keep 15/7/3", () => {
    expect(reminderStepFor({ status: "due_soon", daysToDue: 20, ob: { remindDays: 30 } })).toBe(30);
    expect(reminderStepFor({ status: "due_soon", daysToDue: 6, ob: { remindDays: 30 } })).toBe(7);
    expect(reminderStepFor({ status: "upcoming", daysToDue: 20 })).toBeNull();
    const plans = dueReminders(rocRows(pvt([asha])), () => false);
    const dsc = plans.find((p) => p.obligationKey === "roc_dsc:01234567")!;
    expect(dsc.daysBefore).toBe(30);
    expect(dsc.name).toBe("Renew DSC — Asha Rao (DIN 01234567)");
  });
});

describe("peopleFromDirectors", () => {
  it("maps the register row", () => {
    expect(peopleFromDirectors([{
      name: "Asha Rao", din: "01234567", ceased_on: null, dsc_expiry: "2026-11-14", last_kyc_year: 2025,
      kyc_details_changed_on: "2026-10-20",
    }])).toEqual([{ ...asha, detailsChangedOn: "2026-10-20" }]);
  });
});
