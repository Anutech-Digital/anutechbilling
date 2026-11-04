import { describe, expect, it } from "vitest";
import { partLabelOf, partRequestPaymentToast } from "./part-requests";
import { requestMailPart } from "./part-request-chase.server";

/* R-2423: a NEW request's line names product, domain, seats and period, ending "(part n of N)". */
describe("partLabelOf — old and R-2423 line names", () => {
  it("old wording still reads its short name", () => {
    expect(partLabelOf("Advance payment for month 1 · 1 Nov–30 Nov 2026")).toBe("month 1");
  });
  it("new wording reads the part", () => {
    expect(partLabelOf("Google Workspace Business Starter · acme.in · 10 seats · 1 Nov–30 Nov 2026 (part 1 of 12)")).toBe("part 1 of 12");
    expect(partLabelOf("Plan · 1 Mar–31 May 2027 (part 3)")).toBe("part 3");
  });
  it("anything else → null", () => {
    expect(partLabelOf("Google Workspace Business Starter")).toBeNull();
    expect(partLabelOf(null)).toBeNull();
  });
  it("the payment toast reads well with it", () => {
    const t = partRequestPaymentToast({ tone: "success", title: "", lines: [] }, { part: "part 1 of 12", invoiceId: "INV-1", isFullyPaid: true, error: null });
    expect(t.title).toBe("Paid — tax invoice INV-1 raised for part 1 of 12 (subscription continues)");
  });
});


describe("requestMailPart — what the request email names (R-2423)", () => {
  it("one-line request: its line (new or old wording)", () => {
    expect(requestMailPart([{ name: "Workspace · acme.in · 10 seats · 1 Nov–30 Nov 2026 (part 1 of 12)", description: "Advance payment for month 1 · 1 Nov–30 Nov 2026" }]))
      .toBe("Workspace · acme.in · 10 seats · 1 Nov–30 Nov 2026 (part 1 of 12)");
    expect(requestMailPart([{ name: "Advance payment for Q2 · 28 Jan–27 Apr 2027", description: "Starter · 2 seats" }])).toBe("Advance payment for Q2 · 28 Jan–27 Apr 2027");
  });
  it("group request: the short label, never one product's name", () => {
    expect(requestMailPart([
      { name: "Starter · a.in · 2 seats · 1 Nov–30 Nov 2026 (part 1 of 12)", description: "Advance payment for month 1 · 1 Nov–30 Nov 2026" },
      { name: "Plus · a.in · 1 seat · 1 Nov–30 Nov 2026 (part 1 of 1)", description: "Advance payment for month 1 · 1 Nov–30 Nov 2026" },
    ])).toBe("Advance payment for month 1 · 1 Nov–30 Nov 2026");
    /* An older group (before R-2423): its name is the label, its description the plan. */
    expect(requestMailPart([
      { name: "Advance payment for Q2 · 28 Jan–27 Apr 2027", description: "Starter · 2 seats" },
      { name: "Advance payment for Q2 · 28 Jan–27 Apr 2027", description: "Plus · 1 seats" },
    ])).toBe("Advance payment for Q2 · 28 Jan–27 Apr 2027");
  });
  it("no lines → null", () => {
    expect(requestMailPart(null)).toBeNull();
  });
});
