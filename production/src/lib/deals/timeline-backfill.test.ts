/**
 * 1 Oct 2026 — Demo Co: project ran 20 Apr → Aug, keyed into the app on 26 Sep.
 * Pardeep: "ye history logical thik ho sakti hai". The feed must read in the order things
 * HAPPENED, mark backfilled rows, and not claim the quotation was made after the deal was won.
 */
import { describe, it, expect } from "vitest";
import { buildDealHistory, formatIstDate, type DealHistorySources } from "./timeline";

const P = "proj-1";
const src: DealHistorySources = {
  lead: {
    id: "L-1", company: "Demo Co", stage: "won", source: "meta-ads",
    created_at: "2026-09-26T04:04:55Z", created_by: null, stage_changed_at: "2026-09-26T04:20:07Z",
    lost_at: null, lost_reason: null, lost_note: null, trial_started_at: null, trial_converted_at: null, trial_expired_at: null,
  } as DealHistorySources["lead"],
  projects: [{
    id: P, title: "Complete Billing System", status: "active", total_amount: 5_900_000,
    created_at: "2026-09-26T05:11:45.574Z", accepted_at: "2026-09-26T05:11:45.607Z", updated_at: "2026-09-26T05:18:11Z",
    start_date: "2026-04-20",
  }],
  projectMilestones: [{ id: "m1", project_id: P, label: "Pehli kist (advance)", total_amount: 590_000, invoice_id: "INV-1" }],
  projectInvoices: [{ id: "INV-1", amount: 590_000, status: "paid", invoice_date: "2026-08-07", created_at: "2026-09-26T05:11:45Z" }],
  projectPayments: [{ id: "pp1", project_id: P, milestone_id: "m1", amount: 540_000, method: "bank_transfer", received_at: "2026-08-07", created_at: "2026-09-26T05:11:45Z" }],
  auditLog: [],
  activities: [],
};

describe("deal history — backfilled deal", () => {
  const h = buildDealHistory(src);
  const titles = [...h.events].reverse().map((e) => e.title); // oldest first

  it("reads in the order things happened: quote accepted (project start) → invoice/payment → lead added", () => {
    const iQuote = titles.indexOf("Project quote accepted");
    const iPay = titles.indexOf("Project payment received");
    const iLead = titles.findIndex((t) => /lead/i.test(t));
    expect(iQuote).toBeGreaterThanOrEqual(0);
    expect(iQuote).toBeLessThan(iPay);
    expect(iPay).toBeLessThan(iLead);
  });

  it("does not show a separate 'quote banaya' on the keying-in day", () => {
    expect(titles).not.toContain("Project quote created");
  });

  it("date-only business dates and 'added to app' marks", () => {
    const pay = h.events.find((e) => e.id === "project-payment:pp1")!;
    expect(pay.dateOnly).toBe(true);
    expect(formatIstDate(pay.addedOn!)).toBe("26 Sep 2026");
    expect(formatIstDate(pay.at)).toBe("7 Aug 2026");
    const q = h.events.find((e) => e.id === `project-accept:${P}`)!;
    expect(formatIstDate(q.at)).toBe("20 Apr 2026");
  });

  it("flags the deal as added to the app later", () => {
    expect(h.addedToAppOn && formatIstDate(h.addedToAppOn)).toBe("26 Sep 2026");
  });

  it("a normal same-day project quotation is unchanged", () => {
    const live = buildDealHistory({
      ...src,
      projects: [{ ...src.projects![0], created_at: "2026-09-26T05:00:00Z", accepted_at: "2026-09-28T06:00:00Z", start_date: "2026-10-01" }],
      projectInvoices: [], projectPayments: [],
    });
    expect(live.events.map((e) => e.title)).toContain("Project quote created");
    expect(live.addedToAppOn).toBeNull();
  });
});
