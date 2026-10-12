import { describe, expect, it } from "vitest";
import { isNameOnlyCustomer, mergeNameOnly, nameOnlyToCustomer, type NameOnlyCustomerRow } from "./name-only";
import type { Customer } from "@/lib/supabase/database.types";

const slim = (id: string, name: string): NameOnlyCustomerRow => ({
  id, name, display_name: null, customer_number: null, state_code: "07", country: "India",
  has_gstin: true, account_manager_id: null, is_active: true,
});

describe("R-1004 name-only customers", () => {
  it("a name-only row carries no contact or tax identity", () => {
    const c = nameOnlyToCustomer(slim("b", "Beta"), "t1");
    expect(isNameOnlyCustomer(c)).toBe(true);
    expect([c.contact_email, c.contact_phone, c.contact_mobile, c.gstin, c.address, c.domain]).toEqual([null, null, null, null, null, null]);
    expect(c.state_code).toBe("07");
  });

  it("owner path: no name-only rows → the full list is returned untouched", () => {
    const full = [{ id: "a", name: "Alpha", tenant_id: "t1" }] as Customer[];
    expect(mergeNameOnly(full, [])).toBe(full);
  });

  it("adds only ids the full read did not return, sorted by name", () => {
    const full = [{ id: "c", name: "Gamma", tenant_id: "t1" }] as Customer[];
    const out = mergeNameOnly(full, [slim("c", "Gamma"), slim("b", "Beta")]);
    expect(out.map((c) => c.id)).toEqual(["b", "c"]);
    expect(isNameOnlyCustomer(out[0])).toBe(true);
    expect(isNameOnlyCustomer(out[1])).toBe(false);
    expect(out[0].tenant_id).toBe("t1");
  });

  it("the flag survives a plain copy (React Query structural sharing)", () => {
    const c = nameOnlyToCustomer(slim("b", "Beta"), "t1");
    expect(isNameOnlyCustomer({ ...c })).toBe(true);
  });
});
