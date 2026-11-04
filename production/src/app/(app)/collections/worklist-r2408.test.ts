/**
 * R-2408 — Payment Follow-up worklist: age tiles (count + ₹, click = filter, sum to the list),
 * Not due yet hidden by default, search / owner / sort, one next-step per row, renewal rows show
 * their amount, and "No follow-up for 7+ days" counts only late customers.
 *
 * Shaped on the localhost audit (3 Nov): 16 rows, 12 of them "Not due yet", and the 7+ days box
 * listing those as "Never followed up".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGE_KEYS, DEFAULT_AGE, ageBucket, ageMatches, ageTiles, amountCell, buildWorklist,
  hasOverdueLine, matchesSearch, nextAction, ownerKey, ownerKeys, sortRows, UNASSIGNED,
} from "./worklist";
import { buildWeeklyReport } from "@/lib/collections/weekly-report";
import type { CollectionRow, OwedItem } from "@/lib/queries/collections";

const item = (id: string, amountDue: number, daysOverdue: number): OwedItem => ({
  kind: "invoice", id, label: id, href: `/invoices/${id}`, quoteId: null, quoteHref: null, subscriptionHref: null,
  amountDue, daysOverdue, tdsHint: null,
});

function row(key: string, p: Partial<CollectionRow> & { days?: number; due?: number } = {}): CollectionRow {
  const days = p.days ?? 10;
  const due = p.due ?? 1000;
  const { days: _d, due: _a, ...rest } = p;
  void _d; void _a;
  return {
    key, customerId: key, customerName: `Customer ${key}`, customerHref: `/customers/${key}`,
    ownerId: null, assignedTo: null,
    items: due > 0 ? [item(`INV-${key}`, due, days)] : [],
    amountDue: due, renewals: [], renewalAmount: 0, daysOverdue: days,
    promisedOn: null, promisedAmount: null, promiseStatus: null, promiseBroken: false,
    payments: [], nextFollowUpOn: null, followUpDue: false, lastNote: null, lastNoteOn: null,
    hold: null, stage: "notContacted", priorityScore: 0,
    ...rest,
  };
}

/* 16 customers: 4 late (one in each bucket) + 12 not due yet; one renewal-only row overdue. */
const lateRows = [
  row("a", { days: 5, due: 11_800 }),
  row("b", { days: 45, due: 5_900, ownerId: "u-ravi" }),
  row("c", { days: 75, due: 23_600, assignedTo: "u-asha", ownerId: "u-ravi" }),
  row("d", { days: 172, due: 55 }),
];
const notDue = Array.from({ length: 12 }, (_, i) => row(`n${i}`, { days: -(i + 1), due: 1_000 + i }));
const renewalOnly = row("r", {
  days: 3, due: 0, renewalAmount: 3_250,
  renewals: [{
    kind: "renewal", id: "sub-r", label: "acme.in", href: "/subscriptions/sub-r", quoteId: null, quoteHref: null,
    amount: 3_250, estimate: true, daysOverdue: 3, renewalDate: "2026-10-31",
    sub: {} as CollectionRow["renewals"][number]["sub"],
  }],
});
const rows = [...lateRows, ...notDue, renewalOnly];
const base = { q: "", owner: "", age: DEFAULT_AGE, sort: "priority" as const };

