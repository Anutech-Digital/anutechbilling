/* R-2422 — the Renewals row's Last paid links its invoice only for roles that can open /invoices. */
import { describe, expect, it } from "vitest";
import { isRouteAllowed, type UserRole } from "@/lib/nav";
import { canOpenInvoices } from "./access";

describe("R-2422 canOpenInvoices", () => {
  it("owner / manager always; no role never", () => {
    expect(canOpenInvoices("owner")).toBe(true);
    expect(canOpenInvoices("manager")).toBe(true);
    expect(canOpenInvoices(null)).toBe(false);
  });

  it("every other role follows nav.ts (the middleware rule)", () => {
    for (const r of ["sales", "billing", "support", "accountant"]) {
      expect(canOpenInvoices(r)).toBe(isRouteAllowed(r as UserRole, "/invoices/x"));
    }
  });
});
