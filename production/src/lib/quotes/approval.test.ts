import { describe, it, expect } from "vitest";
import {
  requiredApproval, discountBps, marginBps, isStale, canSend, canApprove, approvalBadge,
  AUTO_APPROVE_DISCOUNT_BPS, MANAGER_MAX_DISCOUNT_BPS, OWNER_MARGIN_FLOOR_BPS,
  type QuoteEconomics, type ApprovalRecord,
} from "./approval";

/** A healthy quote: ₹1,00,000 list, no discount, ₹60,000 cost → 40% margin. */
const healthy: QuoteEconomics = { subtotal: 100_000, listTotal: 100_000, totalCost: 60_000 };

const rec = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  status: "not_required", tier: null, requestedBy: null, approvedBy: null,
  approvedDiscountBps: null, approvedMarginBps: null, rejectionReason: null,
  ...over,
});

describe("discountBps / marginBps", () => {
  it("computes both in basis points, not rounded percentages", () => {
    /* 10.4% must not become "10%, auto-approved" — that is what basis points are
       here to prevent. */
    const e: QuoteEconomics = { subtotal: 89_600, listTotal: 100_000, totalCost: 60_000 };
    expect(discountBps(e)).toBe(1040);
    expect(requiredApproval(e).tier).toBe("manager");
  });

  it("treats a quote priced ABOVE list as 0% discount, not a negative one", () => {
    expect(discountBps({ subtotal: 110_000, listTotal: 100_000, totalCost: 60_000 })).toBe(0);
  });

  it("returns null when there is no list price to discount from", () => {
    expect(discountBps({ subtotal: 50_000, listTotal: 0, totalCost: 20_000 })).toBeNull();
  });

  it("margin is null when cost is unknown", () => {
    expect(marginBps({ ...healthy, costUnknown: true })).toBeNull();
  });
});

describe("the matrix", () => {
  it("sends a clean quote with nobody's permission", () => {
    const r = requiredApproval(healthy);
    expect(r.tier).toBe("none");
    expect(r.reasons).toEqual([]);
    expect(r.approvers).toEqual([]);
  });

  it.each([
    [1000, "none"],       // exactly 10% — at the limit, still automatic
    [1001, "manager"],
    [2000, "manager"],    // exactly 20% — still a manager
    [2001, "owner"],      // one bp past: escalates rather than falling through
    [4000, "owner"],
  ])("%s bps discount → %s", (bps, tier) => {
    const subtotal = Math.round(100_000 * (1 - bps / 10_000));
    expect(requiredApproval({ subtotal, listTotal: 100_000, totalCost: 20_000 }).tier).toBe(tier);
  });

  it("a discount past the top band escalates — it does NOT fall through to nobody", () => {
    /* A matrix where 15% needs a manager and 40% needs nobody is not a matrix. */
    const r = requiredApproval({ subtotal: 60_000, listTotal: 100_000, totalCost: 20_000 });
    expect(r.tier).toBe("owner");
    expect(r.reasons[0]).toMatch(/above the 20%/);
  });

  it.each([
    [1199, "owner"],
    [1200, "none"],   // exactly at the floor is acceptable
    [1201, "none"],
  ])("%s bps margin → %s", (bps, tier) => {
    const totalCost = Math.round(100_000 * (1 - bps / 10_000));
    expect(requiredApproval({ subtotal: 100_000, listTotal: 100_000, totalCost }).tier).toBe(tier);
  });

  it("BOTH tests run — the stricter one wins", () => {
    /* 15% discount (manager) AND 8% margin (owner) → owner. Stopping at the first
       matching rule would let a rep choose the cheaper approver by arranging the
       discount, which is the game this matrix exists to stop. */
    const r = requiredApproval({ subtotal: 85_000, listTotal: 100_000, totalCost: 78_200 });
    expect(r.tier).toBe("owner");
    expect(r.reasons).toHaveLength(2);
  });

  it("unknown cost is a reason for OWNER approval, not a pass", () => {
    /* Skipping the margin test when cost is missing would make an incomplete
       catalogue the cheapest way past the matrix. */
    const r = requiredApproval({ ...healthy, costUnknown: true });
    expect(r.tier).toBe("owner");
    expect(r.reasons.some((x) => /no vendor cost/.test(x))).toBe(true);
    expect(r.marginBps).toBeNull();
  });

  it("names the approvers rather than leaving the rep guessing", () => {
    expect(requiredApproval({ subtotal: 85_000, listTotal: 100_000, totalCost: 20_000 }).approvers)
      .toEqual(["owner", "manager"]);
    expect(requiredApproval({ subtotal: 60_000, listTotal: 100_000, totalCost: 20_000 }).approvers)
      .toEqual(["owner"]);
  });

  it("every reason is a sentence a non-technical owner can act on", () => {
    const r = requiredApproval({ subtotal: 85_000, listTotal: 100_000, totalCost: 78_200 });
    for (const reason of r.reasons) {
      expect(reason.endsWith(".")).toBe(true);
      expect(reason).not.toMatch(/bps|undefined|null/);
    }
  });

  it("the thresholds are the ones the matrix documents", () => {
    expect([AUTO_APPROVE_DISCOUNT_BPS, MANAGER_MAX_DISCOUNT_BPS, OWNER_MARGIN_FLOOR_BPS])
      .toEqual([1000, 2000, 1200]);
  });
});

