/**
 * R-2817 (Renewals 12-question audit, 14 Nov 2026 — Q2 "one day count"): ONE anchor date per row.
 *
 * Found on localhost (E2E Test Co):
 *   Greentin Check 2095 — renews 31 Oct, its part (1 Oct – 1 Nov) due 1 Oct unpaid: the Due column said
 *     "31 Oct 26 · 14d ago", the chip "Overdue 44d · part due 1 Oct 2026".
 *   SCN Bit Labs — renews 12 Nov (Overdue tab), its part billed on 12 Nov with 2 days to pay (due 14 Nov):
 *     the chip said "Due today · part due 14 Nov 2026" inside the Overdue tab.
 * Rule: the anchor is the EARLIEST date this renewal's money fell due — the open part's due date or
 * renewal_date, whichever is earlier. Chip, chip note, Due column, drawer and the AI / At-risk words
 * all count from it. Tabs stay on renewal_date, so an Overdue-tab row (renewal_date passed) always
 * has an anchor in the past: never "Due today".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renewalStage, rowAnchor, type StageInput, type StageSub } from "./stage";
import { istToday } from "@/lib/dates/ist";
import { daysUntilRenewal } from "./buckets";
import { dueCellFacts } from "@/app/(app)/renewals/due-anchor";
import { stageOverdueWords } from "@/app/(app)/renewals/risk";

const TODAY = "2026-11-14";

/** Greentin Check 2095 as on the local DB: monthly, renews 31 Oct, part 1 Oct due 1 Oct (sent proforma). */
const greentin: StageSub = {
  status: "active", renewal_state: "renewed", renewal_date: "2026-10-31", term_months: 1,
  billing_cycle: "monthly", start_date: "2026-09-01", auto_renew: true, grace_until: null, renewal_quote_id: null,
};
/** SCN Bit Labs as on the local DB: monthly, renews 12 Nov, part 12 Nov – 12 Dec billed 12 Nov, due 14 Nov. */
const scn: StageSub = { ...greentin, renewal_state: "pending", renewal_date: "2026-11-12", start_date: "2026-09-12" };

const stage = (sub: StageSub, rest: Omit<StageInput, "sub" | "todayIst"> = {}, today = TODAY) => renewalStage({ sub, todayIst: today, ...rest });
const partDoc = (dueDate: string | null, status = "sent") => ({ doc: { kind: "part" as const, quoteId: "Q-P", status, dueDate, period: "Nov 2026" } });

describe("R-2817 rowAnchor — the earliest date the renewal's money fell due", () => {
  it("part due before renewal_date → the part's date", () => {
    expect(rowAnchor("2026-10-31", "2026-10-01", TODAY)).toEqual({ date: "2026-10-01", kind: "part", days: -44 });
  });
  it("part due after a passed renewal_date → the renewal date (never 'Due today' on an Overdue row)", () => {
    expect(rowAnchor("2026-11-12", "2026-11-14", TODAY)).toEqual({ date: "2026-11-12", kind: "renewal", days: -2 });
  });
  it("same date, no part, no renewal date", () => {
    expect(rowAnchor("2026-11-20", "2026-11-20", TODAY)).toEqual({ date: "2026-11-20", kind: "renewal", days: 6 });
    expect(rowAnchor("2026-11-20", null, TODAY)).toEqual({ date: "2026-11-20", kind: "renewal", days: 6 });
    expect(rowAnchor(null, "2026-11-20", TODAY)).toEqual({ date: "2026-11-20", kind: "part", days: 6 });
    expect(rowAnchor(null, null, TODAY)).toEqual({ date: null, kind: "renewal", days: null });
  });
  it("reads only the date part of a timestamp", () => {
    expect(rowAnchor("2026-11-12T00:00:00Z", "2026-10-01T00:00:00Z", TODAY).date).toBe("2026-10-01");
  });
});

