import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoDealValue, checkBoardMove, closeDateShort, dealFormErrors, isCloseOverdue, needsDealDetails,
  type DealFormInput,
} from "@/lib/leads/deal-rules";

/* Deals audit, 30 Sep 2026 — the rules shared by the Add/Edit form, the Kanban drag-drop and
   the deal card. */

const TODAY = "2026-09-30";
type Card = Parameters<typeof checkBoardMove>[0];
const card = (over: Partial<Card> = {}): Card =>
  ({ stage: "quote", company: "Acme", value: 120000, expected_close_date: "2026-10-15", ...over }) as Card;

describe("checkBoardMove — the board obeys the form's rules", () => {
  it("New / Contacted cannot jump the quote-first gate", () => {
    for (const from of ["new", "contact"] as const) {
      for (const to of ["quote", "demo", "trial", "won"] as const) {
        const v = checkBoardMove(card({ stage: from }), to);
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.title).toContain("Send a quote first");
      }
    }
    expect(checkBoardMove(card({ stage: "new" }), "contact").ok).toBe(true);
    expect(checkBoardMove(card({ stage: "contact" }), "new").ok).toBe(true);
  });

  it("Won needs a deal value > 0 AND a close date — the message names what is missing", () => {
    const noValue = checkBoardMove(card({ stage: "trial", value: 0 }), "won");
    expect(noValue.ok).toBe(false);
    if (!noValue.ok) {
      expect(noValue.title).toContain("deal value");
      expect(noValue.title).not.toContain("expected close");
    }
    const noDate = checkBoardMove(card({ stage: "trial", expected_close_date: null }), "won");
    expect(noDate.ok).toBe(false);
    if (!noDate.ok) expect(noDate.title).toContain("expected close");
    const neither = checkBoardMove(card({ stage: "demo", value: null, expected_close_date: null }), "won");
    expect(neither.ok).toBe(false);
    if (!neither.ok) expect(neither.title).toContain("missing: deal value (₹), expected close");
    expect(checkBoardMove(card({ stage: "quote" }), "won").ok).toBe(true);
  });

  it("post-quote moves between deal stages are fine; won never moves back out", () => {
    expect(checkBoardMove(card({ stage: "quote" }), "demo").ok).toBe(true);
    expect(checkBoardMove(card({ stage: "trial" }), "quote").ok).toBe(true);
    expect(checkBoardMove(card({ stage: "won" }), "trial").ok).toBe(false);
    expect(checkBoardMove(card({ stage: "quote" }), "new").ok).toBe(false);
    expect(checkBoardMove(card({ stage: "trial" }), "trial").ok).toBe(true);
  });
});

describe("dealFormErrors — plan / company / close date / Won value", () => {
  const ok: DealFormInput = {
    stage: "quote", isProject: false, company: "Acme Pvt Ltd", plan: "Google Workspace Standard",
    requirement: "", value: 50000, expectedClose: "2026-10-15", today: TODAY,
  };

  it("a complete deal passes", () => expect(dealFormErrors(ok)).toEqual({}));

  it("from Quote onward: plan, company and close date are required", () => {
    for (const stage of ["quote", "demo", "trial", "won"] as const) {
      const e = dealFormErrors({ ...ok, stage, plan: "", company: " ", expectedClose: "" });
      expect(Object.keys(e).sort()).toEqual(["company", "expected_close_date", "plan"]);
    }
  });

  it("a project needs its requirement instead of a plan", () => {
    expect(dealFormErrors({ ...ok, isProject: true, plan: "", requirement: "" })).toHaveProperty("requirement");
    expect(dealFormErrors({ ...ok, isProject: true, plan: "", requirement: "School ERP" })).toEqual({});
  });

  it("Won needs a value", () => {
    expect(dealFormErrors({ ...ok, stage: "won", value: undefined })).toHaveProperty("value");
    expect(dealFormErrors({ ...ok, stage: "quote", value: undefined })).toEqual({});
  });

  it("New / Contacted / Lost stay free — a raw lead may be just a name", () => {
    for (const stage of ["new", "contact", "lost"] as const) {
      expect(dealFormErrors({ ...ok, stage, plan: "", company: "", expectedClose: "", value: null })).toEqual({});
    }
  });

  it("a past close date is refused, unless it is the date already saved (overdue deal being edited)", () => {
    expect(dealFormErrors({ ...ok, expectedClose: "2026-09-29" })).toHaveProperty("expected_close_date");
    expect(dealFormErrors({ ...ok, expectedClose: "2026-09-29", savedClose: "2026-09-29" })).toEqual({});
    expect(dealFormErrors({ ...ok, expectedClose: TODAY })).toEqual({});
  });

  it("needsDealDetails", () => {
    const all = ["new", "contact", "quote", "demo", "trial", "won", "lost"] as const;
    expect(all.filter((s) => needsDealDetails(s))).toEqual(["quote", "demo", "trial", "won"]);
  });
});

describe("expected close on cards", () => {
  it("closeDateShort", () => {
    expect(closeDateShort("2026-10-15")).toBe("15 Oct");
    expect(closeDateShort("2027-01-01")).toBe("1 Jan");
  });
  it("overdue = open deal with a date before today; won / lost / undated never", () => {
    expect(isCloseOverdue({ stage: "trial", expected_close_date: "2026-09-29" }, TODAY)).toBe(true);
    expect(isCloseOverdue({ stage: "trial", expected_close_date: TODAY }, TODAY)).toBe(false);
    expect(isCloseOverdue({ stage: "won", expected_close_date: "2026-09-01" }, TODAY)).toBe(false);
    expect(isCloseOverdue({ stage: "lost", expected_close_date: "2026-09-01" }, TODAY)).toBe(false);
    expect(isCloseOverdue({ stage: "quote", expected_close_date: null }, TODAY)).toBe(false);
  });
});

