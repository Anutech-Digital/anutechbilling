/**
 * R-2410 — Small leftovers. Owner's staging examples (3 Nov): ₹55 (172 days late), ₹1 (157 days)
 * and ₹432 "may be TDS 194J 2%" sat on top of the chase list.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SMALL_LEFTOVER_LIMIT, isSmallLeftover, isTdsLeftoverLine, leftoverLines, mayCloseLeftovers, splitLeftovers,
} from "./small-leftovers";
import { buildCollectionRows, tdsHint, type CollectionRow, type OwedItem } from "@/lib/queries/collections";
import { matchTdsShortfall } from "@/lib/accounting/tds-match";

const item = (id: string, amountDue: number, daysOverdue: number, p: Partial<OwedItem> = {}): OwedItem => ({
  kind: "invoice", id, label: id, href: `/invoices/${id}`, quoteId: null, quoteHref: null, subscriptionHref: null,
  amountDue, daysOverdue, tdsHint: null, ...p,
});
function row(key: string, items: OwedItem[], p: Partial<CollectionRow> = {}): CollectionRow {
  return {
    key, customerId: key, customerName: `Customer ${key}`, customerHref: `/customers/${key}`,
    ownerId: null, assignedTo: null, items,
    amountDue: items.reduce((s, i) => s + i.amountDue, 0), renewals: [], renewalAmount: 0,
    daysOverdue: Math.max(0, ...items.map((i) => i.daysOverdue)),
    promisedOn: null, promisedAmount: null, promiseStatus: null, promiseBroken: false,
    payments: [], nextFollowUpOn: null, followUpDue: false, lastNote: null, lastNoteOn: null,
    hold: null, stage: "notContacted", priorityScore: 0, ...p,
  };
}

/* ₹432 = 2% (194J) of a ₹21,600 pre-GST invoice (₹25,488 with 18% GST), customer paid ₹25,056. */
const tds432 = matchTdsShortfall({ totalInclGst: 25_488, received: 25_056, gstRatePct: 18 });

const dust55 = row("dust55", [item("INV-55", 55, 172)]);
const dust1 = row("dust1", [item("INV-1", 1, 157)]);
const tds = row("tds432", [item("INV-432", 432, 40, { tdsHint: tds432 })]);
const bigTds = row("bigtds", [item("INV-A378", 25_500, 20, {
  tdsHint: matchTdsShortfall({ totalInclGst: 300_900, received: 275_400, gstRatePct: 18 }),
})]);
const real = row("real", [item("INV-R", 11_800, 30)]);
const mixed = row("mixed", [item("INV-M1", 300, 50), item("INV-M2", 900, 10)]);

describe("R-2410 which customers are small leftovers", () => {
  it("the TDS fixture really is 194J 2% (₹432)", () => {
    expect(tds432).toMatchObject({ section: "194J", ratePct: 2, tds: 432 });
  });

  it("₹55, ₹1 and the ₹432 TDS line are leftovers; a real ₹11,800 due is not", () => {
    expect(isSmallLeftover(dust55)).toBe(true);
    expect(isSmallLeftover(dust1)).toBe(true);
    expect(isSmallLeftover(tds)).toBe(true);
    expect(isSmallLeftover(real)).toBe(false);
  });

  it("a balance that is exactly TDS is a leftover even above ₹500 (INV-A378 ₹25,500 = 10%)", () => {
    expect(isSmallLeftover(bigTds)).toBe(true);
  });

  it("the limit is the whole balance: ₹500 in, ₹501 out; two lines adding to ₹1,200 stay chased", () => {
    expect(SMALL_LEFTOVER_LIMIT).toBe(500);
    expect(isSmallLeftover(row("x", [item("I", 500, 9)]))).toBe(true);
    expect(isSmallLeftover(row("y", [item("I", 501, 9)]))).toBe(false);
    expect(isSmallLeftover(mixed)).toBe(false);
  });

  it("nothing owed, or a renewal still to chase → stays in the list", () => {
    expect(isSmallLeftover(row("z", []))).toBe(false);
    const withRenewal = row("w", [item("I", 20, 9)], {
      renewals: [{ kind: "renewal", id: "s", label: "acme.in", href: "/s", quoteId: null, quoteHref: null,
        amount: 3000, estimate: true, daysOverdue: 2, renewalDate: "2026-11-01", sub: {} as CollectionRow["renewals"][number]["sub"] }],
    });
    expect(isSmallLeftover(withRenewal)).toBe(false);
  });

  it("splitLeftovers keeps the order of each side", () => {
    const { main, leftovers } = splitLeftovers([real, dust55, mixed, tds]);
    expect(main.map((r) => r.key)).toEqual(["real", "mixed"]);
    expect(leftovers.map((r) => r.key)).toEqual(["dust55", "tds432"]);
  });
});