describe("R-2817 renewalStage — chip, note and days count from the anchor", () => {
  it("Greentin Check: chip and anchor both 44d from the part's due date", () => {
    const s = stage(greentin, partDoc("2026-10-01"));
    expect(s).toMatchObject({ key: "sent", days: -44, anchorDate: "2026-10-01", anchorKind: "part", renewalDays: -14 });
    expect(s.note).toBe("Overdue 44d · part due 1 Oct 2026");
  });

  it("SCN Bit Labs: 2d from the renewal date; the part bill (due today) is not called overdue, never 'Due today'", () => {
    const s = stage(scn, partDoc("2026-11-14"));
    expect(s).toMatchObject({ key: "sent", days: -2, anchorDate: "2026-11-12", anchorKind: "renewal" });
    expect(s.note).toBe("Renewal date 2d ago · part due 14 Nov 2026");
    expect(`${s.label} ${s.note}`).not.toMatch(/Due today/);
    /* once the part bill is late too, it is plain overdue (from the earlier date) */
    expect(stage(scn, partDoc("2026-11-13")).note).toBe("Overdue 2d · part due 13 Nov 2026");
  });

  it("a draft part quote counts the same way", () => {
    const s = stage(scn, partDoc("2026-11-14", "draft"));
    expect(s).toMatchObject({ key: "draft", days: -2, anchorDate: "2026-11-12" });
  });

  it("invoiced part: days from the anchor; 'overdue' only when the bill is past its own due date", () => {
    const inv = (dueDate: string) => ({ invoice: { id: "INV-P", kind: "part" as const, amountDue: 3835, dueDate } });
    const g = stage(greentin, inv("2026-10-01"));
    expect(g).toMatchObject({ key: "invoiced", days: -44, anchorDate: "2026-10-01", anchorKind: "part" });
    expect(g.label).toBe("Invoiced · ₹3,835 overdue 44d");
    const s = stage(scn, inv("2026-11-14"));
    expect(s).toMatchObject({ days: -2, anchorDate: "2026-11-12", anchorKind: "renewal" });
    expect(s.label).toBe("Invoiced · ₹3,835 due");
    expect(s.note).toBe("Renewal date 2d ago · part due 14 Nov 2026");
    expect(s.partDueDate).toBe("2026-11-14");
  });

  it("a whole-term renewal quote / invoice counts from renewal_date (its own due date is not a part's)", () => {
    const sub = { ...scn, billing_cycle: "yearly", term_months: 12, renewal_quote_id: "Q-R" };
    const q = stage(sub, { doc: { kind: "renewal", quoteId: "Q-R", status: "sent", dueDate: "2026-10-01" } });
    expect(q).toMatchObject({ days: -2, anchorDate: "2026-11-12", anchorKind: "renewal" });
    expect(q.note).toBe("Overdue 2d");
    const i = stage(sub, { invoice: { id: "INV-R", kind: "renewal", amountDue: 100, dueDate: "2026-10-01" } });
    expect(i).toMatchObject({ days: -2, anchorDate: "2026-11-12" });
  });

  it("due / part-due / ending / stopped / renewed rows anchor on renewal_date", () => {
    for (const s of [
      stage(scn),
      stage({ ...scn, auto_renew: false }),
      stage({ ...scn, status: "suspended" }),
      stage(scn, { renewalPaid: true }),
    ]) {
      expect(s).toMatchObject({ anchorDate: "2026-11-12", anchorKind: "renewal", days: -2 });
    }
    const none = stage({ ...scn, renewal_date: null });
    expect(none).toMatchObject({ anchorDate: null, days: null, label: "No renewal date" });
  });

  it("Overdue-tab invariant: renewal_date passed → days < 0 and never 'Due today' / 'Due in', whatever the part's date", () => {
    const parts = ["2026-11-14", "2026-11-20", "2026-12-31", "2026-10-01", null];
    for (const due of parts) {
      for (const st of ["sent", "viewed", "accepted", "draft"]) {
        const s = stage(scn, partDoc(due, st));
        expect(s.days, `${st} ${due}`).toBeLessThan(0);
        expect(`${s.label} ${s.note ?? ""}`).not.toMatch(/Due today|Due in/);
      }
      if (due) {
        const s = stage(scn, { invoice: { id: "I", kind: "part", amountDue: 1, dueDate: due } });
        expect(s.days).toBeLessThan(0);
        expect(`${s.label} ${s.note ?? ""}`).not.toMatch(/Due today|Due in/);
        expect(s.label).toMatch(due < TODAY ? /overdue (2|44)d$/ : / due$/);
      }
    }
  });
});

