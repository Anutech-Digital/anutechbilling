// @vitest-environment jsdom
/**
 * GP-07a (R-2115) — the private money screens admit a PERSONAL login (its Money pages) as well
 * as the business owner (Private Vault), and speak to each in its own words: a personal login
 * has no company, so no "company books" and no "Drawings" tab. Everyone else still gets the
 * plain refusal. (The data itself is per-user RLS — this file only decides what is shown.)
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const me = vi.hoisted(() => ({ role: "owner" as string }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { role: me.role }, isLoading: false }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/vault/personal" }));
vi.mock("@/components/features/vault/vault-pin-gate", () => ({
  VaultPinGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import PersonalVaultLayout from "./layout";

afterEach(cleanup);

function renderAs(role: string) {
  me.role = role;
  return render(<PersonalVaultLayout><p>vault body</p></PersonalVaultLayout>);
}

describe("vault/personal layout — who may open it (GP-07a)", () => {
  it("a personal login sees its Money pages, in personal words", () => {
    const { container } = renderAs("personal");
    expect(screen.getByText("vault body")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Money");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/compan/i);
    expect(text).not.toMatch(/drawing/i);
    expect(screen.getByRole("link", { name: /expenses/i }).getAttribute("href")).toBe("/vault/personal/expenses");
  });

  it("the business owner keeps the Private Vault as it was", () => {
    renderAs("owner");
    expect(screen.getByText("vault body")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Private Vault");
    expect(screen.getByRole("link", { name: /drawings & expenses/i })).toBeTruthy();
  });

  it.each(["manager", "sales", "billing", "accountant", "support"])("%s is refused", (role) => {
    renderAs(role);
    expect(screen.queryByText("vault body")).toBeNull();
    expect(screen.getByText(/for the owner only/i)).toBeTruthy();
  });
});