describe("R-2410 actions per line", () => {
  it("TDS line → Book as TDS (and Write off too while ≤ ₹500); dust → Write off only; oldest first", () => {
    const lines = leftoverLines([tds, dust1, dust55, bigTds]);
    expect(lines.map((l) => [l.item.id, l.reason, l.canBookTds, l.canWriteOff])).toEqual([
      ["INV-55", "small", false, true],
      ["INV-1", "small", false, true],
      ["INV-432", "tds", true, true],
      ["INV-A378", "tds", true, false],
    ]);
  });

  it("a subscription balance (no invoice) can be neither booked nor written off here", () => {
    const sub = row("sub", [item("sub-1", 40, 12, { kind: "subscription" })]);
    const [l] = leftoverLines([sub]);
    expect([l.canBookTds, l.canWriteOff]).toEqual([false, false]);
    expect(isTdsLeftoverLine({ kind: "subscription", amountDue: 40, tdsHint: tds432 })).toBe(false);
  });

  it("only the owner or the accountant closes leftovers (unknown role = not yet)", () => {
    expect(mayCloseLeftovers("owner")).toBe(true);
    expect(mayCloseLeftovers("accountant")).toBe(true);
    for (const r of ["manager", "billing", "sales", null, undefined]) expect(mayCloseLeftovers(r)).toBe(false);
  });
});

describe("R-2410 the owner's real path: collections rows → leftovers", () => {
  it("a part-paid invoice whose ₹432 left is 2% TDS gets the hint from the same collections read", () => {
    const inv = {
      id: "INV-432", customer_id: "c1", customer_name: "Tds Co", amount: 25_488, net_payable: 25_488, paid_amount: 25_056,
      status: "pending", invoice_date: "2026-09-01", due_date: "2026-09-24", quote_id: null, tax_rate: 18,
    };
    expect(tdsHint(inv as never)).toMatchObject({ section: "194J", ratePct: 2 });
    const rows = buildCollectionRows({
      invoices: [inv, { ...inv, id: "INV-55", customer_id: "c2", customer_name: "Dust Co", amount: 11_800, net_payable: 11_800, paid_amount: 11_745 }],
      subscriptions: [], quoteSubscriptions: [], customers: [], followups: [], payments: [], invoicedQuoteIds: new Set(),
    } as never, "2026-11-03");
    const { main, leftovers } = splitLeftovers(rows);
    expect(main).toEqual([]);
    expect(leftovers.map((r) => r.customerName).sort()).toEqual(["Dust Co", "Tds Co"]);
  });
});

describe("R-2410 page wiring (source)", () => {
  const dir = join(__dirname, "..", "..", "app", "(app)", "collections");
  const page = readFileSync(join(dir, "page.tsx"), "utf8");
  const group = readFileSync(join(dir, "small-leftovers.tsx"), "utf8");
  const sheet = readFileSync(join(dir, "leftover-tds-dialog.tsx"), "utf8");

  it("the page splits leftovers out of the tiles + list and shows the folded group", () => {
    expect(page).toMatch(/const \{ main: viewRows, leftovers: viewLeftovers \} = splitLeftovers\(viewAll\);/);
    expect(page).toMatch(/buildWorklist\(viewRows, \{ q, owner, age, sort \}\)/);
    expect(page).toMatch(/<SmallLeftovers rows=\{leftovers\} total=\{leftoverTotal\}/);
    expect(page).toMatch(/todayCounts\(splitLeftovers\(all\)\.main\)/);
  });

  it("the group states the limit, and gates closing to owner / accountant", () => {
    expect(group).toMatch(/Small leftovers \(\{lines\.length\} · \{rupee\(total\)\}\)/);
    expect(group).toMatch(/Balances up to \{rupee\(SMALL_LEFTOVER_LIMIT\)\}/);
    expect(group).toMatch(/mayCloseLeftovers\(role\)/);
    expect(group).toMatch(/Only the owner or the accountant can close them/);
  });

  it("Write off asks a reason and calls the one write-off RPC, then refreshes every balance screen", () => {
    expect(group).toMatch(/useAskText\(\)/);
    expect(group).toMatch(/"write_off_small_invoice_balance"/);
    expect(group).toMatch(/invalidateReceivables\(qc\)/);
  });

  it("Book as TDS reuses the Record payment sheet in TDS mode — no new money call", () => {
    expect(sheet).toMatch(/<RecordPaymentDialog[\s\S]{0,900}tdsOnly=\{tds\}/);
    expect(sheet).toMatch(/<RecordSubscriptionPaymentContainer[^>]*tdsOnly=\{tds\}/);
    expect(sheet).not.toMatch(/\.rpc\(/);
  });
});
