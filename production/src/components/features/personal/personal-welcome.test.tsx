// @vitest-environment jsdom
/**
 * R-2396 (G-PERSONAL) — the personal home a new personal login lands on after the email link:
 * 3 welcome steps ticked from their own rows, and the list of what is free (Money, Digital assets
 * "Coming soon", Free support), an Upgrade link and NO price anywhere (the owner decides prices).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const rows = vi.hoisted(() => ({
  accounts: [] as unknown[], tx: [] as unknown[], contacts: [] as unknown[], loans: [] as unknown[], loading: false,
}));
const q = (data: unknown[]) => ({ data, isLoading: rows.loading });
vi.mock("@/lib/queries/personal-vault", () => ({
  usePersonalAccounts: () => q(rows.accounts),
  usePersonalTransactions: () => q(rows.tx),
}));
vi.mock("@/lib/queries/personal-contacts", () => ({ usePersonalContacts: () => q(rows.contacts) }));
vi.mock("@/lib/queries/personal-loans", () => ({ usePersonalLoans: () => q(rows.loans) }));

import { PersonalWelcome, PERSONAL_FREE_FEATURES, personalWelcomeSteps } from "./personal-welcome";

beforeEach(() => {
  Object.assign(rows, { accounts: [], tx: [], contacts: [], loans: [], loading: false });
});
afterEach(cleanup);

describe("R-2396 personal welcome — 3 steps", () => {
  it("the three steps, in order, each with the page that does it", () => {
    const steps = personalWelcomeSteps({ account: false, entries: false, peopleOrLoans: false });
    expect(steps.map((s) => [s.title, s.href])).toEqual([
      ["Add a bank or cash account", "/vault/personal/banking"],
      ["Add income and expenses", "/vault/personal/expenses"],
      ["Add people and loans", "/vault/personal/people"],
    ]);
  });

  it("a brand-new login sees Welcome, 0 of 3 done, and a link per step", () => {
    render(<PersonalWelcome />);
    expect(screen.getByRole("heading", { name: /Welcome/ })).toBeTruthy();
    expect(screen.getByText(/0 of 3 done/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add account" }).getAttribute("href")).toBe("/vault/personal/banking");
    expect(screen.getByRole("link", { name: "Add an entry" }).getAttribute("href")).toBe("/vault/personal/expenses");
    expect(screen.getByRole("link", { name: "Add a person" }).getAttribute("href")).toBe("/vault/personal/people");
  });

  it("a step is ticked from the person's own rows (a loan counts for people and loans)", () => {
    rows.accounts = [{ id: "a" }];
    rows.loans = [{ id: "l" }];
    render(<PersonalWelcome />);
    expect(screen.getByText(/2 of 3 done/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Add account" })).toBeNull();
    expect(screen.getByRole("link", { name: "Add an entry" })).toBeTruthy();
  });

  it("goes away once all three are done, and while loading", () => {
    Object.assign(rows, { accounts: [{}], tx: [{}], contacts: [{}] });
    const { container } = render(<PersonalWelcome />);
    expect(container.textContent).toBe("");
    cleanup();
    Object.assign(rows, { accounts: [], tx: [], contacts: [], loading: true });
    expect(render(<PersonalWelcome />).container.textContent).toBe("");
  });

  it("Hide closes it, and it stays hidden on this browser", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    try {
      render(<PersonalWelcome />);
      fireEvent.click(screen.getByRole("button", { name: "Hide" }));
      expect(screen.queryByRole("heading", { name: /Welcome/ })).toBeNull();
      cleanup();
      render(<PersonalWelcome />);
      expect(screen.queryByRole("heading", { name: /Welcome/ })).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it("a browser that blocks storage still shows it (and Hide still closes it)", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    try {
      render(<PersonalWelcome />);
      expect(screen.getByRole("heading", { name: /Welcome/ })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Hide" }));
      expect(screen.queryByRole("heading", { name: /Welcome/ })).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("R-2396 personal home — what is free", () => {
  it("lists Money, Digital assets and Free support with every Money feature", () => {
    expect(PERSONAL_FREE_FEATURES.map((g) => g.title)).toEqual(["Money", "Digital assets", "Free support"]);
    const money = PERSONAL_FREE_FEATURES[0].items.map((i) => i.label).join(" | ");
    for (const f of [/accounts/i, /income and expenses/i, /statement import/i, /loans/i, /owe or hold/i, /people/i, /wealth/i]) {
      expect(money).toMatch(f);
    }
  });

  it("features not built yet say Coming soon and are not links; Support goes to /support/my", () => {
    render(<PersonalWelcome />);
    expect(screen.getAllByText("Coming soon").length).toBe(2); // statement import + digital assets
    expect(screen.queryByRole("link", { name: /Bank statement import/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Domains, hosting/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Ask our team for help/ }).getAttribute("href")).toBe("/support/my");
    expect(screen.getByRole("link", { name: /business account adds/ }).getAttribute("href")).toBe("/upgrade");
  });

  it("shows no price and no business words (GST, invoices, CRM)", () => {
    const { container } = render(<PersonalWelcome />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/₹|\bRs\.?\s?\d|per month|\/mo\b/i);
    expect(text).not.toMatch(/\bGST|invoice|CRM|lead/i);
  });
});
