// @vitest-environment jsdom
/**
 * R-2625 — the Balance Sheet's Management view card: Advance billing, below the statutory sheet.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));

import { AdvanceBillingCard } from "./advance-billing-card";

afterEach(cleanup);

const TOTALS = { totalAssets: 14_160, totalLiab: 2_160, netWorth: 12_000 };

describe("R-2625 AdvanceBillingCard", () => {
  it("yearly ₹12,000 dated 1 Oct, at 31 Oct: Advance billing ₹11,000; management net worth ₹1,000; balanced", () => {
    render(<AdvanceBillingCard data={{ advance: 11_000, invoiced: 12_000, earned: 1_000 }} failed={false} asOf="2026-10-31" totals={TOTALS} />);
    expect(screen.getByText("Advance billing (unearned revenue)")).toBeTruthy();
    expect(screen.getByText("₹11,000")).toBeTruthy();
    expect(screen.getByText("Total liabilities (management)").nextSibling?.textContent).toBe("₹13,160");
    expect(screen.getByText("Net worth (management)").nextSibling?.textContent).toBe("₹1,000");
    expect(screen.getByTestId("advance-billing-balanced").textContent).toContain("Assets ₹14,160 = Liabilities + Equity ₹14,160");
    expect(screen.getByText(/statutory \(GST\) one/)).toBeTruthy();
  });

  it("nothing invoiced in advance (₹0) or a database without the revenue report (null): no card", () => {
    const { container: a } = render(<AdvanceBillingCard data={{ advance: 0, invoiced: 500, earned: 500 }} failed={false} asOf="2026-11-09" totals={TOTALS} />);
    expect(a.textContent).toBe("");
    const { container: b } = render(<AdvanceBillingCard data={null} failed={false} asOf="2026-11-09" totals={TOTALS} />);
    expect(b.textContent).toBe("");
  });

  it("negative: revenue earned, not yet invoiced — an asset; net worth higher", () => {
    render(<AdvanceBillingCard data={{ advance: -2_000, invoiced: 0, earned: 2_000 }} failed={false} asOf="2026-11-09" totals={TOTALS} />);
    expect(screen.getByText("Revenue earned, not yet invoiced")).toBeTruthy();
    expect(screen.getByText("Total assets (management)").nextSibling?.textContent).toBe("₹16,160");
    expect(screen.getByText("Net worth (management)").nextSibling?.textContent).toBe("₹14,000");
  });

  it("a failed load says so — never a ₹0 card", () => {
    render(<AdvanceBillingCard data={undefined} failed asOf="2026-11-09" totals={TOTALS} />);
    expect(screen.getByRole("status").textContent).toContain("could not load");
  });
});