describe("R-2817 Due column and AI words read the same anchor", () => {
  it("Due column = the chip's date and day count; the tooltip names both dates", () => {
    const s = stage(greentin, partDoc("2026-10-01"));
    const due = dueCellFacts(s, greentin, -14);
    expect(due).toEqual({ date: "2026-10-01", days: -44, title: "Part due 1 Oct 2026 · renews 31 Oct 2026" });
    const n = stage(scn, partDoc("2026-11-14"));
    expect(dueCellFacts(n, scn, -2)).toEqual({ date: "2026-11-12", days: -2, title: "Renews 12 Nov 2026 · part due 14 Nov 2026" });
  });

  it("no stage yet (documents loading) → the renewal date and its own day count, no guessed part date", () => {
    expect(dueCellFacts(null, scn, -2)).toEqual({ date: "2026-11-12", days: -2, title: "Renews 12 Nov 2026" });
    expect(dueCellFacts(null, { ...scn, renewal_date: null }, 0)).toEqual({ date: null, days: null, title: null });
  });

  it("At-risk / Renewal AI words use the anchor's kind and date", () => {
    expect(stageOverdueWords(stage(greentin, partDoc("2026-10-01")), TODAY)).toBe("Part due 44d ago (1 Oct 2026)");
    /* SCN: counted from the renewal date — not called a part date even though a part exists */
    expect(stageOverdueWords(stage(scn, partDoc("2026-11-14")), TODAY)).toBe("Renewal date passed 2d ago (12 Nov 2026)");
    /* an invoiced part still inside its terms is not "Invoice overdue" */
    const inv = { invoice: { id: "I", kind: "part" as const, amountDue: 1, dueDate: "2026-11-14" } };
    expect(stageOverdueWords(stage(scn, inv), TODAY)).toBe("Renewal date passed 2d ago (12 Nov 2026)");
    expect(stageOverdueWords(stage(greentin, { invoice: { ...inv.invoice, dueDate: "2026-10-01" } }), TODAY)).toBe("Part bill overdue 44d (due 1 Oct 2026)");
  });
});

describe("R-2817 IST midnight — chip and Due column move together (frozen clock)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("23:59 IST 14 Nov vs 00:01 IST 15 Nov", () => {
    for (const [utc, ist, expected] of [
      ["2026-11-14T18:29:00Z", "2026-11-14", -44],
      ["2026-11-14T18:31:00Z", "2026-11-15", -45],
    ] as const) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(utc));
      const todayIst = istToday();
      expect(todayIst).toBe(ist);
      const s = stage(greentin, partDoc("2026-10-01"), todayIst);
      /* the loading fallback (daysUntilRenewal, a Date) agrees with the IST string count */
      const fallback = daysUntilRenewal(greentin.renewal_date!, new Date());
      expect(fallback).toBe(rowAnchor(greentin.renewal_date, null, todayIst).days);
      const due = dueCellFacts(s, greentin, fallback);
      expect(s.days).toBe(expected);
      expect(due.days).toBe(s.days);
      expect(s.note).toBe(`Overdue ${-expected}d · part due 1 Oct 2026`);
      vi.useRealTimers();
    }
  });
});

describe("R-2817 review fixes", () => {
  it("a stopped / ending row owing a part counts days from the same anchor as its note", () => {
    const sub = { ...greentin, status: "suspended" };
    const s = stage(sub, partDoc("2026-10-01"));
    expect(s).toMatchObject({ key: "stopped", days: -44, anchorDate: "2026-10-01", anchorKind: "part" });
    expect(s.note).toMatch(/Overdue 44d · part due 1 Oct 2026$/);
    expect(s.renewalDays).toBe(-14);
    const e = stage({ ...greentin, auto_renew: false }, partDoc("2026-10-01"));
    expect(e).toMatchObject({ key: "ending", days: -44, anchorDate: "2026-10-01" });
  });
});
