/**
 * R-2738 — ONE stage per Renewals row + ONE primary button (audit 13 Nov §5.1/5.2, P2–P5;
 * ownerRule / ownerRule2 on the card; R-2735 money rule N7: renewed only by payment).
 */
import { describe, it, expect } from "vitest";
import {
  renewalStage, renewalPrimary, bulkSendDecision, notRenewingDialog, dueWords, daysTone,
  type StageSub, type StageInput, type PrimaryContext, type RenewalStage,
  SEND_RENEWAL, BILL_NEXT_PART, CONTINUE, FOLLOW_UP, RECORD_PAYMENT, BULK_LATER_REASON,
} from "./stage";

const TODAY = "2026-11-14";

/** Annual, whole-term (not billed in parts). renewal 2026-11-30 → 16 days out. */
const annual = (over: Partial<StageSub> = {}): StageSub => ({
  status: "active", renewal_state: "upcoming", renewal_date: "2026-11-30", term_months: 12,
  billing_cycle: "yearly", start_date: "2025-11-30", auto_renew: true, grace_until: null, renewal_quote_id: null, ...over,
});
/** Annual commitment billed quarterly (split). */
const quarterly = (over: Partial<StageSub> = {}): StageSub => annual({ billing_cycle: "quarterly", ...over });
/** Monthly flex: 1-month term billed monthly. */
const flex = (over: Partial<StageSub> = {}): StageSub => annual({ term_months: 1, billing_cycle: "monthly", start_date: "2026-01-30", ...over });

const owner: PrimaryContext = { role: "owner", canEndSubscription: true, tenantGraceDays: 3, offers: { followup: true, messaging: true }, vendorHold: "none" };
const billing: PrimaryContext = { ...owner, role: "billing", canEndSubscription: false };
const followupPage: PrimaryContext = { ...owner, offers: { followup: false, messaging: false } };

const stage = (sub: StageSub, rest: Omit<StageInput, "sub" | "todayIst"> = {}, today = TODAY) => renewalStage({ sub, todayIst: today, ...rest });
const act = (s: RenewalStage, sub: StageSub, ctx: PrimaryContext = owner) => renewalPrimary(s, sub, ctx);