describe("R-2408 age buckets", () => {
  it("days → bucket: ≤0 not due, 1–30, 31–60, 61–90, 90+", () => {
    expect([-5, 0, 1, 30, 31, 60, 61, 90, 91, 400].map(ageBucket))
      .toEqual(["notDue", "notDue", "d30", "d30", "d60", "d60", "d90", "d90", "d90plus", "d90plus"]);
  });

  it("tiles: count + whole-rupee ₹ per bucket; Overdue = the four late buckets; renewals apart", () => {
    const t = ageTiles(rows);
    expect(t.d30).toEqual({ count: 2, amount: 11_800, renewals: 3_250 });
    expect(t.d60).toEqual({ count: 1, amount: 5_900, renewals: 0 });
    expect(t.d90).toEqual({ count: 1, amount: 23_600, renewals: 0 });
    expect(t.d90plus).toEqual({ count: 1, amount: 55, renewals: 0 });
    expect(t.notDue.count).toBe(12);
    expect(t.overdue.count).toBe(t.d30.count + t.d60.count + t.d90.count + t.d90plus.count);
    expect(t.overdue.amount).toBe(t.d30.amount + t.d60.amount + t.d90.amount + t.d90plus.amount);
  });

  it("the tiles add up to the whole list (Overdue + Not due yet = every customer, every rupee)", () => {
    const w = buildWorklist(rows, { ...base, age: "all" });
    expect(w.tiles.overdue.count + w.tiles.notDue.count).toBe(w.shown.length);
    expect(w.tiles.overdue.amount + w.tiles.notDue.amount).toBe(w.total);
    expect(w.tiles.overdue.renewals + w.tiles.notDue.renewals).toBe(w.renewalTotal);
  });

  for (const key of AGE_KEYS) {
    it(`a click on "${key}" lists exactly the customers its count and ₹ add up`, () => {
      const w = buildWorklist(rows, { ...base, age: key });
      expect(w.shown.length).toBe(w.tiles[key].count);
      expect(w.total).toBe(w.tiles[key].amount);
    });
  }

  it("default view hides Not due yet — the audit's 12 not-due rows are not in the chase list", () => {
    const w = buildWorklist(rows, base);
    expect(DEFAULT_AGE).toBe("overdue");
    expect(w.shown.map((r) => r.key).sort()).toEqual(["a", "b", "c", "d", "r"]);
    expect(w.shown.every((r) => r.daysOverdue > 0)).toBe(true);
    expect(ageMatches("notDue", notDue[0])).toBe(true);
  });
});

