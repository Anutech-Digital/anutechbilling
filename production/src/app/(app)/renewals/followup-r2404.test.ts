/**
 * R-2404 — owner, next follow-up, decision status and promise-to-pay per renewal, on Payment
 * Follow-up's own model (payment_followups rows with subscription_id) — no second copy.
 * Owner's path (card howToCheck): set Owner = me + Next follow-up = today → "Mine" and
 * "Follow-up due" show it; a past promise → "Promise broken"; after Send renewal quote the
 * decision reads "Quote sent" by itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  renewalFollowup, followupsOfRenewal, renewalDecision, showDecision, filterByFollowup, NO_FOLLOWUP_FILTERS,
  bulkAssignRequests, bulkAssignReport, DECISION_LABEL, type RenewalFollowupRow,
} from "./followup";
import { isPaidRenewalQuote } from "./queue";
import {
  followupRequestSchema, followupFormSchema, buildFollowupInsert, toFollowupRequest, linkOptions,
  RENEWAL_CONFIRMED, CONFIRMED_NEEDS_RENEWAL,
} from "@/lib/collections/followup-rules";

const TODAY = "2026-11-03";
const SUB = "11111111-1111-4111-8111-111111111111";
const OTHER_SUB = "22222222-2222-4222-8222-222222222222";
const CUST = "33333333-3333-4333-8333-333333333333";
const ME = "44444444-4444-4444-8444-444444444444";
const RAVI = "55555555-5555-4555-8555-555555555555";
const AM = "66666666-6666-4666-8666-666666666666";

let n = 0;
const fu = (over: Partial<RenewalFollowupRow>): RenewalFollowupRow => ({
  id: `f${++n}`, customer_id: CUST, subscription_id: SUB, kind: "call", note: null, outcome: null,
  promised_amount: null, promised_on: null, next_follow_up_on: null, assigned_to: null,
  created_at: "2026-11-01T05:00:00Z", ...over,
});

describe("R-2404 owner + next follow-up: the renewal's own follow-ups, newest first", () => {
  it("owner = newest follow-up's assigned_to on THIS renewal; another renewal's rows never count", () => {
    const rows = [
      fu({ assigned_to: RAVI, created_at: "2026-11-01T05:00:00Z", next_follow_up_on: "2026-11-06" }),
      fu({ assigned_to: ME, created_at: "2026-11-02T05:00:00Z", next_follow_up_on: TODAY }),
      fu({ subscription_id: OTHER_SUB, assigned_to: RAVI, created_at: "2026-11-03T05:00:00Z", next_follow_up_on: "2026-11-20" }),
    ];
    expect(followupsOfRenewal(SUB, rows).map((r) => r.assigned_to)).toEqual([ME, RAVI]);
    const s = renewalFollowup(SUB, rows, { customerOwnerId: AM, today: TODAY, paid: false });
    expect(s.ownerId).toBe(ME);
    expect(s.nextFollowUpOn).toBe(TODAY);
    expect(s.followUpDue).toBe(true);
    expect(s.count).toBe(2);
    expect(s.lastContactAt).toBe("2026-11-02T05:00:00Z");
  });
  it("no follow-up yet → the customer's owner (account manager); none → nobody", () => {
    expect(renewalFollowup(SUB, [], { customerOwnerId: AM, today: TODAY, paid: false }).ownerId).toBe(AM);
    const none = renewalFollowup(SUB, [], { customerOwnerId: null, today: TODAY, paid: false });
    expect(none.ownerId).toBeNull();
    expect(none.followUpDue).toBe(false);
    expect(none.promiseBroken).toBe(false);
  });
  it("follow-up due = next date today or earlier; tomorrow is not due", () => {
    const past = renewalFollowup(SUB, [fu({ next_follow_up_on: "2026-11-01" })], { customerOwnerId: null, today: TODAY, paid: false });
    const later = renewalFollowup(SUB, [fu({ next_follow_up_on: "2026-11-04" })], { customerOwnerId: null, today: TODAY, paid: false });
    expect(past.followUpDue).toBe(true);
    expect(later.followUpDue).toBe(false);
  });
});

describe("R-2404 promise to pay — promiseStatus, the one rule (R-1540)", () => {
  const promise = (on: string) => fu({ kind: "promise", promised_on: on, promised_amount: 92_040, created_at: "2026-10-28T05:00:00Z", next_follow_up_on: on });
  it("a promised date in the past, renewal not paid → Promise broken", () => {
    const s = renewalFollowup(SUB, [promise("2026-11-01")], { customerOwnerId: null, today: TODAY, paid: false });
    expect(s.promiseStatus).toBe("broken");
    expect(s.promiseBroken).toBe(true);
    expect(s.promisedOn).toBe("2026-11-01");
    expect(s.promisedAmount).toBe(92_040);
  });
  it("paid renewal → kept, never broken; today → due; ahead → open", () => {
    expect(renewalFollowup(SUB, [promise("2026-11-01")], { customerOwnerId: null, today: TODAY, paid: true }).promiseStatus).toBe("kept");
    expect(renewalFollowup(SUB, [promise(TODAY)], { customerOwnerId: null, today: TODAY, paid: false }).promiseStatus).toBe("due");
    expect(renewalFollowup(SUB, [promise("2026-11-09")], { customerOwnerId: null, today: TODAY, paid: false }).promiseStatus).toBe("open");
  });
  it("the NEWEST promise counts — a new date replaces a broken one", () => {
    const s = renewalFollowup(SUB, [promise("2026-11-01"), fu({ kind: "promise", promised_on: "2026-11-10", created_at: "2026-11-02T05:00:00Z" })], { customerOwnerId: null, today: TODAY, paid: false });
    expect(s.promisedOn).toBe("2026-11-10");
    expect(s.promiseBroken).toBe(false);
  });
});

describe("R-2404 decision status: Not contacted → Contacted → Quote sent → Confirmed → Invoiced → Paid / Won't renew", () => {
  const none = { confirmed: false, count: 0 };
  const sub = (over: { auto_renew?: boolean | null; renewal_quote_id?: string | null } = {}) => ({ auto_renew: true, renewal_quote_id: null, ...over });
  const q = (status: string, payment_status = "none") => ({ id: "Q-1", status, payment_status });
  it("nothing yet → Not contacted; a logged call → Contacted", () => {
    expect(renewalDecision(sub(), { statusKey: "due", quote: null, followup: none })).toBe("not-contacted");
    expect(renewalDecision(sub(), { statusKey: "due", quote: null, followup: { confirmed: false, count: 1 } })).toBe("contacted");
  });
  it("after Send renewal quote the status moves to Quote sent by itself; a draft quote is not sent", () => {
    expect(renewalDecision(sub({ renewal_quote_id: "Q-1" }), { statusKey: "due", quote: q("sent"), followup: none })).toBe("quote-sent");
    expect(renewalDecision(sub({ renewal_quote_id: "Q-1" }), { statusKey: "due", quote: q("viewed"), followup: none })).toBe("quote-sent");
    expect(renewalDecision(sub({ renewal_quote_id: "Q-1" }), { statusKey: "due", quote: q("draft"), followup: none })).toBe("not-contacted");
    /* quote status not loaded yet → treated as sent, like renewalRowAction (R-2232) */
    expect(renewalDecision(sub({ renewal_quote_id: "Q-1" }), { statusKey: "due", quote: undefined, followup: none })).toBe("quote-sent");
  });
  it("Confirmed: the quote is accepted, or a person ticked 'Customer confirmed the renewal'", () => {
    expect(renewalDecision(sub({ renewal_quote_id: "Q-1" }), { statusKey: "due", quote: q("accepted"), followup: none })).toBe("confirmed");
    expect(renewalDecision(sub(), { statusKey: "overdue", quote: null, followup: { confirmed: true, count: 1 } })).toBe("confirmed");
  });
  it("Invoiced → Paid (row Renewed) → Won't renew (auto_renew off) win in that order", () => {
    expect(renewalDecision(sub({ renewal_quote_id: "Q-1" }), { statusKey: "overdue", quote: q("accepted", "invoiced"), followup: none })).toBe("invoiced");
    expect(renewalDecision(sub({ renewal_quote_id: "Q-1" }), { statusKey: "renewed", quote: q("accepted", "invoiced"), followup: none })).toBe("paid");
    expect(renewalDecision(sub({ auto_renew: false, renewal_quote_id: "Q-1" }), { statusKey: "non-renewing", quote: q("sent"), followup: { confirmed: true, count: 2 } })).toBe("wont-renew");
  });
  it("Paid / Won't renew are already the row's status chip — not shown twice (one fact, one place)", () => {
    expect(showDecision("paid")).toBe(false);
    expect(showDecision("wont-renew")).toBe(false);
    expect(showDecision("quote-sent")).toBe(true);
    expect(Object.values(DECISION_LABEL)).toEqual(["Not contacted", "Contacted", "Quote sent", "Confirmed", "Invoiced", "Paid", "Won't renew"]);
  });
});