describe("nobody approves their own quote", () => {
  const need = requiredApproval({ subtotal: 85_000, listTotal: 100_000, totalCost: 20_000 });

  it("refuses the author even when the author is the OWNER", () => {
    /* The hole that makes every other rule decorative. */
    const r = canApprove({ id: "u1", role: "owner" }, rec({ requestedBy: "u1", status: "pending" }), need);
    expect(r).toEqual({ allowed: false, reason: "You cannot approve your own quote." });
  });

  it("lets a different manager approve", () => {
    expect(canApprove({ id: "u2", role: "manager" }, rec({ requestedBy: "u1", status: "pending" }), need).allowed).toBe(true);
  });

  it("refuses a rep who is not an approver, and says who is", () => {
    const r = canApprove({ id: "u2", role: "sales" }, rec({ requestedBy: "u1", status: "pending" }), need);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/manager or the owner/);
  });

  it("refuses a manager on an OWNER-tier quote", () => {
    const ownerTier = requiredApproval({ subtotal: 60_000, listTotal: 100_000, totalCost: 20_000 });
    const r = canApprove({ id: "u2", role: "manager" }, rec({ requestedBy: "u1", status: "pending" }), ownerTier);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Only the owner/);
  });

  it("refuses everyone on a quote that needs no approval", () => {
    expect(canApprove({ id: "u2", role: "owner" }, rec(), requiredApproval(healthy)).allowed).toBe(false);
  });
});

describe("an approval is for specific numbers", () => {
  const approvedAt15 = rec({ status: "approved", tier: "manager", approvedDiscountBps: 1500, approvedMarginBps: 3000 });

  it("goes stale when the discount deepens after sign-off", () => {
    const now = requiredApproval({ subtotal: 70_000, listTotal: 100_000, totalCost: 40_000 });
    expect(isStale(approvedAt15, now)).toBe(true);
  });

  it("goes stale when the margin thins after sign-off", () => {
    const now = requiredApproval({ subtotal: 85_000, listTotal: 100_000, totalCost: 78_000 });
    expect(isStale(approvedAt15, now)).toBe(true);
  });

  it("goes stale when cost becomes unknown after sign-off", () => {
    const now = requiredApproval({ subtotal: 85_000, listTotal: 100_000, totalCost: 0, costUnknown: true });
    expect(isStale(approvedAt15, now)).toBe(true);
  });

  it("does NOT go stale when the rep IMPROVES the deal", () => {
    /* Making them queue again would teach everyone to stop improving quotes after
       sign-off. */
    const now = requiredApproval({ subtotal: 88_000, listTotal: 100_000, totalCost: 40_000 });
    expect(isStale(approvedAt15, now)).toBe(false);
  });

  it("only applies to approved records", () => {
    const now = requiredApproval({ subtotal: 50_000, listTotal: 100_000, totalCost: 40_000 });
    expect(isStale(rec({ status: "pending" }), now)).toBe(false);
  });
});

