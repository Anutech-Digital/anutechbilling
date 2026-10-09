// R-483 (R-442, R-449): Add lead owner + input checks.
import { describe, it, expect } from "vitest";
import { blankLeadValues, ownerForSave, phoneProblem, priceProblem } from "./add-lead-rules";
import { withCreatorAsOwner } from "@/lib/queries/leads";

describe("R-442 — a new lead belongs to whoever adds it", () => {
  it("new lead, Owner box untouched and empty → left for the create hook to fill", () => {
    expect(ownerForSave({ ownerId: "", picked: false, isEditing: false })).toBeUndefined();
  });
  it("new lead with an owner in the box → that owner", () => {
    expect(ownerForSave({ ownerId: "u-2", picked: false, isEditing: false })).toBe("u-2");
  });
  it("'Unassigned' picked on purpose stays unassigned", () => {
    expect(ownerForSave({ ownerId: "", picked: true, isEditing: false })).toBeNull();
  });
  it("edit with an empty box → null (unassigned)", () => {
    expect(ownerForSave({ ownerId: "", picked: false, isEditing: true })).toBeNull();
  });

  it("create hook: no owner given → signed-in user owns and created it", () => {
    const sharma: { company: string; owner_id?: string | null; created_by?: string | null } = { company: "Sharma Traders" };
    expect(withCreatorAsOwner(sharma, "me"))
      .toEqual({ company: "Sharma Traders", owner_id: "me", created_by: "me" });
  });
  it("create hook: explicit null owner is kept, creator still recorded", () => {
    expect(withCreatorAsOwner({ owner_id: null, created_by: null }, "me"))
      .toEqual({ owner_id: null, created_by: "me" });
  });
  it("create hook: a chosen owner is not overwritten", () => {
    expect(withCreatorAsOwner({ owner_id: "u-2" }, "me").owner_id).toBe("u-2");
  });
  it("create hook: nobody signed in → unchanged (requireTenantId refuses anyway)", () => {
    const x: { company: string; owner_id?: string | null } = { company: "X" };
    expect(withCreatorAsOwner(x, undefined)).toEqual({ company: "X" });
  });
});

describe("R-449 — wrong input is refused with a clear message", () => {
  it("5-digit phone is refused, 10-digit and empty are fine", () => {
    expect(phoneProblem("12345")).toBe("A phone number needs at least 10 digits.");
    expect(phoneProblem("+91 98765 43210")).toBeNull();
    expect(phoneProblem("")).toBeNull();
    expect(phoneProblem(undefined)).toBeNull();
  });
  it("negative price per seat is refused", () => {
    expect(priceProblem("-100")).toBe("Price can't be negative.");
    expect(priceProblem("3,240")).toBeNull();
    expect(priceProblem("")).toBeNull();
  });
});

describe("Add lead opens blank after an Edit", () => {
  it("blank values carry no lead data and use the page's default stage", () => {
    const v = blankLeadValues<"new" | "quote">("quote");
    expect(v.company).toBe("");
    expect(v.contact_phone).toBe("");
    expect(v.seats).toBeUndefined();
    expect(v.stage).toBe("quote");
    expect(blankLeadValues(undefined).stage).toBe("new");
  });
});
