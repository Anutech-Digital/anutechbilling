// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, renderHook, act, cleanup, screen, fireEvent } from "@testing-library/react";
import { useModules } from "./useModules";
import { ModuleGate } from "@/components/shared/module-gate";

// Mock localStorage for Node 22 jsdom environment
const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, "localStorage", {
  value: storageMock,
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, "localStorage", {
  value: storageMock,
  writable: true,
  configurable: true,
});

// Mock next/navigation
let currentPathname = "/leads";
vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
}));

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  storageMock.clear();
  currentPathname = "/leads";
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("Modular Architecture - useModules Hook", () => {
  it("initializes with all 7 modules enabled (including solo_free and salaried_pro) and full bundle discount", () => {
    const { result } = renderHook(() => useModules());

    expect(result.current.isLoaded).toBe(true);
    expect(result.current.activeCount).toBe(7);
    expect(result.current.isModuleActive("solo_free")).toBe(true);
    expect(result.current.isModuleActive("salaried_pro")).toBe(true);
    expect(result.current.isModuleActive("crm")).toBe(true);
    expect(result.current.isModuleActive("invoicing")).toBe(true);
    expect(result.current.isModuleActive("subscriptions")).toBe(true);
    expect(result.current.isModuleActive("provisioning")).toBe(true);
    expect(result.current.isModuleActive("teamops")).toBe(true);

    // Full bundle price is ₹1,999 (regular ₹2,895 with ₹896 bundle savings)
    expect(result.current.totalMonthlyCostRupees).toBe(1999);
    expect(result.current.bundleSavingsRupees).toBe(896);
  });

  it("selectTier activates all lower tiers automatically by default", () => {
    const { result } = renderHook(() => useModules());

    // Switch to Tier 4 (CRM)
    act(() => {
      result.current.selectTier(4);
    });

    expect(result.current.currentTierLevel).toBe(4);
    expect(result.current.activeCount).toBe(4);
    expect(result.current.isModuleActive("salaried_pro")).toBe(true); // Tier 1
    expect(result.current.isModuleActive("solo_free")).toBe(true);    // Tier 2
    expect(result.current.isModuleActive("invoicing")).toBe(true);    // Tier 3
    expect(result.current.isModuleActive("crm")).toBe(true);          // Tier 4
    expect(result.current.isModuleActive("subscriptions")).toBe(false); // Tier 5
    expect(result.current.isModuleActive("teamops")).toBe(false);       // Tier 6
    expect(result.current.isModuleActive("provisioning")).toBe(false);  // Tier 7

    // Cumulative price for Tier 4: ₹499 (Invoicing) + ₹499 (CRM) = ₹998
    expect(result.current.totalMonthlyCostRupees).toBe(998);
  });

  it("activating a higher tier module via toggleModule auto-includes all lower tiers", () => {
    // Start with only Tier 1 (salaried_pro)
    storageMock.setItem("reselleros_active_modules_v1", JSON.stringify(["salaried_pro"]));

    const { result } = renderHook(() => useModules());
    expect(result.current.activeCount).toBe(1);

    // Toggle on CRM (Tier 4)
    act(() => {
      result.current.toggleModule("crm");
    });

    // Auto-includes Tier 1 (salaried), Tier 2 (solo), Tier 3 (invoicing), Tier 4 (crm)
    expect(result.current.activeCount).toBe(4);
    expect(result.current.isModuleActive("salaried_pro")).toBe(true);
    expect(result.current.isModuleActive("solo_free")).toBe(true);
    expect(result.current.isModuleActive("invoicing")).toBe(true);
    expect(result.current.isModuleActive("crm")).toBe(true);
  });

  it("toggles a module off in tier mode stepping down higher versions", () => {
    const { result } = renderHook(() => useModules());

    // Disable CRM module (Tier 4) from full tier
    act(() => {
      result.current.toggleModule("crm");
    });

    // Tiers 4, 5, 6, 7 are stepped down, leaving Tiers 1, 2, 3 active
    expect(result.current.activeCount).toBe(3);
    expect(result.current.isModuleActive("salaried_pro")).toBe(true);
    expect(result.current.isModuleActive("solo_free")).toBe(true);
    expect(result.current.isModuleActive("invoicing")).toBe(true);
    expect(result.current.isModuleActive("crm")).toBe(false);
    expect(result.current.isModuleActive("subscriptions")).toBe(false);
    expect(result.current.currentTierLevel).toBe(3);

    // Pricing for Tiers 1-3 = ₹499/mo
    expect(result.current.totalMonthlyCostRupees).toBe(499);
  });

  it("toggleSingleModule allows a-la-carte toggling without cascading", () => {
    const { result } = renderHook(() => useModules());

    // Disable only CRM without cascading
    act(() => {
      result.current.toggleSingleModule("crm");
    });

    expect(result.current.activeCount).toBe(6);
    expect(result.current.isModuleActive("crm")).toBe(false);
    expect(result.current.isModuleActive("subscriptions")).toBe(true);
    expect(result.current.totalMonthlyCostRupees).toBe(2396);
  });

  it("computes isFreePlanOnly correctly when only solo_free is active", () => {
    storageMock.setItem("reselleros_active_modules_v1", JSON.stringify(["solo_free"]));

    const { result } = renderHook(() => useModules());
    expect(result.current.activeCount).toBe(1);
    expect(result.current.isFreePlanOnly).toBe(true);
    expect(result.current.totalMonthlyCostRupees).toBe(0);
    expect(result.current.bundleSavingsRupees).toBe(0);
  });

  it("rehydrates active modules from localStorage", () => {
    storageMock.setItem(
      "reselleros_active_modules_v1",
      JSON.stringify(["invoicing", "subscriptions"]),
    );

    const { result } = renderHook(() => useModules());

    expect(result.current.isLoaded).toBe(true);
    expect(result.current.activeCount).toBe(2);
    expect(result.current.isModuleActive("crm")).toBe(false);
    expect(result.current.isModuleActive("invoicing")).toBe(true);
    expect(result.current.isModuleActive("subscriptions")).toBe(true);
  });

  it("activateAll enables all modules at once", () => {
    storageMock.setItem("reselleros_active_modules_v1", JSON.stringify(["crm"]));

    const { result } = renderHook(() => useModules());
    expect(result.current.activeCount).toBe(1);

    act(() => {
      result.current.activateAll();
    });

    expect(result.current.activeCount).toBe(7);
    expect(result.current.isModuleActive("invoicing")).toBe(true);
    expect(result.current.isModuleActive("salaried_pro")).toBe(true);
    expect(result.current.totalMonthlyCostRupees).toBe(1999);
  });
});

