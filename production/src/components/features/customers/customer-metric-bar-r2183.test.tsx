// @vitest-environment jsdom
/**
 * R-2183 — the Overview Outstanding tile shows the Statement closing in the Statement's words:
 * owed with the advance line, or "₹X credit" (it used to say "All clear" for a credit).
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { CustomerMetricBar, deriveCustomerInsights } from "./customer-insights";
import type { Customer } from "@/lib/supabase/database.types";

afterEach(cleanup);
const c = { id: "C-1", name: "ABDCA", created_at: "2026-01-01" } as unknown as Customer;

describe("R-2183 Outstanding tile = Statement closing", () => {
  it("owed: ₹1,632 with 'Advance ₹1,554 against Q-…, ₹1,632 still due'", () => {
    const ins = deriveCustomerInsights(c, [], [], [], [], 0, { closing: 1632, advanceNotes: ["Advance ₹1,554 against Q-F588-27-0068, ₹1,632 still due"] });
    render(<CustomerMetricBar insights={ins} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("₹1,632");
    expect(text).toContain("Advance ₹1,554 against Q-F588-27-0068, ₹1,632 still due");
  });

  it("credit: '₹1,554 credit', never 'All clear'", () => {
    const ins = deriveCustomerInsights(c, [], [], [], [], 0, { closing: -1554, advanceNotes: [] });
    render(<CustomerMetricBar insights={ins} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("₹1,554 credit");
    expect(text).not.toMatch(/All clear/);
  });
});
