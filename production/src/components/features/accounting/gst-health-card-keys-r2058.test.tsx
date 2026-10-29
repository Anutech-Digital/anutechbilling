// @vitest-environment jsdom
/* R-2058 — coordinator's local smoke, 28 Oct: /accounting logged "Encountered two children
   with the same key" because every invoice with no customer is its own GST-health row,
   all named "(no customer on the invoice)" with customerId null, and the row key was
   customerId ?? customerName. Two such rows must both render with no duplicate-key
   warning. Aging and profitability used the same key pattern — the scan below keeps
   it out of all three screens. */
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const NO_CUSTOMER = "(no customer on the invoice)";
vi.mock("@/lib/queries/gst-health", () => ({
  useGstHealth: () => ({
    isLoading: false,
    error: null,
    data: {
      invoicesChecked: 5,
      invoicesWithIssues: 3,
      totalAtRisk: 5400,
      customers: [
        { customerId: null, customerName: NO_CUSTOMER, invoiceCount: 1, atRisk: 1800,
          issues: [{ code: "no_state", severity: "critical", headline: "No place of supply", amountAtRisk: 1800 }] },
        { customerId: null, customerName: NO_CUSTOMER, invoiceCount: 1, atRisk: 1800,
          issues: [{ code: "no_state", severity: "critical", headline: "No place of supply", amountAtRisk: 1800 }] },
        { customerId: "CUST-1", customerName: "Acme", invoiceCount: 1, atRisk: 1800,
          issues: [{ code: "no_gstin", severity: "warning", headline: "GSTIN missing", amountAtRisk: 1800 }] },
      ],
    },
  }),
}));

import { GstHealthCard } from "./gst-health-card";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("R-2058 GST health card — rows without a customer", () => {
  it("renders both no-customer rows with no duplicate-key warning", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<GstHealthCard />);
    expect(screen.getAllByText(NO_CUSTOMER)).toHaveLength(2);
    expect(screen.getByText("Acme")).toBeTruthy();
    const dupKey = err.mock.calls.some((c) => c.some((a) => String(a).includes("same key")));
    expect(dupKey).toBe(false);
  });
});

describe("R-2058 row keys never fall back to the customer name alone", () => {
  const root = join(__dirname, "..", "..", "..", "..");
  const files = [
    "src/components/features/accounting/gst-health-card.tsx",
    "src/app/(app)/accounting/aging/page.tsx",
    "src/app/(app)/accounting/profitability/page.tsx",
  ];
  it.each(files)("%s", (f) => {
    const src = readFileSync(join(root, f), "utf8");
    expect(src).not.toMatch(/key=\{\s*\w+\.customerId\s*\?\?\s*\w+\.customerName\s*\}/);
  });
});
