import { describe, it, expect } from "vitest";
import { OBLIGATIONS, buildComplianceRows, CATEGORY_META, type Obligation } from "./obligations";

/**
 * This catalog computes penalty-bearing statutory dates — ₹100/day with no cap
 * for MCA forms — and had no tests at all. Two real defects were found writing
 * these, both recorded below as named cases.
 */

const AUG_13_2026 = new Date("2026-08-13T12:00:00+05:30");
const by = (form: string) => OBLIGATIONS.find((o) => o.form === form || o.key === form)!;
const filedMap = (ob: Obligation, periodKey: string, date = "2026-07-18") =>
  new Map([[`${ob.key}|${periodKey}`, date]]);

describe("annual filings report on the year that ENDED — defect #1", () => {
  // Filed in 2026, they report on FY 2025-26 (year ended 31 Mar 2026, adopted at
  // the September AGM). Every one of these previously read "FY 2026-27" — a full
  // year out, which is either the wrong year's financials attached or a year
  // believed done when it is not.
  const cases: [string, string][] = [
    ["AOC-4",     "2026-10-29"],
    ["MGT-7A",    "2026-11-28"],
    ["DIR-3 KYC", "2026-09-30"],
    ["DPT-3",     "2026-06-30"],
    ["ITR-6",     "2026-10-31"],
    ["3CD",       "2026-09-30"],
    ["GSTR-9",    "2026-12-31"],
  ];

  for (const [form, due] of cases) {
    it(`${form} due ${due} is for FY 2025-26`, () => {
      const inst = by(form).next(AUG_13_2026);
      expect(inst.dueDate).toBe(due);
      expect(inst.periodLabel).toBe("FY 2025-26");
      expect(inst.periodKey).toBe("fy2025");
    });
  }

  it("rolls forward a year once the filing window has passed", () => {
    // Standing in Feb 2027, AOC-4's next actionable instance is the 2027 one,
    // reporting on FY 2026-27.
    const inst = by("AOC-4").next(new Date("2027-02-01T12:00:00+05:30"));
    expect(inst.dueDate).toBe("2027-10-29");
    expect(inst.periodLabel).toBe("FY 2026-27");
  });
});

describe("monthly filings — period is the month being filed FOR", () => {
  const g1 = by("GSTR-1");
  const seen = (filed: Map<string, string>) => (pk: string) => filed.has(`${g1.key}|${pk}`);

  it("surfaces the still-owed overdue month ahead of the upcoming one", () => {
    // On 5 Aug the 11 Jul deadline (for June) is 25 days past and unfiled, so it
    // stays in view rather than the page moving on to 11 Aug. I expected the
    // upcoming one when writing this; the behaviour is deliberate and right —
    // an unfiled return does not stop being owed because a new month started.
    const inst = g1.next(new Date("2026-08-05T12:00:00+05:30"));
    expect(inst.dueDate).toBe("2026-07-11");
    expect(inst.periodLabel).toBe("Jun 2026");
  });

  it("due on the 11th covers the previous month, once the earlier one is filed", () => {
    const filed = filedMap(g1, "2026-06");
    const inst = g1.next(new Date("2026-08-05T12:00:00+05:30"), seen(filed));
    expect(inst.dueDate).toBe("2026-08-11");
    expect(inst.periodLabel).toBe("Jul 2026");
    expect(inst.periodKey).toBe("2026-07");
  });

  it("crosses the calendar year correctly", () => {
    // Due 11 Jan 2027 for December 2026 — the case an off-by-one in month maths
    // gets wrong. November filed, so the December return is the live one.
    const filed = filedMap(g1, "2026-11");
    const inst = g1.next(new Date("2027-01-05T12:00:00+05:30"), seen(filed));
    expect(inst.dueDate).toBe("2027-01-11");
    expect(inst.periodLabel).toBe("Dec 2026");
  });
});

describe("a filed period must not hide the next deadline — defect #2", () => {
  const g = by("GSTR-3B");

  it("shows the overdue period while it is still unfiled", () => {
    // 20 Jul passed 24 days ago and is still owed — it should stay in view.
    const inst = g.next(AUG_13_2026);
    expect(inst.periodLabel).toBe("Jun 2026");
    expect(inst.dueDate).toBe("2026-07-20");
  });

  it("advances to the next period the moment that one is filed", () => {
    // Previously the settled June row stayed for the full 45 days, so the
    // 20 August deadline for July was invisible until about 3 September —
    // a fortnight after it had gone late at ₹50/day.
    const filed = filedMap(g, "2026-06");
    const inst = g.next(AUG_13_2026, (pk) => filed.has(`${g.key}|${pk}`));
    expect(inst.periodLabel).toBe("Jul 2026");
    expect(inst.dueDate).toBe("2026-08-20");
  });

  it("buildComplianceRows applies the same advance", () => {
    const filed = filedMap(g, "2026-06");
    const row = buildComplianceRows(AUG_13_2026, filed, ["gst"]).find((r) => r.ob.key === g.key)!;
    expect(row.inst.periodLabel).toBe("Jul 2026");
    expect(row.status).not.toBe("filed");
  });

  it("keeps advancing when several periods in a row are filed", () => {
    // June and July both done → the next thing actually owed is August, due
    // 20 Sep. I first expected this to read "filed"; advancing is better, because
    // a compliance page's job is to show what is still to do.
    const filed = new Map([
      [`${g.key}|2026-06`, "2026-07-18"],
      [`${g.key}|2026-07`, "2026-08-12"],
    ]);
    const row = buildComplianceRows(AUG_13_2026, filed, ["gst"]).find((r) => r.ob.key === g.key)!;
    expect(row.inst.periodLabel).toBe("Aug 2026");
    expect(row.inst.dueDate).toBe("2026-09-20");
    expect(row.status).toBe("upcoming");
  });
});

