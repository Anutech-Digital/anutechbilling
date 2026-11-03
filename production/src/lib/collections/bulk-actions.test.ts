/**
 * R-2413 — Payment Follow-up bulk actions: tick rows → Assign owner / Send reminder / Send
 * statement. Owner's path (card R-2413, staging 3 Nov): 22 of 22 rows "Unassigned", chased one
 * by one. Who is skipped, and why, is the rule under test.
 */
import { describe, expect, it } from "vitest";
import {
  BULK_NEEDS_ROLE, assignChoices, bulkAssignReport, bulkAssignRequests, bulkSendReport, bulkSendTargets,
  mayBulkCollect, skipSummary,
} from "./bulk-actions";
import type { CollectionRow, OwedItem } from "@/lib/queries/collections";

const TODAY = "2026-11-03";

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

describe("R-2413 who may use the bulk bar", () => {
  it("owner, manager, accountant — nobody else (same people who may give a follow-up away)", () => {
    expect(["owner", "manager", "accountant"].map(mayBulkCollect)).toEqual([true, true, true]);
    expect(["billing", "sales", "support", "viewer", "", null, undefined].map(mayBulkCollect)).toEqual([false, false, false, false, false, false, false]);
    expect(BULK_NEEDS_ROLE).toMatch(/owner, manager or accountant/);
  });
});

describe("R-2413 Send reminder — who is skipped and why", () => {
  const late = row("late", { days: 12, due: 11_800 });
  const promised = row("promised", { days: 20, due: 5_900, hold: { kind: "promise", until: "2026-11-06", amount: 5_900 } });
  const disputed = row("disputed", { days: 40, due: 2_360, hold: { kind: "dispute", since: "2026-10-30", reason: "wrong rate", entryId: "f1" } });
  const notDue = row("notdue", { days: -5, due: 3_000 });
  const noCustomer = row("nocust", { customerId: null, customerHref: null });
  const renewalOnly = row("renewal", { due: 0, days: 3, renewalAmount: 3_250 });

  it("sends only to late customers that are not on hold; every other row is named with its reason", () => {
    const out = bulkSendTargets([late, promised, disputed, notDue, noCustomer, renewalOnly], "reminder");
    expect(out.send.map((r) => r.key)).toEqual(["late"]);
    expect(out.skipped.map((s) => [s.row.key, s.reason])).toEqual([
      ["promised", "promised to pay on 6 Nov 2026 — reminders paused"],
      ["disputed", "disputes the bill — reminders paused"],
      ["notdue", "nothing is late yet"],
      ["nocust", "no customer record on this bill"],
      ["renewal", "owes nothing yet (renewal not invoiced)"],
    ]);
  });

  it("a customer late only on a renewal (bills not due yet) is 'nothing is late yet'", () => {
    const mixed = row("mixed", { days: 4, due: 2_000, items: [item("INV-m", 2_000, -3)] });
    expect(bulkSendTargets([mixed], "reminder").skipped[0].reason).toBe("nothing is late yet");
  });

  it("Send statement goes to everyone who owes money — not due and promised included, a dispute still skipped", () => {
    const out = bulkSendTargets([late, promised, disputed, notDue, noCustomer, renewalOnly], "statement");
    expect(out.send.map((r) => r.key)).toEqual(["late", "promised", "notdue"]);
    expect(out.skipped.map((s) => s.row.key)).toEqual(["disputed", "nocust", "renewal"]);
  });

  it("the skip summary groups by reason, most first", () => {
    const out = bulkSendTargets([promised, notDue, row("n2", { days: 0 }), disputed], "reminder");
    expect(skipSummary(out.skipped)).toBe("2 nothing is late yet · 1 promised to pay on 6 Nov 2026 — reminders paused · 1 disputes the bill — reminders paused");
    expect(skipSummary([])).toBe("");
  });
});