describe("canSend — §24, never a bare refusal", () => {
  const need = requiredApproval({ subtotal: 85_000, listTotal: 100_000, totalCost: 20_000 });

  it("allows a quote inside the limits", () => {
    expect(canSend(rec(), requiredApproval(healthy))).toEqual({ allowed: true });
  });

  it("blocks an unrequested quote and names the next step", () => {
    const g = canSend(rec(), need);
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.nextStep).toMatch(/Request approval/);
      expect(g.tier).toBe("manager");
    }
  });

  it("blocks while pending, and says where it is", () => {
    const g = canSend(rec({ status: "pending" }), need);
    expect(g.allowed).toBe(false);
    if (!g.allowed) expect(g.nextStep).toMatch(/approvals queue/);
  });

  it("names the actual approvers when the caller knows them", () => {
    /* "the owner" is wrong in this workspace — there are three, and the one reading the
       banner is usually the one who cannot approve it. */
    const g = canSend(rec({ status: "pending" }), need, "Deepak Sharma or Omega Co");
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.reason).toBe("Waiting for Deepak Sharma or Omega Co to approve.");
      expect(g.nextStep).toMatch(/approvals queue/);
    }
  });

  it("falls back to the role when the team has not been loaded", () => {
    const g = canSend(rec({ status: "pending" }), need, undefined);
    expect(g.allowed).toBe(false);
    if (!g.allowed) expect(g.reason).toMatch(/Waiting for (the owner|a manager) to approve/);
  });

  it("says the rule cannot be satisfied when nobody is eligible", () => {
    /* null means "we looked, and there is nobody" — a one-owner workspace where the owner
       raised the quote. Telling them to wait for a queue that can never clear is the one
       answer that leaves them stuck (§24). */
    const g = canSend(rec({ status: "pending" }), need, null);
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.nextStep).toMatch(/Nobody else in this workspace can approve/);
      expect(g.nextStep).not.toMatch(/approvals queue/);
    }
  });

  it("blocks a rejected quote and repeats the reason given", () => {
    const g = canSend(rec({ status: "rejected", rejectionReason: "Margin too thin for this account" }), need);
    expect(g.allowed).toBe(false);
    if (!g.allowed) expect(g.reason).toContain("Margin too thin for this account");
  });

  it("allows an approval that still matches the quote", () => {
    const r = rec({ status: "approved", approvedDiscountBps: 1500, approvedMarginBps: 7000 });
    expect(canSend(r, need).allowed).toBe(true);
  });

  it("blocks a STALE approval — the sign-off covered different numbers", () => {
    const r = rec({ status: "approved", approvedDiscountBps: 1200, approvedMarginBps: 7000 });
    const g = canSend(r, need);
    expect(g.allowed).toBe(false);
    if (!g.allowed) expect(g.reason).toMatch(/changed in the customer's favour/i);
  });

  it("every block carries a reason AND a next step", () => {
    for (const r of [rec(), rec({ status: "pending" }), rec({ status: "rejected" })]) {
      const g = canSend(r, need);
      expect(g.allowed).toBe(false);
      if (!g.allowed) {
        expect(g.reason.length).toBeGreaterThan(10);
        expect(g.nextStep.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("approvalBadge", () => {
  const need = requiredApproval({ subtotal: 85_000, listTotal: 100_000, totalCost: 20_000 });

  it("shows nothing on a quote that never needed approval", () => {
    expect(approvalBadge(rec(), requiredApproval(healthy))).toBeNull();
  });

  it("distinguishes a live approval from a stale one", () => {
    expect(approvalBadge(rec({ status: "approved", approvedDiscountBps: 1500, approvedMarginBps: 7000 }), need))
      .toMatchObject({ label: "Approved", kind: "success" });
    expect(approvalBadge(rec({ status: "approved", approvedDiscountBps: 1200, approvedMarginBps: 7000 }), need))
      .toMatchObject({ label: "Approval stale", kind: "warning" });
  });

  it("names WHICH approval is pending", () => {
    expect(approvalBadge(rec({ status: "pending" }), need)!.label).toBe("Manager approval");
    const ownerNeed = requiredApproval({ subtotal: 60_000, listTotal: 100_000, totalCost: 20_000 });
    expect(approvalBadge(rec({ status: "pending" }), ownerNeed)!.label).toBe("Owner approval");
  });

  it("carries the reason in the tooltip so the badge is not a dead end", () => {
    expect(approvalBadge(rec(), need)!.title).toMatch(/Discount is 15%/);
  });
});