describe("buildComplianceRows — status and ordering", () => {
  it("classifies overdue, due-soon and upcoming", () => {
    const rows = buildComplianceRows(AUG_13_2026, new Map());
    for (const r of rows) {
      if (r.filedDate) expect(r.status).toBe("filed");
      else if (r.daysToDue < 0) expect(r.status).toBe("overdue");
      else if (r.daysToDue <= 15) expect(r.status).toBe("due_soon");
      else expect(r.status).toBe("upcoming");
    }
  });

  it("sorts overdue first and sinks filed to the bottom", () => {
    const rows = buildComplianceRows(AUG_13_2026, new Map());
    const rank = (s: string) => (s === "filed" ? 2 : s === "overdue" ? 0 : 1);
    const ranks = rows.map((r) => rank(r.status));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("filters by category", () => {
    const rows = buildComplianceRows(AUG_13_2026, new Map(), ["gst"]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ob.category === "gst")).toBe(true);
  });

  it("is stable across a whole year of dates", () => {
    // Every day of 2026-27 must yield a usable row set — no throw, no NaN date.
    for (let d = 0; d < 365; d += 7) {
      const day = new Date(2026, 3, 1 + d);
      const rows = buildComplianceRows(day, new Map());
      expect(rows.length).toBe(OBLIGATIONS.length);
      for (const r of rows) {
        expect(r.inst.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isFinite(r.daysToDue)).toBe(true);
      }
    }
  });
});

describe("catalog integrity", () => {
  it("every obligation has the fields the page renders", () => {
    for (const o of OBLIGATIONS) {
      expect(o.key, "key").toBeTruthy();
      expect(o.name, `${o.key} name`).toBeTruthy();
      expect(CATEGORY_META[o.category], `${o.key} category`).toBeTruthy();
      expect(typeof o.next, `${o.key} next`).toBe("function");
    }
  });

  it("keys are unique — the filed-log is keyed on them", () => {
    const keys = OBLIGATIONS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every penalty-bearing form carries its penalty text", () => {
    // The penalty is the reason anyone opens this page on a Sunday.
    for (const o of OBLIGATIONS.filter((x) => x.category === "roc")) {
      expect(o.penalty, `${o.key} penalty`).toBeTruthy();
    }
  });

  it("in-app data links point at real app routes", () => {
    for (const o of OBLIGATIONS) {
      if (o.dataHref) expect(o.dataHref.href, `${o.key}`).toMatch(/^\/[a-z0-9/-]*$/);
    }
  });
});

describe("R-334 — yearly LUT renewal (Form GST RFD-11)", () => {
  const lutProfile = { businessType: null, gstFiling: null, exportsUnderLut: true };
  const lutRow = (rows: ReturnType<typeof buildComplianceRows>) => rows.find((r) => r.ob.key === "gst_lut_rfd11");

  it("an exporter with an LUT gets a 'Renew LUT' row due 31 March for the NEXT FY", () => {
    const row = lutRow(buildComplianceRows(AUG_13_2026, new Map(), undefined, undefined, lutProfile));
    expect(row?.ob.name).toBe("Renew LUT (Form GST RFD-11)");
    expect(row?.inst.dueDate).toBe("2027-03-31");
    expect(row?.inst.periodLabel).toBe("FY 2027-28");
    expect(row?.ob.category).toBe("gst");
  });

  it("is due-soon in mid-March and moves to next year once filed", () => {
    const mar20 = new Date("2027-03-20T12:00:00+05:30");
    const due = lutRow(buildComplianceRows(mar20, new Map(), undefined, undefined, lutProfile));
    expect(due?.status).toBe("due_soon");
    const filed = new Map([["gst_lut_rfd11|fy2027", "2027-03-18"]]);
    const after = lutRow(buildComplianceRows(new Date("2027-04-02T12:00:00+05:30"), filed, undefined, undefined, lutProfile));
    expect(after?.inst.dueDate).toBe("2028-03-31");
  });

  it("no LUT on file → no row, and the unknown-profile list is unchanged", () => {
    expect(lutRow(buildComplianceRows(AUG_13_2026, new Map()))).toBeUndefined();
    expect(lutRow(buildComplianceRows(AUG_13_2026, new Map(), undefined, undefined,
      { businessType: null, gstFiling: null, exportsUnderLut: false }))).toBeUndefined();
  });
});

describe("R-334 — profileFromRow reads the LUT", async () => {
  const { profileFromRow } = await import("./profile-row");
  it("an LUT number on the tenant row turns the renewal reminder on", () => {
    expect(profileFromRow({ lut_number: "AD290425000000X" }, null).exportsUnderLut).toBe(true);
    expect(profileFromRow({ lut_number: "  " }, null).exportsUnderLut).toBeFalsy();
    expect(profileFromRow({}, null).exportsUnderLut).toBeFalsy();
  });
});
