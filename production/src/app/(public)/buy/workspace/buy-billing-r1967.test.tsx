// @vitest-environment jsdom
/**
 * R-1967 (26 Oct 2026, Pardeep on the staging Buy now dialog): the price breakdown said
 * "10 users × ₹270/mo × 12 mo" with no word of how it is billed, and there was no way to pick
 * monthly. The owner's path: Buy now → the breakdown says "Billed annually" → Monthly → ₹325
 * a user, "Billed monthly", one month's total → back to Annual → the same total as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { BuyWorkspaceClient } from "./buy-workspace-client";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const dialog = () => screen.getByRole("dialog");

describe("R-1967 Buy now dialog — Annual / Monthly (flex)", () => {
  it("Starter, 10 users: Billed annually ₹38,232 → Monthly ₹325/user, Billed monthly ₹3,835 → Annual again ₹38,232", async () => {
    render(<BuyWorkspaceClient paymentMode="simulation" initialTierId="starter" initialSeats={10} openBuy />);
    const d = await screen.findByRole("dialog");
    expect(within(d).getByText("10 users × ₹270/mo × 12 · Billed annually")).toBeTruthy();
    expect(within(d).getByText("₹38,232")).toBeTruthy();
    expect(within(d).getByRole("radio", { name: /Annual/ }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(d).getByRole("radio", { name: /Monthly \(flex\)/ }));
    expect(within(dialog()).getByText("10 users × ₹325/mo · Billed monthly")).toBeTruthy();
    expect(within(dialog()).getByText("₹3,835")).toBeTruthy();
    expect(within(dialog()).getByText(/Monthly plan \(flex\) — billed each month/)).toBeTruthy();

    fireEvent.click(within(dialog()).getByRole("radio", { name: /^Annual/ }));
    expect(within(dialog()).getByText("₹38,232")).toBeTruthy();
    expect(within(dialog()).getByText(/Annual plan — billed for 12 months/)).toBeTruthy();
  });

  it("the choice goes to the server as `commitment` (the rate never does)", () => {
    const src = readFileSync(join(__dirname, "buy-workspace-client.tsx"), "utf8");
    expect(src).toMatch(/commitment: billing,/);
    const payload = src.slice(src.indexOf("const payload = {"), src.indexOf("/api/public/checkout/workspace\", payload"));
    expect(payload).not.toMatch(/rate|amount|monthlyPrice|annualPrice/);
  });
});
