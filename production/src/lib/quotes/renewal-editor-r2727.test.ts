/** R-2727 — the renewal quote editor: the line's Starts date, and the footer's approval step. */
import { describe, it, expect } from "vitest";
import { renewalLineStart, startsOnCard, customerHasLiveSubscription, renewalSendStep, viewerMayApproveInEditor, RENEWAL_OPEN_APPROVAL_LABEL } from "./renewal-editor";
import { requiredApproval, type ApprovalRecord } from "./approval";
import { quoteLinePeriodContext, lineServicePeriod, linePeriodText } from "./service-period";

const renewalCtx = { isRenewal: true, extensionMonths: 12, renewalTermDate: "2027-09-04" };
const domainLine = { name: "Domain rajpharma.in", commitment: "annual_yearly", qty: 1, rate: 999, cost: 0 };

describe("renewalLineStart (item 1)", () => {
  it("a renewal line with no start_date shows the renewal period's start (the preview / PDF date), read-only", () => {
    expect(renewalLineStart(domainLine, renewalCtx)).toEqual({ kind: "fixed", date: "2027-09-05" });
  });
  it("a 3-year renewal starts on the same day", () => {
    expect(renewalLineStart(domainLine, { ...renewalCtx, extensionMonths: 36 })).toEqual({ kind: "fixed", date: "2027-09-05" });
  });
  it("an old renewal quote with no renewal_term_date → no date ('—'), never a guessed one", () => {
    expect(renewalLineStart(domainLine, { ...renewalCtx, renewalTermDate: null })).toEqual({ kind: "fixed", date: null });
  });
  it("a line added to the renewal quote (start_date = today, which nothing reads) shows the renewal start too, read-only", () => {
    expect(renewalLineStart({ ...domainLine, start_date: "2026-11-13" }, renewalCtx)).toEqual({ kind: "fixed", date: "2027-09-05" });
  });
  it("a one-time line on a renewal quote → no date ('—')", () => {
    expect(renewalLineStart({ name: "Migration", one_time: true }, renewalCtx)).toEqual({ kind: "fixed", date: null });
  });
  /* R-2727 review (MED): billing's rule (followingTermStart), from the renewed subscription's start + term. */
  it("APP-made subscription (renewal_date = start + whole terms, e.g. a domain bought 4 Sep 2026) → Starts ON the renewal date, 4 Sep 2027", () => {
    const ctx = quoteLinePeriodContext({ is_renewal: true, extension_months: 12, renewal_term_date: "2027-09-04" },
      { domain: "rajpharma.in", start_date: "2026-09-04", term_months: 12 });
    expect(renewalLineStart(domainLine, ctx)).toEqual({ kind: "fixed", date: "2027-09-04" });
    expect(lineServicePeriod({ ...domainLine }, ctx)).toEqual({ from: "2027-09-04", to: "2028-09-03", months: 12 });
    expect(linePeriodText(domainLine, ctx)).toBe("Subscription period: 1 Year (04/09/2027 – 03/09/2028)");
  });
  it("ZOHO-import row (renewal_date = the term's LAST day) → Starts the day after, 5 Sep 2027 (unchanged)", () => {
    const ctx = quoteLinePeriodContext({ is_renewal: true, extension_months: 12, renewal_term_date: "2027-09-04" },
      { domain: null, start_date: "2026-09-05", term_months: 12 });
    expect(renewalLineStart(domainLine, ctx)).toEqual({ kind: "fixed", date: "2027-09-05" });
    expect(lineServicePeriod(domainLine, ctx)).toEqual({ from: "2027-09-05", to: "2028-09-04", months: 12 });
  });
  it("app-made, 3-year renewal → 4 Sep 2027 – 3 Sep 2030 (record_payment rolls renewal_date +36 months)", () => {
    const ctx = quoteLinePeriodContext({ is_renewal: true, extension_months: 36, renewal_term_date: "2027-09-04" },
      { start_date: "2026-09-04", term_months: 12 });
    expect(lineServicePeriod(domainLine, ctx)).toEqual({ from: "2027-09-04", to: "2030-09-03", months: 36 });
  });
  it("subscription not read (string domain only / null) → the old day-after rule", () => {
    const ctx = quoteLinePeriodContext({ is_renewal: true, extension_months: 12, renewal_term_date: "2027-09-04" }, "x.in");
    expect(ctx.domain).toBe("x.in");
    expect(renewalLineStart(domainLine, ctx)).toEqual({ kind: "fixed", date: "2027-09-05" });
  });
  it("a new sale (not a renewal) keeps the editable box", () => {
    expect(renewalLineStart(domainLine, { startFallback: "2026-11-13" })).toEqual({ kind: "editable" });
    expect(renewalLineStart(domainLine, null)).toEqual({ kind: "editable" });
  });
});

