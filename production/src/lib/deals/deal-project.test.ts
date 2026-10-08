import { describe, it, expect } from "vitest";
import { buildDealHistory, filterDealHistory, dealMoney, formatIstDateTime, type DealHistorySources } from "./timeline";
import { dealQuoteRows } from "./deal-quotes";

/* Shaped on the local Excel Technologies deal (L-MUHV91JQ → "Complete Billing System"):
   ₹59,00,000 project, two ₹5,90,000 milestones invoiced and paid (₹5,40,000 bank + ₹50,000
   TDS each), two milestones not yet invoiced. */
const PID = "proj-1";
const excel: DealHistorySources = {
  projects: [{
    id: PID, title: "Complete Billing System", status: "active", total_amount: 5_900_000,
    created_at: "2026-09-26T05:11:45Z", accepted_at: "2026-09-26T05:11:46Z", updated_at: "2026-09-26T05:18:11Z",
  }],
  projectMilestones: [
    { id: "m1", project_id: PID, label: "Pehli kist", total_amount: 590_000, invoice_id: "INV-1" },
    { id: "m2", project_id: PID, label: "Doosri kist", total_amount: 590_000, invoice_id: "INV-3" },
    { id: "m3", project_id: PID, label: "Advance baaki", total_amount: 1_770_000, invoice_id: null },
    { id: "m4", project_id: PID, label: "On delivery", total_amount: 2_950_000, invoice_id: null },
  ],
  projectInvoices: [
    { id: "INV-1", amount: 590_000, net_payable: 0, paid_amount: 0, status: "paid", invoice_date: "2026-08-07", created_at: "2026-09-26T05:11:45Z" },
    { id: "INV-3", amount: 590_000, net_payable: 0, paid_amount: 0, status: "paid", invoice_date: "2026-09-26", created_at: "2026-09-26T06:12:56Z" },
  ],
  projectPayments: [
    { id: "pp1", project_id: PID, milestone_id: "m1", amount: 540_000, method: "bank_transfer", received_at: "2026-08-07", created_at: "2026-09-26T05:11:45Z" },
    { id: "pp2", project_id: PID, milestone_id: "m1", amount: 50_000, method: "tds", received_at: "2026-08-07", created_at: "2026-09-26T05:11:45Z" },
    { id: "pp3", project_id: PID, milestone_id: "m2", amount: 540_000, method: "bank_transfer", received_at: "2026-08-07", created_at: "2026-09-26T05:52:15Z" },
    { id: "pp4", project_id: PID, milestone_id: "m2", amount: 50_000, method: "tds", received_at: "2026-08-07", created_at: "2026-09-26T05:52:15Z" },
  ],
  quotes: [], invoices: [], payments: [],
};

describe("dealMoney — project quotation", () => {
  it("sums project invoices and project_payments (TDS counted as settled)", () => {
    const m = dealMoney(excel);
    expect(m.invoiced).toBe(1_180_000);
    expect(m.paid).toBe(1_180_000);
    expect(m.outstanding).toBe(0);
    expect(m.invoiceCount).toBe(2);
    expect(m.paymentCount).toBe(4);
    expect(m.project).toEqual({ invoiced: 1_180_000, paid: 1_180_000, tds: 100_000, value: 5_900_000, notInvoiced: 4_720_000 });
  });

  it("baaki uses each invoice's own balance (invoiceAmountDue), not invoiced − paid", () => {
    /* An advance paid on a milestone that has no invoice yet must not reduce what is owed on
       another milestone's invoice, and must not make baaki negative. */
    const m = dealMoney({
      projects: [{ id: PID, status: "active", total_amount: 1_000_000 }],
      projectMilestones: [
        { id: "a", project_id: PID, total_amount: 400_000, invoice_id: "INV-A" },
        { id: "b", project_id: PID, total_amount: 600_000, invoice_id: null },
      ],
      projectInvoices: [{ id: "INV-A", amount: 400_000, net_payable: 400_000, paid_amount: 100_000, status: "partial" }],
      projectPayments: [
        { id: "x", project_id: PID, milestone_id: "a", amount: 100_000 },
        { id: "y", project_id: PID, milestone_id: "b", amount: 600_000 },
      ],
    });
    expect(m.invoiced).toBe(400_000);
    expect(m.paid).toBe(700_000);
    expect(m.outstanding).toBe(300_000);
    expect(m.project.notInvoiced).toBe(600_000);
  });

  it("void project invoices and declined projects do not count", () => {
    const m = dealMoney({
      projects: [{ id: PID, status: "cancelled", total_amount: 500_000 }],
      projectMilestones: [{ id: "a", project_id: PID, total_amount: 500_000, invoice_id: null }],
      projectInvoices: [{ id: "INV-V", amount: 500_000, status: "void" }],
      projectPayments: [],
    });
    expect(m.invoiced).toBe(0);
    expect(m.outstanding).toBeNull();
    expect(m.project.value).toBe(0);
    expect(m.project.notInvoiced).toBe(0);
  });
});

