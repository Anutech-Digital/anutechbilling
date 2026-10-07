/**
 * S28 submit-from-app: the pure rules. What must hold — every {{n}} of every starter gets
 * exactly one non-empty example (Meta rejects a variable template without one), no starter
 * body starts or ends with a variable, and "already submitted" is never re-sent.
 */
import { describe, it, expect } from "vitest";
import { STARTER_REMINDER_TEMPLATES } from "./whatsapp-reminders";
import { paramCount } from "./whatsapp-broadcast";
import {
  REMINDER_EXAMPLE_VALUES, appStatusFromMeta, isDuplicateTemplateError, metaErrorText,
  metaTemplateRequest, starterExampleValues, startersToSubmit,
} from "./whatsapp-reminders-submit";

describe("example values", () => {
  it("every {{n}} in every starter gets exactly one non-empty example, in order", () => {
    for (const s of STARTER_REMINDER_TEMPLATES) {
      const ex = starterExampleValues(s.body, s.param_map);
      expect(ex, s.name).toHaveLength(paramCount(s.body));
      for (const v of ex) expect(v.trim(), s.name).not.toBe("");
      expect(ex).toEqual(s.param_map.map((f) => REMINDER_EXAMPLE_VALUES[f]));
    }
  });

  it("every reminder field has a realistic example (money in ₹, a date, a https link)", () => {
    for (const v of Object.values(REMINDER_EXAMPLE_VALUES)) expect(v.trim()).not.toBe("");
    expect(REMINDER_EXAMPLE_VALUES.amount).toMatch(/^₹/);
    expect(REMINDER_EXAMPLE_VALUES.due_date).toMatch(/\d{4}/);
    expect(REMINDER_EXAMPLE_VALUES.link).toMatch(/^https:\/\//);
  });

  it("refuses a map that does not fit the body", () => {
    expect(() => starterExampleValues("Hi {{1}} {{2}}", ["customer_name"])).toThrow(/2 slots/);
  });
});

describe("Meta request body", () => {
  it("is UTILITY, en, one BODY with the text and one example row", () => {
    const s = STARTER_REMINDER_TEMPLATES.find((x) => x.kind === "invoice_due")!;
    expect(metaTemplateRequest(s)).toEqual({
      name: "invoice_due_v1", language: "en", category: "UTILITY",
      components: [{ type: "BODY", text: s.body, example: { body_text: [["Rahul", "INV-2026-0142", "₹1,180", "15 Oct 2026", "Anutech"]] } }],
    });
  });

  it("no starter body starts or ends with a variable (Meta refuses that at submit)", () => {
    for (const s of STARTER_REMINDER_TEMPLATES) {
      expect(s.body.trim(), s.name).not.toMatch(/^\{\{\d+\}\}/);
      expect(s.body.trim(), s.name).not.toMatch(/\{\{\d+\}\}$/);
    }
  });
});

describe("which starters to submit", () => {
  it("all six when the app has none", () => {
    expect(startersToSubmit([])).toHaveLength(6);
  });
  it("skips approved / submitted / paused, keeps draft and rejected, only en counts", () => {
    const got = startersToSubmit([
      { name: "renewal_upcoming_v1", language: "en", status: "approved" },
      { name: "renewal_today_v1", language: "en", status: "submitted" },
      { name: "renewal_grace_v1", language: "en", status: "paused" },
      { name: "invoice_due_v1", language: "en", status: "draft" },
      { name: "invoice_overdue_v1", language: "en", status: "rejected" },
      { name: "invoice_final_v1", language: "hi", status: "approved" },
    ]).map((s) => s.name);
    expect(got).toEqual(["invoice_due_v1", "invoice_overdue_v1", "invoice_final_v1"]);
  });
  it("limits to the asked kinds", () => {
    expect(startersToSubmit([], ["invoice_final"]).map((s) => s.kind)).toEqual(["invoice_final"]);
  });
});

describe("Meta answers", () => {
  it("status mapping matches templates/sync", () => {
    expect(appStatusFromMeta("APPROVED")).toBe("approved");
    expect(appStatusFromMeta("PENDING")).toBe("submitted");
    expect(appStatusFromMeta("REJECTED")).toBe("rejected");
    expect(appStatusFromMeta("PAUSED")).toBe("paused");
    expect(appStatusFromMeta(undefined)).toBe("submitted");
  });
  it("duplicate by subcode or by message", () => {
    expect(isDuplicateTemplateError({ error: { error_subcode: 2388024 } })).toBe(true);
    expect(isDuplicateTemplateError({ error: { message: "Message template already exists" } })).toBe(true);
    expect(isDuplicateTemplateError({ error: { message: "Invalid parameter" } })).toBe(false);
    expect(isDuplicateTemplateError({})).toBe(false);
  });
  it("error text is plain English, actionable, and never carries the token", () => {
    const t = metaErrorText({ error: { message: "bad token EAAsecret123" } }, 400, "EAAsecret123");
    expect(t).not.toContain("EAAsecret123");
    expect(t).toMatch(/resubmit/);
    expect(metaErrorText({ error: { code: 190 } }, 401, "x")).toMatch(/Settings → Integrations/);
    expect(metaErrorText({}, 429, "x")).toMatch(/try again in 10–15 minutes/);
  });
});
