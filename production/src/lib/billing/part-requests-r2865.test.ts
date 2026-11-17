/* R-2865 (16 Nov 2026, Pardeep — staging Q-A378-27-0124): a renewal part proforma is the payment request for
   its service period, not an advance. New requests carry "Payment for month 1 · 1 Oct–31 Oct 2026"; requests
   issued before keep "Advance payment for month 1 · …". Every reader must take BOTH, and nothing the app
   itself writes may say "advance" for a part request. */
import { describe, it, expect } from "vitest";
import { isPartShortLabel, partAdvanceOf, partAdvanceText, partLabelOf, requestReminderText, type RequestReminderStep } from "./part-requests";
import { requestMailPart } from "./part-request-chase.server";

const NEW = "Payment for month 1 · 1 Oct–31 Oct 2026";
const OLD = "Advance payment for month 1 · 1 Oct–31 Oct 2026";
const NAME = "Google Workspace Business Starter · ravi.in · 473 seats · 1 Oct–31 Oct 2026 (part 1 of 1)";

describe("R-2865 the part's short label — new and old text", () => {
  it("isPartShortLabel takes both, and nothing else", () => {
    expect(isPartShortLabel(NEW)).toBe(true);
    expect(isPartShortLabel(OLD)).toBe(true);
    expect(isPartShortLabel("  Payment for Q2 · 28 Jan–27 Apr 2027 ")).toBe(true);
    expect(isPartShortLabel(NAME)).toBe(false);
    expect(isPartShortLabel("Payment received")).toBe(false);
    // a product whose own name starts "Payment for …" is a product line, not a label
    expect(isPartShortLabel("Payment for gateway setup · acme.in · 2 seats · 1 Nov–30 Nov 2026 (part 1 of 12)")).toBe(false);
    expect(isPartShortLabel("Payment for H1 · 1 Oct–31 Mar 2027")).toBe(true);
    expect(isPartShortLabel("Payment for part 3")).toBe(true);
    expect(isPartShortLabel("")).toBe(false);
    expect(isPartShortLabel(null)).toBe(false);
  });

  it("partLabelOf: month / Q / H from both texts; a product line → its (part n of N)", () => {
    expect(partLabelOf(NEW)).toBe("month 1");
    expect(partLabelOf(OLD)).toBe("month 1");
    expect(partLabelOf("Payment for Q2 · 28 Jan–27 Apr 2027")).toBe("Q2");
    expect(partLabelOf("Advance payment for Q2 · 28 Jan–27 Apr 2027")).toBe("Q2");
    expect(partLabelOf("Payment for H1 · 1 Oct–31 Mar 2027")).toBe("H1");
    expect(partLabelOf("Payment for part 3")).toBe("part 3");
    expect(partLabelOf(NAME)).toBe("part 1 of 1");
    expect(partLabelOf("Workspace Starter")).toBeNull();
    expect(partLabelOf("Payment for gateway setup · acme.in · 2 seats · 1 Nov–30 Nov 2026 (part 1 of 12)")).toBe("part 1 of 12");
    expect(partLabelOf("Advance payment for month 3")).toBe("month 3");
  });

  it("requestMailPart: one line → its product line; a group → its short label, new or old", () => {
    expect(requestMailPart([{ name: NAME, description: NEW }])).toBe(NAME);
    expect(requestMailPart([{ name: "Starter · a.in · 2 seats · 1 Oct–31 Oct 2026 (part 1 of 12)", description: NEW }, { name: "Plus · a.in · 1 seat · 1 Oct–31 Oct 2026 (part 1 of 12)", description: NEW }])).toBe(NEW);
    expect(requestMailPart([{ name: "Starter · a.in · 2 seats · 1 Oct–31 Oct 2026 (part 1 of 12)", description: OLD }, { name: "Plus · a.in · 1 seat", description: OLD }])).toBe(OLD);
    // a group whose description is something else (hand-typed) → the first line's name, as before
    expect(requestMailPart([{ name: "Starter · a.in", description: "Renewal" }, { name: "Plus · a.in" }])).toBe("Starter · a.in");
  });

  const STEPS: (RequestReminderStep | "new")[] = ["new", "pre_due", "due_today", "reminder", "retry", "final"];
  const mail = (step: RequestReminderStep | "new", part: string, quoteId: string) => requestReminderText({
    step, customerName: "Ravi Shankar", companyName: "Anutech", quoteId, part, amount: "₹7,080", dueOn: "1 Oct 2026", payUrl: "https://app.example/pay",
  });

  it("mails of a new request never say advance — proforma or older Q- number, every step", () => {
    for (const id of ["PI-A378-27-0124", "Q-A378-27-0124"]) for (const step of STEPS) for (const part of [NEW, NAME]) {
      const m = mail(step, part, id);
      expect(`${m.subject}\n${m.body}`, `${id} ${step}`).not.toMatch(/advance/i);
      expect(m.body, `${id} ${step}`).not.toContain("payment for Payment for");
    }
    expect(mail("new", NEW, "Q-9").subject).toBe("Payment for month 1 · 1 Oct–31 Oct 2026 — ₹7,080 (Q-9)");
    expect(mail("new", NEW, "Q-9").body).toContain("Here is your payment request: Payment for month 1 · 1 Oct–31 Oct 2026. It is due on 1 Oct 2026.");
    expect(mail("new", NEW, "PI-1").body).toContain("Here is your proforma invoice PI-1 for month 1 · 1 Oct–31 Oct 2026. It is due on 1 Oct 2026.");
    expect(mail("reminder", NEW, "PI-1").body).toContain("A reminder: the payment for month 1 · 1 Oct–31 Oct 2026 was due on 1 Oct 2026.");
    // a one-line request names its product line — unchanged
    expect(mail("reminder", NAME, "PI-1").body).toContain(`A reminder: the payment for ${NAME} was due on 1 Oct 2026.`);
  });

  it("reminders of an OLD group request say what the payment is for, not 'advance'", () => {
    for (const step of STEPS.filter((s) => s !== "new")) {
      const m = mail(step, OLD, "PI-1");
      expect(m.body, step).toContain("month 1 · 1 Oct–31 Oct 2026");
      expect(`${m.subject}\n${m.body}`, step).not.toMatch(/advance/i);
    }
  });
});