describe("dealMoney — both kinds of quote, no double counting", () => {
  const both: DealHistorySources = {
    invoices: [
      { id: "INV-Q", amount: 59_000, status: "pending", quote_id: "Q-1" },
      // Reached through a quote AND a project milestone — must count once, as a project invoice.
      { id: "INV-P", amount: 590_000, status: "partial", quote_id: "Q-1", created_at: "2026-09-20T05:00:00Z" },
    ],
    payments: [{ id: "p1", amount: 20_000, status: "received", quote_id: "Q-1" }],
    projects: [{ id: PID, status: "active", total_amount: 590_000 }],
    projectMilestones: [{ id: "m1", project_id: PID, total_amount: 590_000, invoice_id: "INV-P" }],
    projectInvoices: [
      { id: "INV-P", amount: 590_000, net_payable: 590_000, paid_amount: 300_000, status: "partial", invoice_date: "2026-09-20", created_at: "2026-09-20T05:00:00Z" },
      { id: "INV-P", amount: 590_000, net_payable: 590_000, paid_amount: 300_000, status: "partial", invoice_date: "2026-09-20", created_at: "2026-09-20T05:00:00Z" },
    ],
    projectPayments: [
      { id: "pp1", project_id: PID, milestone_id: "m1", amount: 300_000 },
      { id: "pp1", project_id: PID, milestone_id: "m1", amount: 300_000 },
    ],
  };

  it("adds the two sides and counts a shared invoice / repeated row once", () => {
    const m = dealMoney(both);
    expect(m.invoiced).toBe(59_000 + 590_000);
    expect(m.paid).toBe(20_000 + 300_000);
    // quote side 59,000 − 20,000 = 39,000; project invoice's own balance 2,90,000.
    expect(m.outstanding).toBe(39_000 + 290_000);
    expect(m.invoiceCount).toBe(2);
    expect(m.paymentCount).toBe(2);
  });

  it("a subscription-only deal is unchanged (project side all zero)", () => {
    const m = dealMoney({ invoices: [{ id: "I", amount: 59_000, status: "pending" }], payments: [{ id: "p", amount: 59_000 }] });
    expect(m).toMatchObject({ invoiced: 59_000, paid: 59_000, outstanding: 0 });
    expect(m.project).toEqual({ invoiced: 0, paid: 0, tds: 0, value: 0, notInvoiced: 0 });
  });

  it("the timeline shows the shared invoice once", () => {
    const h = buildDealHistory(both);
    const inv = h.events.filter((e) => e.detail?.includes("INV-P"));
    expect(inv.map((e) => e.id)).toEqual(["project-invoice:INV-P"]);
  });
});