describe("R-2413 Assign owner", () => {
  const team = new Map([["u-ravi", "Ravi"], ["u-asha", "Asha"]]);
  const a = row("a", { ownerId: "u-ravi" });
  const b = row("b", { ownerId: null });
  const c = row("c", { ownerId: "u-asha", nextFollowUpOn: "2026-11-10" });
  const d = row("d", { customerId: null });

  it("suggests 'each customer's account manager' first when any ticked customer has one", () => {
    expect(assignChoices([a, b], team)).toEqual({ suggestManagers: true, managersCovered: 1, total: 2 });
    expect(assignChoices([b], team)).toEqual({ suggestManagers: false, managersCovered: 0, total: 1 });
  });

  it("account-manager mode: each row goes to its own manager; no manager → skipped with the fix", () => {
    const out = bulkAssignRequests([a, b, c, d], { mode: "managers" }, team, TODAY);
    expect(out.requests.map((r) => [r.row.key, r.body.assignedTo, r.body.note])).toEqual([
      ["a", "u-ravi", "Payment follow-up owner: Ravi"],
      ["c", "u-asha", "Payment follow-up owner: Asha"],
    ]);
    expect(out.skipped.map((s) => [s.row.key, s.reason])).toEqual([
      ["b", "no account manager on this customer — pick a person instead"],
      ["d", "no customer record on this bill"],
    ]);
  });

  it("one-person mode: every ticked row with a customer goes to that person", () => {
    const out = bulkAssignRequests([a, b, c, d], { mode: "person", id: "u-asha", name: "Asha" }, team, TODAY);
    expect(out.requests.map((r) => r.body.assignedTo)).toEqual(["u-asha", "u-asha", "u-asha"]);
    expect(out.skipped.map((s) => s.row.key)).toEqual(["d"]);
  });

  it("keeps a future next follow-up date, else today + 3 (every entry needs one)", () => {
    const out = bulkAssignRequests([a, c, row("e", { nextFollowUpOn: "2026-10-01" })], { mode: "person", id: "u-ravi", name: "Ravi" }, team, TODAY);
    expect(out.requests.map((r) => r.body.nextFollowUpOn)).toEqual(["2026-11-06", "2026-11-10", "2026-11-06"]);
    expect(out.requests.every((r) => r.body.kind === "note" && r.body.customerId)).toBe(true);
  });

  it("the report names who failed and what to do (§24)", () => {
    expect(bulkAssignReport(3, [])).toEqual({ tone: "success", title: "3 customers given an owner" });
    const m = bulkAssignReport(1, [{ name: "Customer b", error: "no account manager on this customer — pick a person instead" }]);
    expect(m.tone).toBe("warning");
    expect(m.title).toBe("1 given an owner, 1 not saved");
    expect(m.description).toMatch(/Customer b — no account manager/);
    expect(m.description).toMatch(/They stay ticked — press Assign owner again/);
    expect(m.description).not.toMatch(/Retry failed/);   // there is no such button on this page
    expect(bulkAssignReport(0, [{ name: "x", error: "403" }]).tone).toBe("error");
  });

  it("planned skips are not failures: success, with the skipped count and why", () => {
    const m = bulkAssignReport(2, [], [{ row: b, reason: "no account manager on this customer — pick a person instead" }]);
    expect(m.tone).toBe("success");
    expect(m.title).toBe("2 customers given an owner · 1 skipped (1 no account manager on this customer — pick a person instead)");
  });

  it("a manager who left (inactive) is named as such, not as 'no account manager'", () => {
    const left = row("f", { ownerId: "u-gone" });
    const out = bulkAssignRequests([left], { mode: "managers" }, team, TODAY, new Set(["u-gone"]));
    expect(out.skipped[0].reason).toBe("their account manager is no longer active — pick a person instead");
  });
});

describe("R-2413 bulk send report", () => {
  it("counts sent, already sent and failed; names the failed", () => {
    expect(bulkSendReport("reminder", { sent: 4, already: 0, failed: [] })).toEqual({ tone: "success", title: "4 reminders emailed" });
    expect(bulkSendReport("statement", { sent: 1, already: 1, failed: [] }).title).toBe("1 statement emailed · 1 had already gone (not sent again)");
    const m = bulkSendReport("reminder", { sent: 2, already: 0, failed: [{ name: "Acme", error: "Email is not set up" }] });
    expect(m.tone).toBe("warning");
    expect(m.description).toMatch(/Acme — Email is not set up/);
    expect(bulkSendReport("reminder", { sent: 0, already: 0, failed: [{ name: "A", error: "x" }] }).tone).toBe("error");
  });

  it("emailed but follow-up not logged → a warning that says log it, never send again", () => {
    const m = bulkSendReport("reminder", { sent: 3, already: 0, failed: [], unlogged: ["Acme"] });
    expect(m.tone).toBe("warning");
    expect(m.title).toBe("3 reminders emailed");
    expect(m.description).toBe("Emailed, but the follow-up was not logged for Acme — log it with Follow-up, do not send again.");
  });
});
