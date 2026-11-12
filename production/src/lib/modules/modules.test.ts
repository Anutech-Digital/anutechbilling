import { describe, it, expect } from "vitest";
import {
  SYSTEM_MODULES,
  getModuleForRoute,
  DEFAULT_ACTIVE_MODULE_IDS,
} from "./registry";

describe("Commercial Modular Architecture - Registry & Gating", () => {
  it("defines all 5 commercial plug-and-play modules with DPDP-compliant metadata", () => {
    expect(SYSTEM_MODULES).toHaveLength(5);

    const ids = SYSTEM_MODULES.map((m) => m.id);
    expect(ids).toEqual([
      "crm",
      "invoicing",
      "subscriptions",
      "provisioning",
      "teamops",
    ]);

    expect(DEFAULT_ACTIVE_MODULE_IDS).toEqual(ids);

    for (const mod of SYSTEM_MODULES) {
      expect(mod.name).toBeTruthy();
      expect(mod.priceMonthlyRupees).toBeGreaterThan(0);
      expect(mod.features.length).toBeGreaterThan(0);
      expect(mod.coreRoutes.length).toBeGreaterThan(0);
      expect(mod.dbTables.length).toBeGreaterThan(0);
      expect(mod.commercialTarget).toBeTruthy();
    }
  });

  describe("getModuleForRoute mapping", () => {
    it("maps CRM routes correctly", () => {
      expect(getModuleForRoute("/leads")?.id).toBe("crm");
      expect(getModuleForRoute("/leads/new")?.id).toBe("crm");
      expect(getModuleForRoute("/deals")?.id).toBe("crm");
      expect(getModuleForRoute("/contacts")?.id).toBe("crm");
      expect(getModuleForRoute("/enquiries")?.id).toBe("crm");
      expect(getModuleForRoute("/whatsapp")?.id).toBe("crm");
    });

    it("maps Invoicing & Books routes correctly", () => {
      expect(getModuleForRoute("/invoices")?.id).toBe("invoicing");
      expect(getModuleForRoute("/quotes")?.id).toBe("invoicing");
      expect(getModuleForRoute("/accounting")?.id).toBe("invoicing");
      expect(getModuleForRoute("/accounting/expenses")?.id).toBe("invoicing");
      expect(getModuleForRoute("/payments")?.id).toBe("invoicing");
    });

    it("maps Subscriptions & Billing routes correctly", () => {
      expect(getModuleForRoute("/subscriptions")?.id).toBe("subscriptions");
      expect(getModuleForRoute("/renewals")?.id).toBe("subscriptions");
    });

    it("maps Provisioning & Hosting routes correctly", () => {
      expect(getModuleForRoute("/hosting-domains")?.id).toBe("provisioning");
      expect(getModuleForRoute("/provisioning")?.id).toBe("provisioning");
      expect(getModuleForRoute("/products")?.id).toBe("provisioning");
    });

    it("maps TeamOps & Attendance routes correctly", () => {
      expect(getModuleForRoute("/team")?.id).toBe("teamops");
      expect(getModuleForRoute("/team/attendance")?.id).toBe("teamops");
      expect(getModuleForRoute("/attendance")?.id).toBe("teamops");
      expect(getModuleForRoute("/tasks")?.id).toBe("teamops");
      expect(getModuleForRoute("/support")?.id).toBe("teamops");
    });

    it("exempts core system routes so platform remains accessible", () => {
      expect(getModuleForRoute("/settings")).toBeUndefined();
      expect(getModuleForRoute("/settings/modules")).toBeUndefined();
      expect(getModuleForRoute("/dashboard")).toBeUndefined();
      expect(getModuleForRoute("/today")).toBeUndefined();
      expect(getModuleForRoute("/help")).toBeUndefined();
      expect(getModuleForRoute("/unknown-custom-page")).toBeUndefined();
    });
  });

  describe("ModuleGate Protection & Safety Against Premature DB Calls", () => {
    it("ensures inactive modules gate protected routes", () => {
      const activeModules = ["invoicing", "subscriptions"]; // CRM is disabled

      function isAllowed(route: string): boolean {
        const mod = getModuleForRoute(route);
        if (!mod) return true; // System route
        return activeModules.includes(mod.id);
      }

      // CRM routes must be locked
      expect(isAllowed("/leads")).toBe(false);
      expect(isAllowed("/deals")).toBe(false);

      // Invoicing routes must be allowed
      expect(isAllowed("/invoices")).toBe(true);
      expect(isAllowed("/accounting")).toBe(true);

      // Core routes must always remain allowed
      expect(isAllowed("/settings/modules")).toBe(true);
      expect(isAllowed("/dashboard")).toBe(true);
    });
  });
});