describe("R-2404 paid renewal quote = payment_status 'received' (there is no 'paid')", () => {
  const s = { renewal_quote_id: "Q-1" };
  it("received → paid; invoiced / awaiting / a non-existent 'paid' → not", () => {
    expect(isPaidRenewalQuote(s, { id: "Q-1", amount: 1, status: "accepted", payment_status: "received" })).toBe(true);
    expect(isPaidRenewalQuote(s, { id: "Q-1", amount: 1, status: "accepted", payment_status: "invoiced" })).toBe(false);
    expect(isPaidRenewalQuote(s, { id: "Q-1", amount: 1, status: "sent", payment_status: "awaiting" })).toBe(false);
    expect(isPaidRenewalQuote(s, { id: "Q-2", amount: 1, status: "accepted", payment_status: "received" })).toBe(false);
  });
});

describe("R-2404 filters: Mine · Follow-up due · Promise broken", () => {
  const r = (id: string, ownerId: string | null, followUpDue = false, promiseBroken = false) => ({ id, followup: { ownerId, followUpDue, promiseBroken } });
  const rows = [r("a", ME, true), r("b", RAVI, false, true), r("c", null), r("d", ME, false, true)];
  it("each filter, and together", () => {
    expect(filterByFollowup(rows, NO_FOLLOWUP_FILTERS, ME).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterByFollowup(rows, { ...NO_FOLLOWUP_FILTERS, mine: true }, ME).map((x) => x.id)).toEqual(["a", "d"]);
    expect(filterByFollowup(rows, { ...NO_FOLLOWUP_FILTERS, followUpDue: true }, ME).map((x) => x.id)).toEqual(["a"]);
    expect(filterByFollowup(rows, { ...NO_FOLLOWUP_FILTERS, promiseBroken: true }, ME).map((x) => x.id)).toEqual(["b", "d"]);
    expect(filterByFollowup(rows, { mine: true, followUpDue: false, promiseBroken: true }, ME).map((x) => x.id)).toEqual(["d"]);
  });
  it("Mine with no signed-in user shows nothing (an unowned row is nobody's)", () => {
    expect(filterByFollowup(rows, { ...NO_FOLLOWUP_FILTERS, mine: true }, null)).toEqual([]);
  });
});

