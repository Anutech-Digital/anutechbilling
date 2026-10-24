// @vitest-environment jsdom
/**
 * R-1807 — Customer profile + the contact page's Company panel built "Outstanding" from
 * subscriptions / invoices / projects / payments reads that could each fail; a failed read
 * became [] and the tile said "All clear" in green. With `failed`, every money tile reads
 * "—" and says it didn't load.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { CustomerMetricBar, deriveCustomerInsights } from "./customer-insights";
import type { Customer } from "@/lib/supabase/database.types";

afterEach(cleanup);

const insights = deriveCustomerInsights({ id: "C-1", name: "Acme", created_at: "2026-01-01" } as unknown as Customer, [], [], [], [], 0);

describe("CustomerMetricBar when the money reads failed (R-1807)", () => {
  it("never says 'All clear' or ₹0 — shows — and 'didn't load'", () => {
    render(<CustomerMetricBar insights={insights} failed />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/All clear/);
    expect(text).not.toMatch(/₹0/);
    expect(text).toMatch(/didn.t load/i);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("loaded and nothing owed still says All clear (as before)", () => {
    render(<CustomerMetricBar insights={insights} />);
    expect(screen.getByText("All clear")).toBeTruthy();
  });
});