describe("Modular Architecture - ModuleGate Component Protection", () => {
  it("renders protected child content when the module is active", () => {
    currentPathname = "/leads"; // belongs to crm

    render(
      <ModuleGate>
        <div data-testid="leads-page-content">Real Leads CRM Table</div>
      </ModuleGate>,
    );

    expect(screen.getByTestId("leads-page-content")).toBeTruthy();
    expect(screen.queryByText(/Unlock Reseller CRM/i)).toBeNull();
  });

  it("CRITICAL: completely blocks child content when module is disabled (prevents unauthenticated DB queries)", () => {
    // Disable CRM
    storageMock.setItem(
      "reselleros_active_modules_v1",
      JSON.stringify(["invoicing", "subscriptions", "provisioning", "teamops"]),
    );
    currentPathname = "/leads";

    render(
      <ModuleGate>
        <div data-testid="leads-page-content">Real Leads CRM Table</div>
      </ModuleGate>,
    );

    // Children MUST NOT mount
    expect(screen.queryByTestId("leads-page-content")).toBeNull();

    // Lock banner must be displayed
    expect(screen.getByText(/Unlock Reseller CRM/i)).toBeTruthy();
    expect(screen.getByText(/499/)).toBeTruthy();
    expect(screen.getByText(/Activate 14-Day Free Trial/i)).toBeTruthy();
  });

  it("allows unlocking a disabled plugin directly from the gate lock banner", () => {
    storageMock.setItem("reselleros_active_modules_v1", JSON.stringify([]));
    currentPathname = "/leads";

    const { unmount } = render(
      <ModuleGate>
        <div data-testid="leads-page-content">Real Leads CRM Table</div>
      </ModuleGate>,
    );

    expect(screen.queryByTestId("leads-page-content")).toBeNull();

    const activateBtn = screen.getByText(/Activate 14-Day Free Trial/i);
    fireEvent.click(activateBtn);

    // Verify localStorage was updated
    const stored = JSON.parse(storageMock.getItem("reselleros_active_modules_v1") || "[]");
    expect(stored).toContain("crm");
    unmount();
  });

  it("always renders exempt core system routes (/dashboard, /settings) without locking", () => {
    // Disable all modules
    storageMock.setItem("reselleros_active_modules_v1", JSON.stringify([]));
    currentPathname = "/dashboard";

    render(
      <ModuleGate>
        <div data-testid="dashboard-content">Core Dashboard</div>
      </ModuleGate>,
    );

    expect(screen.getByTestId("dashboard-content")).toBeTruthy();
    expect(screen.queryByText(/Locked Plugin/i)).toBeNull();
  });

  it("allows access to /settings/modules even when all modules are inactive", () => {
    storageMock.setItem("reselleros_active_modules_v1", JSON.stringify([]));
    currentPathname = "/settings/modules";

    render(
      <ModuleGate>
        <div data-testid="modules-marketplace">Module Settings Marketplace</div>
      </ModuleGate>,
    );

    expect(screen.getByTestId("modules-marketplace")).toBeTruthy();
    expect(screen.queryByText(/Locked Plugin/i)).toBeNull();
  });
});
