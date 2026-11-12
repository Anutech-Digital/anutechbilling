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
  it("initializes with all 5 commercial modules enabled and full bundle discount", () => {
    const { result } = renderHook(() => useModules());

    expect(result.current.isLoaded).toBe(true);
    expect(result.current.activeCount).toBe(5);
    expect(result.current.isModuleActive("crm")).toBe(true);
    expect(result.current.isModuleActive("invoicing")).toBe(true);
    expect(result.current.isModuleActive("subscriptions")).toBe(true);
    expect(result.current.isModuleActive("provisioning")).toBe(true);
    expect(result.current.isModuleActive("teamops")).toBe(true);

    // Full bundle price is ₹1,999 (regular ₹2,895 with ₹896 bundle savings)
    expect(result.current.totalMonthlyCostRupees).toBe(1999);
    expect(result.current.bundleSavingsRupees).toBe(896);
  });

  it("toggles a module off and updates pricing and localStorage accurately", () => {
    const { result } = renderHook(() => useModules());

    // Disable CRM module
    act(() => {
      result.current.toggleModule("crm");
    });

    expect(result.current.activeCount).toBe(4);
    expect(result.current.isModuleActive("crm")).toBe(false);
    expect(result.current.bundleSavingsRupees).toBe(0);

    // Pricing without CRM (₹499 removed from ₹2,895 regular total = ₹2,396)
    expect(result.current.totalMonthlyCostRupees).toBe(2396);

    // Verify written to localStorage
    const stored = JSON.parse(storageMock.getItem("reselleros_active_modules_v1") || "[]");
    expect(stored).not.toContain("crm");
    expect(stored).toHaveLength(4);
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

    expect(result.current.activeCount).toBe(5);
    expect(result.current.isModuleActive("invoicing")).toBe(true);
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