describe("startsOnCard (R-2713 part 1 — the phone card shows Starts without 'More')", () => {
  it("renewal line → on the card", () => {
    expect(startsOnCard(domainLine, renewalCtx, false)).toBe(true);
  });
  it("multi-year line → on the card", () => {
    expect(startsOnCard({ ...domainLine, years: 3 }, null, false)).toBe(true);
  });
  it("customer already has a live subscription → on the card", () => {
    expect(startsOnCard(domainLine, null, true)).toBe(true);
  });
  it("a plain 1-year line for a new customer stays inside 'More'", () => {
    expect(startsOnCard(domainLine, null, false)).toBe(false);
  });
  it("customerHasLiveSubscription: active / paused count, cancelled and other customers do not", () => {
    const subs = [{ customer_id: "c1", status: "cancelled" }, { customer_id: "c2", status: "active" }];
    expect(customerHasLiveSubscription("c1", subs)).toBe(false);
    expect(customerHasLiveSubscription("c2", subs)).toBe(true);
    expect(customerHasLiveSubscription("c1", [...subs, { customer_id: "c1", status: "paused" }])).toBe(true);
    expect(customerHasLiveSubscription(null, subs)).toBe(false);
  });
});

const notRequired: ApprovalRecord = {
  status: "not_required", tier: null, requestedBy: null, approvedBy: null,
  approvedDiscountBps: null, approvedMarginBps: null, rejectionReason: null,
};
/* The Raj Pharma shape: a domain renewal line at ₹999 with cost 0 (createDomainRenewalQuote) →
   cost unknown → the OWNER must clear it (R-388). */
const ownerNeed = requiredApproval({ subtotal: 999, listTotal: 999, totalCost: 0, costUnknown: true });

describe("viewerMayApproveInEditor + renewalSendStep (item 2)", () => {
  const owner = { id: "u-owner", role: "owner" };
  it("needs the owner because the domain line's cost is unknown", () => {
    expect(ownerNeed.tier).toBe("owner");
  });
  it("the company's ONLY owner, who made the quote → may approve (with a reason) → 'Save & open approval'", () => {
    const may = viewerMayApproveInEditor({ viewer: owner, record: notRequired, need: ownerNeed, team: [owner], makers: ["u-owner"] });
    expect(may).toBe(true);
    expect(renewalSendStep("needs-approval", may)).toBe("open-approval");
    expect(RENEWAL_OPEN_APPROVAL_LABEL).toBe("Save & open approval");
  });
  it("an owner who did NOT make it (a cron-made quote) → may approve", () => {
    const team = [owner, { id: "u-owner2", role: "owner" }];
    expect(viewerMayApproveInEditor({ viewer: owner, record: notRequired, need: ownerNeed, team, makers: [] })).toBe(true);
  });
  it("an owner who made it while another owner exists → asks (the other owner clears it)", () => {
    const team = [owner, { id: "u-owner2", role: "owner" }];
    const may = viewerMayApproveInEditor({ viewer: owner, record: notRequired, need: ownerNeed, team, makers: ["u-owner"] });
    expect(may).toBe(false);
    expect(renewalSendStep("needs-approval", may)).toBe("ask-approval");
  });
  it("a manager on an owner-tier quote → asks", () => {
    const mgr = { id: "u-mgr", role: "manager" };
    expect(viewerMayApproveInEditor({ viewer: mgr, record: notRequired, need: ownerNeed, team: [owner, mgr], makers: [] })).toBe(false);
  });
  it("team or makers not loaded yet → never offers approve early", () => {
    expect(viewerMayApproveInEditor({ viewer: owner, record: notRequired, need: ownerNeed, team: undefined, makers: [] })).toBe(false);
    expect(viewerMayApproveInEditor({ viewer: owner, record: notRequired, need: ownerNeed, team: [owner], makers: undefined })).toBe(false);
    expect(viewerMayApproveInEditor({ viewer: null, record: notRequired, need: ownerNeed, team: [owner], makers: [] })).toBe(false);
  });
  it("nothing to approve (cost typed in) → the R-2710 send as before", () => {
    expect(renewalSendStep("email", true)).toBe("email");
    expect(renewalSendStep("mark-sent", false)).toBe("mark-sent");
  });
});