describe("R-2408 search / owner / sort", () => {
  it("search by customer name or invoice number, any case", () => {
    expect(matchesSearch(lateRows[1], "customer B")).toBe(true);
    expect(matchesSearch(lateRows[1], "inv-b")).toBe(true);
    expect(matchesSearch(lateRows[1], "zzz")).toBe(false);
    expect(matchesSearch(renewalOnly, "ACME")).toBe(true);
    const w = buildWorklist(rows, { ...base, q: "customer c" });
    expect(w.shown.map((r) => r.key)).toEqual(["c"]);
    /* the tiles follow the search too, so they still add up to what is listed */
    expect(w.tiles.overdue.count).toBe(1);
  });

  it("owner = the follow-up's assignee, else the account manager, else Unassigned", () => {
    expect(ownerKey(lateRows[2])).toBe("u-asha");
    expect(ownerKey(lateRows[1])).toBe("u-ravi");
    expect(ownerKey(lateRows[0])).toBe(UNASSIGNED);
    expect(ownerKeys(rows)).toEqual(["u-asha", "u-ravi", UNASSIGNED]);
    expect(buildWorklist(rows, { ...base, owner: "u-ravi" }).shown.map((r) => r.key)).toEqual(["b"]);
    expect(buildWorklist(rows, { ...base, owner: UNASSIGNED }).shown.map((r) => r.key).sort()).toEqual(["a", "d", "r"]);
  });

  it("sort by days late or by amount", () => {
    expect(sortRows(lateRows, "daysLate").map((r) => r.key)).toEqual(["d", "c", "b", "a"]);
    expect(sortRows(lateRows, "amount").map((r) => r.key)).toEqual(["c", "a", "b", "d"]);
    /* priority keeps the order the list was built in (today's work first) */
    expect(sortRows(lateRows, "priority").map((r) => r.key)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("R-2408 one next step per row", () => {
  it("Record payment when the promise falls today and the person may record money; else Follow-up", () => {
    const today = row("t", { promiseStatus: "due", promisedOn: "2026-11-03" });
    expect(nextAction(today, true)).toBe("pay");
    expect(nextAction(today, false)).toBe("followup");
    expect(nextAction(row("x", { promiseStatus: "broken", promiseBroken: true }), true)).toBe("followup");
    expect(nextAction(row("y"), true)).toBe("followup");
    expect(nextAction({ ...renewalOnly, promiseStatus: "due" }, true)).toBe("followup");
    expect(nextAction(row("z", { customerId: null }), true)).toBe("none");
  });

  it("a renewal-only row shows its renewal amount in Amount due (was '—')", () => {
    expect(amountCell(renewalOnly)).toEqual({ main: 3_250, kind: "renewal", extraRenewal: 0 });
    expect(amountCell(row("m", { due: 900, renewalAmount: 100 }))).toEqual({ main: 900, kind: "due", extraRenewal: 100 });
  });
});

describe("R-2408 'No follow-up for 7+ days' counts only overdue customers", () => {
  it("hasOverdueLine: a late line with money on it", () => {
    expect(hasOverdueLine(lateRows[0])).toBe(true);
    expect(hasOverdueLine(notDue[0])).toBe(false);
    expect(hasOverdueLine(renewalOnly)).toBe(false);
  });

  it("not-due customers are no longer listed as 'Never followed up'", () => {
    const owing = [...lateRows, ...notDue].map((r) => ({ customerId: r.customerId!, customerName: r.customerName, amountDue: r.amountDue, overdue: hasOverdueLine(r) }));
    const report = buildWeeklyReport({ today: "2026-11-03", owing, followups: [], payments: [] });
    expect(report.quiet.map((q) => q.customerId).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("callers that do not pass `overdue` keep the old behaviour", () => {
    const report = buildWeeklyReport({ today: "2026-11-03", owing: [{ customerId: "x", customerName: "X", amountDue: 10 }], followups: [], payments: [] });
    expect(report.quiet).toHaveLength(1);
  });
});

describe("R-2408 page wiring", () => {
  const page = readFileSync("src/app/(app)/collections/page.tsx", "utf8");
  const actions = readFileSync("src/app/(app)/collections/row-actions.tsx", "utf8");
  const tiles = readFileSync("src/app/(app)/collections/age-tiles.tsx", "utf8");

  it("order: tiles → list → This week report (folded under it)", () => {
    const iTiles = page.indexOf("<AgeTileRow");
    const iTable = page.indexOf("<table");
    const iReport = page.indexOf("<CollectionsOwnerReport");
    expect(iTiles).toBeGreaterThan(-1);
    expect(iTiles).toBeLessThan(iTable);
    expect(iTable).toBeLessThan(iReport);
    expect(page).toMatch(/aria-expanded=\{reportOpen\}/);
    expect(page).toMatch(/\{reportOpen && <CollectionsOwnerReport owing=\{owing\} \/>\}/);
  });

  it("the table shows the worklist (filtered by tile / search / owner / sort), Overdue by default", () => {
    expect(page).toMatch(/buildWorklist\(viewRows, \{ q, owner, age, sort \}\)/);
    /* R-2409: Overdue by default; the Today view shows every age. */
    expect(page).toMatch(/const ageDefault: AgeView = view === "today" \? "all" : DEFAULT_AGE;/);
    expect(page).toMatch(/useUrlChoice<AgeView>\("age", AGE_VIEWS, ageDefault\)/);
    expect(page).toMatch(/<AgeTileRow tiles=\{list\.tiles\} active=\{age\} onPick=\{pickTile\} \/>/);
    expect(page).toMatch(/age === key \? ageDefault : key/);
  });

  it("rows carry one next-step button + ⋯ menu; the 4 stacked buttons are gone", () => {
    expect(page).not.toMatch(/<RemindButton|<DuesButton|<PayButton|<FollowupButton/);
    expect((page.match(/<RowActions\b/g) ?? []).length).toBe(2);   // table + phone card
    expect(actions).toMatch(/<DropdownMenuTrigger asChild>/);
    /* R-2413: "Remind" + "Send pending dues" became ONE "Send reminder" (R-2412's dialog). */
    for (const label of ["Follow-up", "Send reminder", "Record payment"]) expect(actions).toContain(label);
    expect(actions).not.toMatch(/\/> (Remind|Send pending dues)\s*</);
    expect((actions.match(/<DropdownMenuItem\b/g) ?? []).length).toBe(3);   // Follow-up, Send reminder, Record payment
  });

  it("the ⋯ menu opens the existing dialogs (not new ones) — one Send reminder dialog since R-2413", () => {
    for (const d of ["<FollowupDialog", "<SendReminderDialog", "<MultiInvoicePaymentDialog"]) expect(page).toContain(d);
    expect(page).not.toMatch(/<ReminderDialog|<PendingDuesDialog/);
  });

  it("every tile is a button that says whether it is pressed", () => {
    expect(tiles).toMatch(/<button[\s\S]*?type="button"[\s\S]*?aria-pressed=\{active === key\}/);
    expect(tiles).toMatch(/AGE_KEYS\.map/);
  });
});