describe("R-2865 Record payment wording on a part request", () => {
  it("owner's request (Q-A378-27-0124): 'Payment for …', never 'advance'", () => {
    const adv = partAdvanceOf({ lines: [{ name: NAME, description: NEW, period_start: "2026-10-01", period_end: "2026-10-31" }], partShort: "Part 1 of 1", subscription: "Google Workspace Business Starter · ravi.in" });
    expect(adv.what).toBe("1 Oct–31 Oct 2026");
    const text = partAdvanceText(adv, "Ravi Shankar");
    expect(text).toBe("Payment for 1 Oct–31 Oct 2026 of Google Workspace Business Starter · ravi.in (Part 1 of 1) from Ravi Shankar. The tax invoice is raised when you confirm the full payment.");
    expect(text).not.toMatch(/advance/i);
  });

  it("an OLD stored document still reads its month · period — and the sheet still does not say advance", () => {
    const adv = partAdvanceOf({ lines: [{ name: OLD }], partShort: "Part 1 of 1", subscription: null });
    expect(adv.what).toBe("month 1 · 1 Oct–31 Oct 2026");
    expect(partAdvanceText(adv, "Ravi Shankar")).toBe("Payment for month 1 · 1 Oct–31 Oct 2026 (Part 1 of 1) from Ravi Shankar. The tax invoice is raised when you confirm the full payment.");
  });

  it("a group request: the label from the description — new and old give the same words", () => {
    const lines = (d: string) => [{ name: "Starter · a.in · 1 Nov–30 Nov 2026", description: d }, { name: "Plus · a.in · 1 Nov–30 Nov 2026", description: d }];
    const a = partAdvanceOf({ lines: lines("Payment for Q2 · 1 Nov 2026–31 Jan 2027"), partShort: "Part 2 of 4", subscription: "Starter · a.in" });
    const b = partAdvanceOf({ lines: lines("Advance payment for Q2 · 1 Nov 2026–31 Jan 2027"), partShort: "Part 2 of 4", subscription: "Starter · a.in" });
    expect(a).toEqual({ what: "Q2 · 1 Nov 2026–31 Jan 2027", part: "Part 2 of 4", subscription: null });
    expect(b).toEqual(a);
  });
});
