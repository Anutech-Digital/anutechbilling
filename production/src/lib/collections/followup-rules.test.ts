/**
 * R-1517 — follow-up entry rules: what the form refuses, what the browser sends, who may
 * hand a follow-up to someone else, and the history order / broken-promise flag.
 */
import { describe, it, expect } from "vitest";
import {
  buildFollowupHistory, buildFollowupInsert, defaultAssignee, defaultNextFollowUp,
  followupFormSchema, followupRequestSchema, linkOptions, mayReassignFollowup,
  NEXT_REQUIRED, PROMISE_DATE_REQUIRED, REASSIGN_REFUSED, resolveAssignee, toFollowupRequest,
  type FollowupHistoryRow,
} from "./followup-rules";

const CUST = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const SUB = "66666666-6666-4666-8666-666666666666";

const messages = (r: { success: boolean; error?: { issues: { message: string; path: (string | number)[] }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

describe("form validation", () => {
  it("a promise without a date is refused, on the date field, with the next step", () => {
    const r = followupFormSchema.safeParse({ kind: "promise", promisedAmount: "5000", promisedOn: "", nextFollowUpOn: "2026-10-20" });
    expect(messages(r)).toEqual([`promisedOn: ${PROMISE_DATE_REQUIRED}`]);
  });

  it("a promise with a date (amount optional) passes; the amount becomes whole rupees", () => {
    const r = followupFormSchema.safeParse({ kind: "promise", promisedAmount: "5000", promisedOn: "2026-10-25", nextFollowUpOn: "2026-10-26" });
    expect(r.success && r.data.promisedAmount).toBe(5000);
    expect(followupFormSchema.safeParse({ kind: "promise", promisedAmount: "", promisedOn: "2026-10-25", nextFollowUpOn: "2026-10-26" }).success).toBe(true);
  });

  it("paise and minus amounts are refused", () => {
    for (const amt of ["99.5", "-1"]) {
      const r = followupFormSchema.safeParse({ kind: "promise", promisedAmount: amt, promisedOn: "2026-10-25", nextFollowUpOn: "2026-10-26" });
      expect(r.success).toBe(false);
    }
  });

  it.each(["call", "whatsapp", "email", "meeting", "note", "promise"])("%s without a next follow-up date is refused", (kind) => {
    const r = followupFormSchema.safeParse({ kind, promisedOn: "2026-10-25", nextFollowUpOn: "" });
    expect(messages(r)).toContain(`nextFollowUpOn: ${NEXT_REQUIRED}`);
  });

  it("a call needs no promise date", () => {
    expect(followupFormSchema.safeParse({ kind: "call", note: "Said next week", nextFollowUpOn: "2026-10-20" }).success).toBe(true);
  });

  it("default next follow-up is 3 days after today, across a month end", () => {
    expect(defaultNextFollowUp("2026-10-17")).toBe("2026-10-20");
    expect(defaultNextFollowUp("2026-10-30")).toBe("2026-11-02");
  });
});

describe("what the browser sends, and what is inserted", () => {
  const links = linkOptions([
    { kind: "invoice", id: "INV-A378", label: "INV-A378", quoteId: "Q-12" },
    { kind: "subscription", id: SUB, label: "Workspace · acme.in", quoteId: null },
  ]);

  it("the request has no created_by / tenant_id / id / created_at; promise fields only for a promise", () => {
    const call = followupFormSchema.parse({ kind: "call", note: " rang ", promisedAmount: "100", promisedOn: "2026-10-25", nextFollowUpOn: "2026-10-20", link: "invoice:INV-A378" });
    const body = toFollowupRequest(call, { customerId: CUST, links, canReassign: false });
    expect(body).toEqual({
      customerId: CUST, kind: "call", note: "rang", promisedAmount: undefined, promisedOn: undefined,
      nextFollowUpOn: "2026-10-20", assignedTo: undefined, invoiceId: "INV-A378", quoteId: "Q-12", subscriptionId: undefined,
    });
    for (const k of ["created_by", "createdBy", "tenant_id", "tenantId", "id", "created_at"]) expect(body).not.toHaveProperty(k);
  });

  it("a sales person's form never sends assignedTo even if the value is set", () => {
    const d = followupFormSchema.parse({ kind: "note", nextFollowUpOn: "2026-10-20", assignedTo: OTHER });
    expect(toFollowupRequest(d, { customerId: CUST, links, canReassign: false }).assignedTo).toBeUndefined();
    expect(toFollowupRequest(d, { customerId: CUST, links, canReassign: true }).assignedTo).toBe(OTHER);
  });

  it("the server schema refuses a body that tries to set created_by or tenant_id", () => {
    const base = { customerId: CUST, kind: "call", nextFollowUpOn: "2026-10-20" };
    expect(followupRequestSchema.safeParse(base).success).toBe(true);
    expect(followupRequestSchema.safeParse({ ...base, created_by: OTHER }).success).toBe(false);
    expect(followupRequestSchema.safeParse({ ...base, tenant_id: OTHER }).success).toBe(false);
    expect(followupRequestSchema.safeParse({ ...base, nextFollowUpOn: undefined }).success).toBe(false);
    expect(followupRequestSchema.safeParse({ ...base, kind: "promise" }).success).toBe(false);
  });

  it("insert row: tenant from the server, no created_by (DB default auth.uid()), promise fields dropped for a call", () => {
    const req = followupRequestSchema.parse({
      customerId: CUST, kind: "call", promisedAmount: 500, promisedOn: "2026-10-25", nextFollowUpOn: "2026-10-20", subscriptionId: SUB,
    });
    const row = buildFollowupInsert(req, "T1", OWNER);
    expect(row).toEqual({
      tenant_id: "T1", customer_id: CUST, kind: "call", note: null, promised_amount: null, promised_on: null,
      next_follow_up_on: "2026-10-20", assigned_to: OWNER, invoice_id: null, quote_id: null, subscription_id: SUB,
    });
    expect(row).not.toHaveProperty("created_by");
  });

  it("insert row for a promise keeps amount and date", () => {
    const req = followupRequestSchema.parse({ customerId: CUST, kind: "promise", promisedAmount: 5000, promisedOn: "2026-10-25", nextFollowUpOn: "2026-10-26" });
    expect(buildFollowupInsert(req, "T1", null)).toMatchObject({ promised_amount: 5000, promised_on: "2026-10-25", assigned_to: null });
  });
});

describe("reassign — only owner / manager / accountant", () => {
  it.each(["owner", "manager", "accountant"])("%s may reassign", (role) => {
    expect(mayReassignFollowup(role)).toBe(true);
    expect(resolveAssignee({ role, requested: OTHER, defaultId: OWNER })).toEqual({ ok: true, assignedTo: OTHER });
  });

  it.each(["sales", "sales_senior", "billing", "support", "delivery", null])("%s may not give it to someone else (403 with next step)", (role) => {
    expect(mayReassignFollowup(role)).toBe(false);
    expect(resolveAssignee({ role, requested: OTHER, defaultId: OWNER })).toEqual({ ok: false, status: 403, error: REASSIGN_REFUSED });
  });

  it("sales keeping the default, or asking nothing, is fine", () => {
    expect(resolveAssignee({ role: "sales", requested: OWNER, defaultId: OWNER })).toEqual({ ok: true, assignedTo: OWNER });
    expect(resolveAssignee({ role: "sales", requested: undefined, defaultId: OWNER })).toEqual({ ok: true, assignedTo: OWNER });
  });

  it("default: who has it now, else the customer's owner, else me", () => {
    expect(defaultAssignee({ latestAssignedTo: OTHER, ownerId: OWNER, meId: CUST })).toBe(OTHER);
    expect(defaultAssignee({ latestAssignedTo: null, ownerId: OWNER, meId: CUST })).toBe(OWNER);
    expect(defaultAssignee({ latestAssignedTo: null, ownerId: null, meId: CUST })).toBe(CUST);
  });
});

describe("history", () => {
  const row = (id: string, created_at: string, extra: Partial<FollowupHistoryRow> = {}): FollowupHistoryRow => ({
    id, created_at, kind: "call", note: null, promised_amount: null, promised_on: null, next_follow_up_on: null,
    assigned_to: null, created_by: null, invoice_id: null, quote_id: null, subscription_id: null, ...extra,
  });

  it("newest first, equal times by id — whatever order the rows came in", () => {
    const rows = [row("a", "2026-10-10T10:00:00Z"), row("c", "2026-10-15T09:00:00Z"), row("b", "2026-10-15T09:00:00Z"), row("d", "2026-10-01T00:00:00Z")];
    expect(buildFollowupHistory(rows, "2026-10-17", true).map((r) => r.id)).toEqual(["c", "b", "a", "d"]);
    expect(buildFollowupHistory([...rows].reverse(), "2026-10-17", true).map((r) => r.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("broken = promise date passed and still owed; today, future or paid is not broken", () => {
    const rows = [
      row("past", "2026-10-01T00:00:00Z", { kind: "promise", promised_on: "2026-10-16" }),
      row("today", "2026-10-02T00:00:00Z", { kind: "promise", promised_on: "2026-10-17" }),
      row("ahead", "2026-10-03T00:00:00Z", { kind: "promise", promised_on: "2026-10-30" }),
      row("call", "2026-10-04T00:00:00Z"),
    ];
    const owed = Object.fromEntries(buildFollowupHistory(rows, "2026-10-17", true).map((r) => [r.id, r.broken]));
    expect(owed).toEqual({ past: true, today: false, ahead: false, call: false });
    expect(buildFollowupHistory(rows, "2026-10-17", false).some((r) => r.broken)).toBe(false);
  });
});
