/* R-1998 — one bank receipt shared across a project's open instalments (R-1910 audit, "ONE path").
   Owner's examples: kist 1 + kist 2 of ₹1,18,000 each; a ₹1,50,000 receipt (kist 1 full + part of
   kist 2); ₹2,12,400 in the bank + ₹23,600 TDS for both kists; more money than is due. */
import { describe, expect, it } from "vitest";
import {
  fifoAllocate, receiptCheck, pickProjectForReceipt, projectReceiptPayload, hintLink, projectsForPicker,
} from "./project-receipt-allocation";

const kists = [
  { id: "k1", seq: 1, remaining: 118000 },
  { id: "k2", seq: 2, remaining: 118000 },
  { id: "k3", seq: 3, remaining: 118000 },
];

describe("fifoAllocate — oldest instalment first, up to what the receipt settles", () => {
  it("exact one kist", () => {
    expect(fifoAllocate(118000, kists)).toEqual({ lines: [{ id: "k1", amount: 118000 }], leftover: 0 });
  });
  it("one receipt pays 2 kists (R-1910 case 2)", () => {
    expect(fifoAllocate(236000, kists)).toEqual({
      lines: [{ id: "k1", amount: 118000 }, { id: "k2", amount: 118000 }], leftover: 0,
    });
  });
  it("the last kist ticked is part-paid", () => {
    expect(fifoAllocate(150000, kists)).toEqual({
      lines: [{ id: "k1", amount: 118000 }, { id: "k2", amount: 32000 }], leftover: 0,
    });
  });
  it("sorts by seq, not by list order", () => {
    const r = fifoAllocate(118000, [kists[1], kists[0]]);
    expect(r.lines).toEqual([{ id: "k1", amount: 118000 }]);
  });
  it("more than every open kist → the extra is left over, never put on a kist", () => {
    expect(fifoAllocate(400000, kists)).toEqual({
      lines: kists.map((k) => ({ id: k.id, amount: 118000 })), leftover: 46000,
    });
  });
  it("nothing to settle → nothing ticked", () => {
    expect(fifoAllocate(0, kists)).toEqual({ lines: [], leftover: 0 });
  });
});

describe("receiptCheck — bank + TDS must equal the kists ticked", () => {
  it("match", () => expect(receiptCheck(236000, 0, 236000)).toEqual({ state: "match", settled: 236000, diff: 0 }));
  it("TDS makes the sums match", () => {
    expect(receiptCheck(212400, 23600, 236000)).toEqual({ state: "match", settled: 236000, diff: 0 });
  });
  it("short: ticked less than the receipt", () => {
    expect(receiptCheck(236000, 0, 200000)).toEqual({ state: "short", settled: 236000, diff: 36000 });
  });
  it("over: ticked more than the receipt", () => {
    expect(receiptCheck(212400, 0, 236000)).toEqual({ state: "over", settled: 212400, diff: 23600 });
  });
});

describe("pickProjectForReceipt — so the owner does not have to pick", () => {
  const projects = [
    { id: "p1", customerId: "c1", milestones: [{ id: "a", seq: 1, remaining: 50000 }] },
    { id: "p2", customerId: "c2", milestones: [{ id: "b", seq: 1, remaining: 118000 }, { id: "c", seq: 2, remaining: 118000 }] },
    { id: "p3", customerId: "c2", milestones: [] },
  ];
  it("the guessed customer's only open project", () => expect(pickProjectForReceipt(projects, "c2", 1)).toBe("p2"));
  it("no guess → the one project whose oldest kists add up to the receipt", () => {
    expect(pickProjectForReceipt(projects, null, 236000)).toBe("p2");
  });
  it("two candidates → none (the owner picks)", () => {
    const two = [...projects, { id: "p4", customerId: "c9", milestones: [{ id: "d", seq: 1, remaining: 236000 }] }];
    expect(pickProjectForReceipt(two, null, 236000)).toBeNull();
  });
  it("nothing fits → none", () => expect(pickProjectForReceipt(projects, null, 7)).toBeNull());
});

describe("projectReceiptPayload — what Save sends", () => {
  it("ticked lines with money, oldest first; TDS only when deducted", () => {
    expect(projectReceiptPayload({
      bankTxnId: "t1", projectId: "p2",
      rows: [
        { id: "k2", seq: 2, on: true, amount: 118000, raiseInvoice: false },
        { id: "k1", seq: 1, on: true, amount: 118000, raiseInvoice: true },
        { id: "k3", seq: 3, on: false, amount: 118000, raiseInvoice: true },
        { id: "k4", seq: 4, on: true, amount: 0, raiseInvoice: true },
      ],
      tds: { section: "194J", ratePct: 10, amount: 23600 },
      receivedAt: "2026-10-20", reference: "UTR1",
    })).toEqual({
      bankTxnId: "t1", projectId: "p2",
      allocations: [
        { milestoneId: "k1", amount: 118000, raiseInvoice: true },
        { milestoneId: "k2", amount: 118000, raiseInvoice: false },
      ],
      tds: { section: "194J", ratePct: 10, amount: 23600 },
      receivedAt: "2026-10-20", reference: "UTR1",
    });
  });
  it("no TDS → tds null", () => {
    const p = projectReceiptPayload({
      bankTxnId: "t1", projectId: "p2", rows: [{ id: "k1", seq: 1, on: true, amount: 5, raiseInvoice: true }],
      tds: null, receivedAt: null, reference: null,
    });
    expect(p.tds).toBeNull();
  });
});

describe("hintLink — the RPC's hint as the 'what to do next' link (§24)", () => {
  it("banking / project / projects", () => {
    expect(hintLink("/accounting/banking")).toEqual({ href: "/accounting/banking", label: "Open Banking" });
    expect(hintLink("/projects/abc")).toEqual({ href: "/projects/abc", label: "Open the project" });
    expect(hintLink("/projects")).toEqual({ href: "/projects", label: "Open Projects" });
  });
  it("no hint, or not an app path → no link", () => {
    expect(hintLink(undefined)).toBeNull();
    expect(hintLink("https://evil.example")).toBeNull();
    expect(hintLink("//evil.example")).toBeNull();
  });
});

describe("R-2004 projectsForPicker — the customer chosen wins over the narration guess", () => {
  const ps = [
    { id: "a1", customerId: "c-acme" },
    { id: "b1", customerId: "c-bharat" },
    { id: "a2", customerId: "c-acme" },
  ];
  it("customer chosen → only that customer's projects (the guess is ignored)", () => {
    expect(projectsForPicker(ps, "c-bharat", "c-acme").map((p) => p.id)).toEqual(["b1"]);
  });
  it("no customer, a guess → every project, the guessed customer's first", () => {
    expect(projectsForPicker(ps, null, "c-bharat").map((p) => p.id)).toEqual(["b1", "a1", "a2"]);
  });
  it("no customer, no guess → every project as is", () => {
    expect(projectsForPicker(ps, null, null).map((p) => p.id)).toEqual(["a1", "b1", "a2"]);
  });
});