describe("R-2404 bulk Assign owner — one follow-up per renewal through the same API", () => {
  const row = (id: string, customer_id: string | null, next: string | null) => ({
    sub: { id, customer_id, customer_name: id.toUpperCase() }, followup: { nextFollowUpOn: next },
  });
  it("keeps a next date that is today or later, else today + 3; skips a row with no customer", () => {
    const { requests, skipped } = bulkAssignRequests(
      [row(SUB, CUST, "2026-11-05"), row(OTHER_SUB, CUST, "2026-10-30"), row("x", null, null)],
      { id: RAVI, name: "Ravi" }, TODAY,
    );
    expect(requests.map((r) => r.body.nextFollowUpOn)).toEqual(["2026-11-05", "2026-11-06"]);
    expect(requests[0].body).toEqual({
      customerId: CUST, kind: "note", note: "Renewal owner: Ravi", nextFollowUpOn: "2026-11-05", assignedTo: RAVI, subscriptionId: SUB,
    });
    expect(skipped.map((s) => s.reason)).toEqual(["no customer on this subscription"]);
    /* every body is one the API accepts */
    for (const r of requests) expect(followupRequestSchema.safeParse(r.body).success).toBe(true);
  });
  it("report names who failed and what to do (§24)", () => {
    expect(bulkAssignReport(3, [], "Ravi")).toEqual({ tone: "success", title: "3 renewals given to Ravi" });
    const w = bulkAssignReport(1, [{ name: "ACME", error: "Only an owner, manager or accountant can give this follow-up to someone else." }], "Ravi");
    expect(w.tone).toBe("warning");
    expect(w.description).toContain("ACME");
    expect(w.description).toContain("Retry failed");
    expect(bulkAssignReport(0, [{ name: "ACME", error: "x" }], "Ravi").tone).toBe("error");
  });
});

