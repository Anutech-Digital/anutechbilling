import { describe, it, expect } from "vitest";
import {
  SYSTEM_MODULES,
  getModuleForRoute,
  getModulesForRoute,
  DEFAULT_ACTIVE_MODULE_IDS,
} from "./registry";

describe("Commercial Modular Architecture - Registry & Gating", () => {
  it("defines all 7 plug-and-play modules including Solo Free & Salaried Pro Free packs", () => {
    expect(SYSTEM_MODULES).toHaveLength(7);

    const ids = SYSTEM_MODULES.map((m) => m.id);
    expect(ids).toEqual([
      "solo_free",
      "salaried_pro",
      "crm",
      "invoicing",
      "subscriptions",
      "provisioning",
      "teamops",
    ]);

    expect(DEFAULT_ACTIVE_MODULE_IDS).toEqual(ids);

    // Solo Free Tier validation
    const soloFree = SYSTEM_MODULES.find((m) => m.id === "solo_free");
    expect(soloFree).toBeDefined();
    expect(soloFree?.priceMonthlyRupees).toBe(0);
    expect(soloFree?.isFreeTier).toBe(true);
    expect(soloFree?.badge).toBe("Free Forever");

    // Salaried Pro Tier validation
    const salariedPro = SYSTEM_MODULES.find((m) => m.id === "salaried_pro");
    expect(salariedPro).toBeDefined();
    expect(salariedPro?.priceMonthlyRupees).toBe(0);
    expect(salariedPro?.isFreeTier).toBe(true);
    expect(salariedPro?.badge).toBe("Free Forever");
    expect(salariedPro?.coreRoutes).toContain("/employee-hub");

    for (const mod of SYSTEM_MODULES) {
      expect(mod.name).toBeTruthy();
      expect(mod.features.length).toBeGreaterThan(0);
      expect(mod.coreRoutes.length).toBeGreaterThan(0);
      expect(mod.dbTables.length).toBeGreaterThan(0);
      expect(mod.commercialTarget).toBeTruthy();
      if (mod.id !== "solo_free" && mod.id !== "salaried_pro") {
        expect(mod.priceMonthlyRupees).toBeGreaterThan(0);
      }
    }
  });

  describe("getModulesForRoute & getModuleForRoute mapping", () => {
    it("maps CRM routes correctly", () => {
      expect(getModuleForRoute("/leads")?.id).toBe("crm");
      expect(getModuleForRoute("/leads/new")?.id).toBe("crm");
      expect(getModuleForRoute("/deals")?.id).toBe("crm");
      expect(getModuleForRoute("/enquiries")?.id).toBe("crm");
      expect(getModuleForRoute("/whatsapp")?.id).toBe("crm");
    });

    it("maps shared invoicing routes to both solo_free and invoicing", () => {
      const invoiceMods = getModulesForRoute("/invoices").map((m) => m.id);
      expect(invoiceMods).toContain("solo_free");
      expect(invoiceMods).toContain("invoicing");

      const quoteMods = getModulesForRoute("/quotes").map((m) => m.id);
      expect(quoteMods).toContain("solo_free");
      expect(quoteMods).toContain("invoicing");

      // Accounting is exclusive to pro invoicing module
      const accountingMods = getModulesForRoute("/accounting").map((m) => m.id);
      expect(accountingMods).toEqual(["invoicing"]);
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

    it("maps Salaried Pro routes correctly", () => {
      expect(getModuleForRoute("/employee-hub")?.id).toBe("salaried_pro");
      expect(getModuleForRoute("/employee-hub/tax")?.id).toBe("salaried_pro");
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

  describe("ModuleGate Protection & Multi-Module Route Matching", () => {
    it("allows solo_free tier users to access basic invoicing without paid invoicing module", () => {
      const soloOnlyActive = ["solo_free"];

      function isAllowed(route: string): boolean {
        const matchingMods = getModulesForRoute(route);
        if (matchingMods.length === 0) return true; // System route
        return matchingMods.some((m) => soloOnlyActive.includes(m.id));
      }

      // Solo user can access invoices, quotes, payments, contacts
      expect(isAllowed("/invoices")).toBe(true);
      expect(isAllowed("/quotes")).toBe(true);
      expect(isAllowed("/payments")).toBe(true);
      expect(isAllowed("/contacts")).toBe(true);

      // Solo user cannot access enterprise accounting or CRM sales pipeline
      expect(isAllowed("/accounting")).toBe(false);
      expect(isAllowed("/leads")).toBe(false);
      expect(isAllowed("/deals")).toBe(false);
      expect(isAllowed("/team")).toBe(false);
    });

    it("ensures inactive modules gate protected routes", () => {
      const activeModules = ["invoicing", "subscriptions"]; // CRM is disabled

      function isAllowed(route: string): boolean {
        const matchingMods = getModulesForRoute(route);
        if (matchingMods.length === 0) return true; // System route
        return matchingMods.some((m) => activeModules.includes(m.id));
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