const FORM = readFileSync(join(process.cwd(), "src", "components", "features", "leads", "add-lead-form.tsx"), "utf8");
const BOARD = readFileSync(join(process.cwd(), "src", "components", "features", "leads", "leads-kanban-board.tsx"), "utf8");

describe("autoDealValue — BUG: opening Edit overwrote a negotiated value", () => {
  it("opening an existing deal (not armed) never writes a value", () => {
    expect(autoDealValue({ armed: false, valueTyped: false, seats: 10, pricePerSeat: 736 })).toBeNull();
  });
  it("after the user changes seats / price / plan: seats × price × 12", () => {
    expect(autoDealValue({ armed: true, valueTyped: false, seats: 10, pricePerSeat: 736 })).toBe(88320);
    expect(autoDealValue({ armed: true, valueTyped: false, seats: 3, pricePerSeat: 650.5 })).toBe(23418);
  });
  it("a value the user typed wins; nothing to multiply means no write", () => {
    expect(autoDealValue({ armed: true, valueTyped: true, seats: 10, pricePerSeat: 736 })).toBeNull();
    expect(autoDealValue({ armed: true, valueTyped: false, seats: 0, pricePerSeat: 736 })).toBeNull();
    expect(autoDealValue({ armed: true, valueTyped: false, seats: 10, pricePerSeat: undefined })).toBeNull();
    expect(autoDealValue({ armed: true, valueTyped: false, seats: Number.NaN, pricePerSeat: 736 })).toBeNull();
  });

  it("the form's auto-calc goes through autoDealValue, disarmed on every open (fails on the old effect)", () => {
    /* The old effect: setValue("value", annualValue) on [plan, watchedSeats], no editingLead guard. */
    expect(FORM).not.toContain("const annualValue = Math.round(pricePerSeat * watchedSeats * 12);");
    expect(FORM).toMatch(/const next = autoDealValue\(\{\s*armed: autoCalcArmed\.current/);
    const resetFx = FORM.slice(FORM.indexOf("Every open starts disarmed"), FORM.indexOf("if (!open) {"));
    expect(resetFx).toContain("autoCalcArmed.current = false;");
  });
  it("only user inputs arm it: plan select, seats, price per seat, smart paste", () => {
    expect((FORM.match(/armAutoCalc\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(FORM).toContain('label="Price per seat (₹/month)"');
  });
});

describe("the wiring", () => {
  it("the form writes expected_close_date and runs the deal rules on step 2 and on save", () => {
    expect(FORM).toContain("expected_close_date: data.expected_close_date || null,");
    expect(FORM).toContain('label="Expected close"');
    expect(FORM).toMatch(/if \(ok && \(step !== 2 \|\| checkDealRules\(\)\)\) setStep\(step \+ 1\);/);
    expect(FORM).toMatch(/const onSubmit = async \(data: FormData\) => \{[\s\S]{0,120}if \(!checkDealRules\(\)\) return;/);
    expect(FORM).toContain('<Review label="Expected close"');
  });

  it("Add Deal does not offer to skip the plan, and the stage hint no longer says a plan unlocks stages", () => {
    expect(FORM).not.toContain("Skip to capture as raw lead (Inbox)");
    expect(FORM).not.toContain("Pick a plan to unlock Demo / Trial / Quote / Won.");
    expect(FORM).toContain('placeholder={dealMode ? "Pick a plan (required)"');
  });

  it("the board checks the rule BEFORE writing the stage, and its header shows weighted ₹", () => {
    const drop = BOARD.slice(BOARD.indexOf("const handleDrop"), BOARD.indexOf("return ("));
    expect(drop.indexOf("checkBoardMove(lead, toStage)")).toBeGreaterThan(-1);
    expect(drop.indexOf("checkBoardMove(lead, toStage)")).toBeLessThan(drop.indexOf("await changeStage(lead, toStage)"));
    expect(BOARD).toContain("Weighted {rupee(sum.weighted");
    expect(BOARD).toContain("≈ visible cards only");
  });
});

/* Pardeep's 6 Oct report (/deals): "Deal amount me ₹0 ... accept ho rahi hai". Blank is fine
   (the lead waits in the inbox); a typed ₹0 is not a deal value, at any stage. Negative is
   already refused by the form's zod min(0) with "raise a credit note instead". */
describe("dealFormErrors — ₹0 is not a deal value", () => {
  const base: DealFormInput = {
    stage: "new", isProject: false, company: "", plan: "",
    requirement: "", value: undefined, expectedClose: "", today: TODAY,
  };
  it("blank value is fine on a new lead", () => expect(dealFormErrors(base).value).toBeUndefined());
  it("₹0 is refused with a way out, even on a new lead", () => {
    expect(dealFormErrors({ ...base, value: 0 }).value).toMatch(/₹0 is not a deal value — leave it blank/);
  });
  it("₹0 is refused on a quote-stage deal too", () => {
    expect(dealFormErrors({ ...base, stage: "quote", company: "Acme", plan: "GW", expectedClose: "2026-10-15", value: 0 }).value)
      .toMatch(/₹0 is not a deal value/);
  });
  it("a real amount passes", () => expect(dealFormErrors({ ...base, value: 1 }).value).toBeUndefined());
});