describe("R-2404 'Customer confirmed the renewal' — payment_followups.outcome", () => {
  const base = { customerId: CUST, kind: "call", nextFollowUpOn: "2026-11-06" };
  it("the API takes it only with the renewal it is about", () => {
    expect(followupRequestSchema.safeParse({ ...base, subscriptionId: SUB, outcome: RENEWAL_CONFIRMED }).success).toBe(true);
    const bad = followupRequestSchema.safeParse({ ...base, outcome: RENEWAL_CONFIRMED });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toBe(CONFIRMED_NEEDS_RENEWAL);
    expect(followupRequestSchema.safeParse({ ...base, subscriptionId: SUB, outcome: "won_the_lottery" }).success).toBe(false);
  });
  it("the form's tick becomes the outcome only on a renewal link; the row stores it", () => {
    const links = linkOptions([{ kind: "subscription", id: SUB, label: "Workspace", quoteId: "Q-1" }]);
    const form = followupFormSchema.parse({ kind: "call", nextFollowUpOn: "2026-11-06", link: links[0].value, confirmed: true });
    const req = toFollowupRequest(form, { customerId: CUST, links, canReassign: false });
    expect(req.outcome).toBe(RENEWAL_CONFIRMED);
    expect(buildFollowupInsert(followupRequestSchema.parse(req), "t1", null).outcome).toBe(RENEWAL_CONFIRMED);
    const general = toFollowupRequest(followupFormSchema.parse({ kind: "call", nextFollowUpOn: "2026-11-06", link: "", confirmed: true }), { customerId: CUST, links, canReassign: false });
    expect(general.outcome).toBeUndefined();
    expect(buildFollowupInsert(followupRequestSchema.parse({ ...base }), "t1", null).outcome).toBeNull();
  });
});

describe("R-2404 tenant scoping + wiring", () => {
  const data = readFileSync("src/app/(app)/renewals/queue-data.ts", "utf8");
  const route = readFileSync("src/app/api/collections/followups/route.ts", "utf8");
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  it("follow-ups are read on the signed-in session (RLS: same company + a customer you can see), never by a tenant id from the browser", () => {
    expect(data).toMatch(/from\("payment_followups"\)[\s\S]*?\.in\("subscription_id", run\)/);
    expect(data).not.toMatch(/tenant_id/);
    expect(data).not.toMatch(/createAdminClient|service_role/);
  });
  it("writes go through the one follow-up API; Renewals users (incl. support) may use it", () => {
    expect(route).toMatch(/pages: \["\/collections", "\/renewals"\]/);
    expect(page).toContain("postFollowup(");
    expect(page).not.toMatch(/from\("payment_followups"\)\s*\.insert/);
  });
  it("the page uses the shared pieces: filters, bulk assign, the Follow-up dialog", () => {
    expect(page).toContain("filterByFollowup(");
    expect(page).toContain("bulkAssignRequests(");
    expect(page).toContain("<FollowupDialog");
    expect(page).toContain("renewalDecision(");
  });
});
