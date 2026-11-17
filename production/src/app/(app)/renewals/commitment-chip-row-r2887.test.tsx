// @vitest-environment jsdom
/* R-2887 — every Renewals row says its commitment next to the plan (jsdom has no layout: the real row height is
   measured by e2e/cards/R-2887.spec.ts). */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { ProductCell } from "./row-cells";
import { commitmentChip } from "./frequency";

afterEach(cleanup);
const BASE = { mrr: 6500, term_amount: 78000, start_date: "2025-11-10", renewal_date: "2026-11-10" };
const cell = (sub: Parameters<typeof commitmentChip>[0]) => render(
  <ProductCell plan="Google Workspace Business Starter" seats={473} vendor="google" term={null} termShort="1 Nov 26 – 31 Oct 27" frequency={null} commitment={commitmentChip(sub)} domain="example.com" />,
);

describe("R-2887 row chip", () => {
  it("monthly row shows 'Flexible (monthly)' with a plain tooltip", () => {
    cell({ ...BASE, billing_cycle: "monthly", term_months: 1, renewal_date: "2025-12-10" });
    const chip = screen.getByTestId("renewal-commitment");
    expect(chip.textContent).toBe("Flexible (monthly)");
    expect(chip.getAttribute("title")).toMatch(/billed every month/);
  });

  it("yearly row shows 'Annual · paid yearly'; annual paid monthly says so", () => {
    cell({ ...BASE, billing_cycle: "yearly", term_months: 12 });
    expect(screen.getByTestId("renewal-commitment").textContent).toBe("Annual · paid yearly");
    cleanup();
    cell({ ...BASE, billing_cycle: "monthly", term_months: 12 });
    expect(screen.getByTestId("renewal-commitment").textContent).toBe("Annual · paid monthly");
    expect(screen.getByTestId("renewal-commitment").getAttribute("title")).toBe("Annual commitment, billed every month");
  });

  it("unknown term → no chip", () => {
    cell({ ...BASE, billing_cycle: "yearly", term_months: 12, start_date: null });
    expect(screen.queryByTestId("renewal-commitment")).toBeNull();
  });
});
