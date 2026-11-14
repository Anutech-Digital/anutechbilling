/**
 * R-2710 — "Change renewal" on the Renewals row: which draft opens in the editor.
 */
import { describe, it, expect } from "vitest";
import { renewalChangeStep } from "./start-revision";
import type { RevisionSource } from "./revise";

const q = (p: Partial<RevisionSource & { extension_months: number | null }> = {}) =>
  ({ id: "Q-A-0010", status: "sent", payment_status: "awaiting", invoice_id: null, superseded_by: null,
     revision_of: null, revision_no: 1, subscription_billing_id: null, extension_months: 12, ...p }) as RevisionSource & { extension_months: number | null };

describe("R-2710 renewalChangeStep", () => {
  it("a sent, unpaid renewal quote → a new revision (R-448)", () => {
    expect(renewalChangeStep(q(), null, 0)).toEqual({ kind: "revise" });
    expect(renewalChangeStep(q({ status: "viewed" }), null, 0)).toEqual({ kind: "revise" });
  });

  it("an unsent revision already exists → open THAT one (second click makes no R3)", () => {
    expect(renewalChangeStep(q(), "Q-A-0010-R2", 0)).toEqual({ kind: "open", quoteId: "Q-A-0010-R2" });
  });

  it("the renewal quote is still a draft → open it as it is", () => {
    expect(renewalChangeStep(q({ status: "draft" }), null, 0)).toEqual({ kind: "open", quoteId: "Q-A-0010" });
  });

  it("money on it / accepted / replaced → refused with Revise's own reason", () => {
    const paid = renewalChangeStep(q({ payment_status: "partial" }), null, 500);
    expect(paid.kind).toBe("refuse");
    expect(paid.kind === "refuse" && paid.reason).toMatch(/payment or invoice/);
    const accepted = renewalChangeStep(q({ status: "accepted" }), null, 0);
    expect(accepted.kind === "refuse" && accepted.reason).toMatch(/Only a sent quote can be revised/);
    const replaced = renewalChangeStep(q({ superseded_by: "Q-A-0010-R2" }), null, 0);
    expect(replaced.kind === "refuse" && replaced.reason).toMatch(/Already replaced/);
  });

  it("a leftover unsent revision of a quote that has since been PAID / accepted is NOT opened (sending it would replace the paid quote)", () => {
    expect(renewalChangeStep(q({ payment_status: "received" }), "Q-A-0010-R2", 1416).kind).toBe("refuse");
    expect(renewalChangeStep(q({ status: "accepted" }), "Q-A-0010-R2", 0).kind).toBe("refuse");
  });

  it("a plan-change / support-upgrade quote on the link (extension_months 0) is not a renewal → refused", () => {
    const r = renewalChangeStep(q({ extension_months: 0 }), null, 0);
    expect(r.kind === "refuse" && r.reason).toMatch(/plan change quote, not a renewal quote/);
  });
});