describe("R-2738 renewalStage — one chip, first match wins", () => {
  it("due: Due in Nd / Due today / Overdue Nd, tone by days", () => {
    expect(stage(annual())).toMatchObject({ key: "due", label: "Due in 16d", tone: "warning", days: 16 });
    expect(stage(annual({ renewal_date: "2026-11-14" }))).toMatchObject({ label: "Due today", tone: "danger" });
    expect(stage(annual({ renewal_date: "2026-11-11" }))).toMatchObject({ key: "due", label: "Overdue 3d", tone: "danger", days: -3 });
    expect(stage(annual({ renewal_date: "2027-03-01" })).tone).toBe("muted");
    expect(dueWords(-1)).toBe("Overdue 1d");
    expect(daysTone(7)).toBe("danger");
    expect(daysTone(8)).toBe("warning");
    expect(daysTone(31)).toBe("muted");
  });

  it("stopped / cancelled and ending win over everything; flags stay (money owed stays visible)", () => {
    const s = stage(annual({ status: "suspended" }), { renewalPaid: true, flags: { atRisk: { reasons: ["x"] } } });
    expect(s).toMatchObject({ key: "stopped", label: "Service stopped" });
    expect(s.flags.map((f) => f.key)).toEqual(["atRisk"]);
    expect(stage(annual({ status: "cancelled", renewal_date: "2026-11-01" })).label).toBe("Cancelled");
    const e = stage(annual({ auto_renew: false }), { doc: { kind: "renewal", quoteId: "Q-1", status: "sent" } });
    expect(e.key).toBe("ending");
    expect(e.label).toMatch(/^Won't renew · ends /);
  });

  it("renewal paid → Renewed even before renewal_date moved", () => {
    expect(stage(annual({ renewal_date: "2026-11-10" }), { renewalPaid: true })).toMatchObject({ key: "renewed", label: "Renewed", tone: "success" });
    const viaQuote = stage(annual({ renewal_quote_id: "Q-1" }), { doc: { kind: "renewal", quoteId: "Q-1", status: "accepted", paymentStatus: "received" } });
    expect(viaQuote.key).toBe("renewed");
  });

  it("R-2735: part sent unpaid → 'Renewal quote sent · <period>', never Renewed, never part-due", () => {
    /* Bill next part no longer moves renewal_date: the date passed, partsDue still counts the part by date. */
    const sub = flex({ renewal_date: "2026-11-10" });
    const s = stage(sub, { doc: { kind: "part", quoteId: "Q-P1", status: "sent", dueDate: "2026-11-11", period: "Nov 2026" } });
    expect(s).toMatchObject({ key: "sent", label: "Renewal quote sent · Nov 2026", note: "Overdue 3d", days: -3, quoteId: "Q-P1" });
  });

  it("stale 'renewed' state (rolled on raise before R-2735) + unpaid part → sent, not Renewed", () => {
    const sub = quarterly({ renewal_state: "renewed", renewal_date: "2027-11-30" });
    expect(stage(sub).key).toBe("renewed");   // nothing unpaid → settled renewed
    const s = stage(sub, { doc: { kind: "part", quoteId: "Q-P", status: "viewed", dueDate: "2026-12-01", period: "Dec 2026 – Feb 2027" } });
    expect(s.key).toBe("sent");
    expect(s.label).toBe("Renewal quote sent · Dec 2026 – Feb 2027");
  });

  it("invoiced: amount still due, due vs overdue by the part's / renewal date; zero due is ignored", () => {
    const s = stage(annual({ renewal_quote_id: "Q-1" }), { invoice: { id: "INV-9", kind: "renewal", amountDue: 92040 } });
    expect(s).toMatchObject({ key: "invoiced", invoiceId: "INV-9" });
    expect(s.label).toMatch(/^Invoiced · ₹92,040 due$/);
    const o = stage(annual({ renewal_date: "2026-11-02" }), { invoice: { id: "INV-9", kind: "renewal", amountDue: 1000 } });
    expect(o.label).toMatch(/^Invoiced · ₹1,000 overdue 12d$/);
    const usd = stage(annual(), { invoice: { id: "INV-U", kind: "renewal", amountDue: 1200, currency: "USD" } });
    expect(usd.label).toBe("Invoiced · $1,200 due");
    expect(stage(annual(), { invoice: { id: "INV-0", kind: "renewal", amountDue: 0 } }).key).toBe("due");
  });

  it("invoiced beats a sent doc (the bill is the newer step)", () => {
    const s = stage(annual({ renewal_quote_id: "Q-1" }), {
      doc: { kind: "renewal", quoteId: "Q-1", status: "accepted" },
      invoice: { id: "INV-1", kind: "renewal", amountDue: 500 },
    });
    expect(s.key).toBe("invoiced");
  });

  it("whole-term renewal quote sent past date → sent with the overdue note", () => {
    const s = stage(annual({ renewal_date: "2026-11-11", renewal_quote_id: "Q-1" }), { doc: { kind: "renewal", quoteId: "Q-1", status: "sent" } });
    expect(s).toMatchObject({ key: "sent", label: "Renewal quote sent", note: "Overdue 3d" });
  });

  it("ownerRule2: draft part quote → 'Draft part quote · <period>'; closed docs are ignored", () => {
    const s = stage(flex(), { doc: { kind: "part", quoteId: "Q-D", status: "draft", dueDate: "2026-11-30", period: "1–31 Dec 2026" } });
    expect(s).toMatchObject({ key: "draft", label: "Draft part quote · 1–31 Dec 2026", quoteId: "Q-D" });
    expect(stage(annual(), { doc: { kind: "renewal", quoteId: "Q-X", status: "rejected" } }).key).toBe("due");
  });

  it("part-due: split, the next term's part started and nothing raised", () => {
    const one = stage(quarterly({ renewal_date: "2026-11-10" }));
    expect(one).toMatchObject({ key: "part-due", label: "Part not billed (Nov)", tone: "danger", partsBehind: 1 });
    const many = stage(flex({ renewal_date: "2026-09-10" }));
    expect(many.key).toBe("part-due");
    expect(many.label).toBe("3 parts not billed");
  });

  it("flags are icons with a reason, only on live stages", () => {
    const s = stage(annual(), { flags: {
      atRisk: { reasons: ["Low seat usage (40%)"] }, vendorHold: "hold", priorTermUnpaid: "Previous term ₹5,000 still unpaid",
      promiseBroken: { promisedOn: "2026-11-10" }, followUpDue: { nextFollowUpOn: null },
    } });
    expect(s.flags.map((f) => f.key)).toEqual(["atRisk", "vendorHold", "priorTermUnpaid", "promiseBroken", "followUpDue"]);
    expect(s.flags[0].reason).toBe("At risk: Low seat usage (40%)");
    expect(stage(annual(), { renewalPaid: true, flags: { vendorHold: "hold" } }).flags).toEqual([]);
    expect(stage(annual(), { flags: { vendorHold: "overridden" } }).flags).toEqual([]);
  });
});

describe("R-2738 renewalPrimary — ONE button + ⋯", () => {
  it("due whole-term → Send renewal (editor for quote roles, confirm for billing)", () => {
    const sub = annual();
    const a = act(stage(sub), sub);
    expect(a.primary).toMatchObject({ kind: "send-renewal", label: SEND_RENEWAL, opensEditor: true });
    expect(a.menu).toEqual(["send-as-is", "follow-up", "nudge", "voice", "not-renewing"]);
    const b = act(stage(sub), sub, billing);
    expect(b.primary).toMatchObject({ label: SEND_RENEWAL, opensEditor: false });
    expect(b.menu).not.toContain("send-as-is");
    expect(b.menu).not.toContain("not-renewing");
  });

  it("ownerRule: split due → Bill next part only within 7 days; earlier Follow up + Bill next part in ⋯", () => {
    const far = quarterly();                                   // 16 days
    const a = act(stage(far), far);
    expect(a.primary).toMatchObject({ kind: "follow-up", label: FOLLOW_UP });
    expect(a.menu[0]).toBe("bill-part");
    const near = quarterly({ renewal_date: "2026-11-20" });    // the part starts 21 Nov: 7 days
    const b = act(stage(near), near);
    expect(b.primary).toMatchObject({ kind: "bill-part", label: BILL_NEXT_PART, opensEditor: true });
    expect(b.menu).not.toContain("bill-part");
    const flexNear = flex({ renewal_date: "2026-11-20" });
    expect(act(stage(flexNear), flexNear).primary?.label).toBe(BILL_NEXT_PART);
    /* R-808: never a whole-term Send renewal on a split row */
    expect(act(stage(far), far).menu).not.toContain("send-as-is");
  });

  it("part-due → Bill next part", () => {
    const sub = quarterly({ renewal_date: "2026-11-12" });
    expect(act(stage(sub), sub).primary).toMatchObject({ kind: "bill-part", label: BILL_NEXT_PART });
  });

  it("draft → Continue on the SAME quote (R-2232); billing role sends the whole-term draft, a part draft gets no Continue", () => {
    const sub = flex();
    const s = stage(sub, { doc: { kind: "part", quoteId: "Q-D", status: "draft", dueDate: "2026-11-30" } });
    expect(act(s, sub).primary).toMatchObject({ kind: "continue", label: CONTINUE, quoteId: "Q-D", opensEditor: true });
    expect(act(s, sub, billing).primary?.kind).toBe("follow-up");
    const w = annual({ renewal_quote_id: "Q-W" });
    const ws = stage(w, { doc: { kind: "renewal", quoteId: "Q-W", status: "draft" } });
    expect(act(ws, w, billing).primary).toMatchObject({ kind: "send-renewal", quoteId: "Q-W", opensEditor: false });
  });

  it("sent → Follow up; Record payment, Change renewal, Resend in ⋯; on Payment Follow-up Record payment is the button", () => {
    const sub = annual({ renewal_quote_id: "Q-1" });
    const s = stage(sub, { doc: { kind: "renewal", quoteId: "Q-1", status: "sent" } });
    const a = act(s, sub);
    expect(a.primary).toMatchObject({ kind: "follow-up", label: FOLLOW_UP });
    expect(a.menu.slice(0, 3)).toEqual(["record-payment", "change-renewal", "resend"]);
    const p = act(s, sub, followupPage);
    expect(p.primary).toMatchObject({ kind: "record-payment", label: RECORD_PAYMENT, quoteId: "Q-1" });
    expect(p.menu).not.toContain("follow-up");
    expect(p.menu).not.toContain("record-payment");
  });

  it("split sent part → Follow up, Bill next part stays in ⋯ (ownerRule 3), no Change renewal", () => {
    const sub = flex({ renewal_date: "2026-11-10" });
    const s = stage(sub, { doc: { kind: "part", quoteId: "Q-P", status: "sent", dueDate: "2026-11-10" } });
    const a = act(s, sub, { ...owner, tenantGraceDays: 30 });
    expect(a.primary?.kind).toBe("follow-up");
    expect(a.menu).toContain("bill-part");
    expect(a.menu).not.toContain("change-renewal");
  });

  it("invoiced → Record payment", () => {
    const sub = annual();
    const a = act(stage(sub, { invoice: { id: "INV-1", kind: "renewal", amountDue: 10 } }), sub);
    expect(a.primary).toMatchObject({ kind: "record-payment", invoiceId: "INV-1" });
    expect(a.menu).toContain("resend-invoice");
  });

  it("grace over → Renew anyway (owner/manager, on hold) + Cancel INSIDE ⋯; never a second button", () => {
    const sub = annual({ renewal_date: "2026-11-01", renewal_quote_id: "Q-1" });   // 13 days past, grace 3
    const s = stage(sub, { doc: { kind: "renewal", quoteId: "Q-1", status: "sent" } });
    const a = act(s, sub, { ...owner, vendorHold: "hold" });
    expect(a.graceOver).toBe(true);
    expect(a.primary?.kind).toBe("follow-up");
    expect(a.menu.slice(-2)).toEqual(["renew-anyway", "cancel"]);
    expect(a.menu).not.toContain("not-renewing");
    expect(act(s, sub, { ...owner, role: "sales", vendorHold: "hold" }).menu).not.toContain("renew-anyway");
    expect(act(s, sub, { ...owner, vendorHold: "overridden" }).menu).not.toContain("renew-anyway");
    /* inside the grace: not over, Customer not renewing (→ Cancel dialog after the date) */
    const inGrace = annual({ renewal_date: "2026-11-12" });
    const g = act(stage(inGrace), inGrace);
    expect(g.graceOver).toBe(false);
    expect(g.menu).toContain("not-renewing");
    expect(notRenewingDialog(stage(inGrace))).toBe("cancel");
    expect(notRenewingDialog(stage(annual()))).toBe("non-renewing");
  });

  it("ending / renewed / stopped → no button", () => {
    const e = annual({ auto_renew: false });
    expect(act(stage(e), e)).toEqual({ primary: null, menu: ["undo-wont-renew"], graceOver: false });
    expect(act(stage(e), e, billing).menu).toEqual([]);
    const r = annual();
    expect(act(stage(r, { renewalPaid: true }), r).primary).toBeNull();
    const st = annual({ status: "suspended" });
    expect(act(stage(st), st)).toEqual({ primary: null, menu: ["view-subscription"], graceOver: false });
  });

  it("every live stage × split × role gives at most ONE button and no duplicate menu item", () => {
    const subs = [annual(), quarterly(), flex(), annual({ renewal_date: "2026-10-01" }), quarterly({ renewal_date: "2026-10-01" })];
    const inputs: Omit<StageInput, "sub" | "todayIst">[] = [
      {}, { renewalPaid: true },
      { doc: { kind: "renewal", quoteId: "Q", status: "draft" } }, { doc: { kind: "renewal", quoteId: "Q", status: "sent" } },
      { doc: { kind: "part", quoteId: "Q", status: "sent" } }, { invoice: { id: "I", kind: "renewal", amountDue: 1 } },
    ];
    for (const sub of subs) for (const inp of inputs) for (const ctx of [owner, billing, followupPage, { ...owner, role: "manager", vendorHold: "hold" as const }]) {
      const a = act(stage(sub, inp), sub, ctx);
      expect(new Set(a.menu).size).toBe(a.menu.length);
      if (a.primary) {
        expect([SEND_RENEWAL, BILL_NEXT_PART, CONTINUE, FOLLOW_UP, RECORD_PAYMENT]).toContain(a.primary.label);
        if (a.primary.kind === "follow-up") expect(a.menu).not.toContain("follow-up");
        if (a.primary.kind === "bill-part") expect(a.menu).not.toContain("bill-part");
      }
    }
  });
});

describe("R-2738 bulk Send renewal", () => {
  it("takes only Send renewal rows ≤ 90 days; split / sent / renewed rows are named", () => {
    const due = annual();
    expect(bulkSendDecision(stage(due))).toEqual({ send: true });
    const later = annual({ renewal_date: "2027-03-01" });
    expect(bulkSendDecision(stage(later))).toEqual({ send: false, reason: BULK_LATER_REASON });
    const split = quarterly({ renewal_date: "2026-11-20" });
    expect(bulkSendDecision(stage(split))).toEqual({ send: false, reason: `billed in parts — use ${BILL_NEXT_PART}` });
    const sent = annual({ renewal_quote_id: "Q-1" });
    const ss = stage(sent, { doc: { kind: "renewal", quoteId: "Q-1", status: "sent" } });
    expect(bulkSendDecision(ss)).toEqual({ send: false, reason: "Renewal quote sent" });
    const paid = stage(due, { renewalPaid: true });
    expect(bulkSendDecision(paid)).toEqual({ send: false, reason: "Renewed" });
  });
});

describe("R-2738 review fixes", () => {
  it("R-2232: a linked renewal quote not passed as open (not loaded / closed) is 'sent' — never a fresh Send renewal", () => {
    const sub = annual({ renewal_quote_id: "Q-1" });
    const notLoaded = stage(sub);
    expect(notLoaded).toMatchObject({ key: "sent", quoteId: "Q-1", quoteStatus: "unknown" });
    expect(act(notLoaded, sub).primary?.kind).toBe("follow-up");
    expect(act(notLoaded, sub).menu).not.toContain("change-renewal");
    expect(bulkSendDecision(notLoaded).send).toBe(false);
    const closed = stage(sub, { doc: { kind: "renewal", quoteId: "Q-1", status: "expired" } });
    expect(closed).toMatchObject({ key: "sent", quoteStatus: "expired" });
  });

  it("R-2710: Change renewal only on sent / viewed, not on accepted", () => {
    const sub = annual({ renewal_quote_id: "Q-1" });
    const acc = stage(sub, { doc: { kind: "renewal", quoteId: "Q-1", status: "accepted" } });
    expect(act(acc, sub).menu).not.toContain("change-renewal");
    const viewed = stage(sub, { doc: { kind: "renewal", quoteId: "Q-1", status: "viewed" } });
    expect(act(viewed, sub).menu).toContain("change-renewal");
  });

  it("grace and Won't-renew vs Cancel are judged on renewal_date, not a part's due date", () => {
    const sub = flex({ renewal_date: "2026-10-25" });   // 20 days past, grace 3
    const s = stage(sub, { doc: { kind: "part", quoteId: "Q-P", status: "sent", dueDate: "2026-11-19" } });
    expect(s.days).toBe(5);
    expect(s.renewalDays).toBe(-20);
    const a = act(s, sub, { ...owner, vendorHold: "hold" });
    expect(a.graceOver).toBe(true);
    expect(a.menu).toContain("renew-anyway");
    expect(notRenewingDialog(s)).toBe("cancel");
  });

  it("no renewal date: no Send renewal, no Bill next part, not taken by bulk", () => {
    const y = annual({ renewal_date: null });
    expect(stage(y).label).toBe("No renewal date");
    expect(act(stage(y), y).primary?.kind).toBe("follow-up");
    expect(bulkSendDecision(stage(y)).send).toBe(false);
    const q = quarterly({ renewal_date: null });
    expect(act(stage(q), q).primary?.kind).toBe("follow-up");
  });

  it("stopped / Won't renew with the renewal invoice unpaid → Record payment", () => {
    const st = annual({ status: "suspended" });
    const s = stage(st, { invoice: { id: "INV-9", kind: "renewal", amountDue: 92040 } });
    expect(act(s, st).primary).toMatchObject({ kind: "record-payment", invoiceId: "INV-9" });
    const e = annual({ auto_renew: false });
    expect(act(stage(e, { invoice: { id: "INV-8", kind: "renewal", amountDue: 5 } }), e).primary?.kind).toBe("record-payment");
  });

  it("money: paise below ₹1 kept, other currencies in their own sign", () => {
    expect(stage(annual(), { invoice: { id: "I", kind: "renewal", amountDue: 0.4 } }).label).toMatch(/^Invoiced · ₹0\.40 due$/);
    expect(stage(annual(), { invoice: { id: "I", kind: "renewal", amountDue: 1200, currency: "EUR" } }).label).toBe("Invoiced · €1,200 due");
  });

  it("ownerRule window is measured to the part's start (followingTermStart), whole-term draft is bulk-sendable", () => {
    const q = quarterly({ renewal_date: "2026-11-21" });
    const s = stage(q);
    expect(s.partDays).not.toBeNull();
    expect(act(s, q).primary?.kind).toBe(s.partDays! <= 7 ? "bill-part" : "follow-up");
    const w = annual({ renewal_quote_id: "Q-W" });
    expect(bulkSendDecision(stage(w, { doc: { kind: "renewal", quoteId: "Q-W", status: "draft" } }))).toEqual({ send: true });
  });
});