describe("buildDealHistory — project quotation events", () => {
  const h = buildDealHistory(excel);
  const byId = (id: string) => h.events.find((e) => e.id === id)!;

  it("quote created, accepted, invoice issued and each payment, all under Quotes & payments", () => {
    const ids = h.events.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([
      `project:${PID}`, `project-accept:${PID}`, "project-invoice:INV-1", "project-invoice:INV-3",
      "project-payment:pp1", "project-payment:pp2", "project-payment:pp3", "project-payment:pp4",
    ]));
    expect(h.counts.money).toBe(8);
    expect(filterDealHistory(h.events, "money")).toHaveLength(8);
    expect(h.undated).toBe(0);
  });

  it("carries amount and a link to the existing project / invoice page", () => {
    expect(byId(`project:${PID}`)).toMatchObject({ title: "Project quote created", amount: 5_900_000, href: `/projects/${PID}` });
    expect(byId(`project-accept:${PID}`)).toMatchObject({ title: "Project quote accepted", tone: "emerald" });
    expect(byId("project-invoice:INV-1")).toMatchObject({ amount: 590_000, href: "/invoices/INV-1" });
    expect(byId("project-payment:pp2").title).toMatch(/TDS/);
    expect(byId("project-payment:pp1")).toMatchObject({ amount: 540_000, href: `/projects/${PID}` });
  });

  it("dates: the business date wins; the insert's clock time only on the same IST day", () => {
    // INV-1 dated 7 Aug, keyed in 26 Sep → 7 Aug, IST midnight.
    expect(formatIstDateTime(byId("project-invoice:INV-1").at)).toBe("7 Aug 2026, 12:00 am");
    // INV-3 dated 26 Sep, created 26 Sep 06:12 UTC → 11:42 am IST.
    expect(formatIstDateTime(byId("project-invoice:INV-3").at)).toBe("26 Sep 2026, 11:42 am");
    expect(formatIstDateTime(byId(`project-accept:${PID}`).at)).toBe("26 Sep 2026, 10:41 am");
  });

  it("an accepted project with no accepted_at is placed at its last update, and says so", () => {
    const e = buildDealHistory({ projects: [{ id: PID, title: "X", status: "active", created_at: "2026-09-01T05:00:00Z", updated_at: "2026-09-02T05:00:00Z" }] })
      .events.find((x) => x.id === `project-accept:${PID}`)!;
    expect(e.at).toBe("2026-09-02T05:00:00.000Z");
    expect(e.detail).toMatch(/last update/);
  });

  it("a declined project is shown as declined, not accepted", () => {
    const ev = buildDealHistory({ projects: [{ id: PID, status: "cancelled", created_at: "2026-09-01T05:00:00Z", updated_at: "2026-09-03T05:00:00Z" }] }).events;
    expect(ev.map((e) => e.title)).toEqual(["Project quote declined", "Project quote created"]);
  });
});

describe("dealQuoteRows — one list for both kinds", () => {
  it("lists subscription quotes and project quotations newest first, with the right link and label", () => {
    const rows = dealQuoteRows(
      [{ id: "Q-1", status: "sent", amount: 59_000, created_at: "2026-09-20T05:00:00Z", plan: "Workspace" }],
      [{ id: PID, title: "Complete Billing System", status: "active", total_amount: 5_900_000, created_at: "2026-09-26T05:11:45+00:00", accepted_at: "2026-09-26T05:11:46Z" }],
    );
    expect(rows.map((r) => [r.kind, r.ref, r.statusLabel, r.badge, r.amount, r.href])).toEqual([
      ["project", "Complete Billing System", "Accepted", "success", 5_900_000, `/projects/${PID}`],
      ["subscription", "Q-1", "sent", "warning", 59_000, "/quotes/Q-1"],
    ]);
  });

  it("a quoted (not yet accepted) project reads as a pending quotation", () => {
    const [r] = dealQuoteRows([], [{ id: PID, status: "quoted", total_amount: 1 }]);
    expect(r).toMatchObject({ statusLabel: "Quotation", badge: "warning", ref: "Project quotation" });
  });
});
