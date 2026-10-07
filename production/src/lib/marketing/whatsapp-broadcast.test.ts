import { describe, it, expect } from "vitest";
import {
  STARTER_WA_TEMPLATES, isValidTemplateName, paramCount, templateProblem, slotValues,
  bodyComponents, renderBody, normalizeWaPhone, isStopMessage, firstName,
} from "./whatsapp-broadcast";

describe("WhatsApp broadcast rules", () => {
  it("every starter template is valid, named for Meta, and carries an opt-out line", () => {
    for (const t of STARTER_WA_TEMPLATES) {
      expect(isValidTemplateName(t.name), t.name).toBe(true);
      expect(templateProblem(t.body, t.param_map), t.name).toBeNull();
      expect(t.body).toMatch(/Reply STOP to opt out/);
    }
  });

  it("slots must run 1..n with one field each", () => {
    expect(paramCount("Hi {{1}} from {{2}}")).toBe(2);
    expect(templateProblem("Hi {{1}} from {{3}}", ["first_name", "sender", "company"])).toMatch(/\{\{2\}\} is missing/);
    expect(templateProblem("Hi {{1}}", [])).toMatch(/1 slot,/);
    expect(templateProblem("Hi {{1}}", ["phone"])).toMatch(/is not a field/);
    expect(templateProblem("Hello", [])).toBeNull();
    expect(isValidTemplateName("Festival Offer")).toBe(false);
  });

  it("fills slots with fallbacks — Meta rejects an empty parameter", () => {
    const v = slotValues(["first_name", "company", "sender"], { first_name: "Deepak", company: "", sender: "Anutech" });
    expect(v).toEqual(["Deepak", "your business", "Anutech"]);
    expect(bodyComponents(v)).toEqual([{ type: "body", parameters: [
      { type: "text", text: "Deepak" }, { type: "text", text: "your business" }, { type: "text", text: "Anutech" },
    ] }]);
    expect(bodyComponents([])).toEqual([]);
    expect(renderBody("Hi {{1}}, {{2}}", ["Deepak", "Anutech"])).toBe("Hi Deepak, Anutech");
    expect(firstName("  Deepak Sharma ")).toBe("Deepak");
  });

  it("normalises Indian and international mobile numbers", () => {
    expect(normalizeWaPhone("98990 65121")).toBe("+919899065121");
    expect(normalizeWaPhone("098990 65121")).toBe("+919899065121");
    expect(normalizeWaPhone("+91-98990-65121")).toBe("+919899065121");
    expect(normalizeWaPhone("+1 415 555 0100")).toBe("+14155550100");
    expect(normalizeWaPhone("12345")).toBeNull();
    expect(normalizeWaPhone(null)).toBeNull();
  });

  it("recognises STOP, and not a sentence that merely contains it", () => {
    for (const s of ["STOP", "Stop.", " stop all ", "Stop promotions", "UNSUBSCRIBE", "band karo"]) expect(isStopMessage(s), s).toBe(true);
    for (const s of ["Please don't stop the service", "stopwatch", "", null, "Hi, what is the price?"]) expect(isStopMessage(s as string), String(s)).toBe(false);
  });
});
