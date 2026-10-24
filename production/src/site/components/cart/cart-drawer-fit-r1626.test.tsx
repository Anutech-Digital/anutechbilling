// @vitest-environment jsdom
/**
 * R-1626 (24 Oct 2026): on a 375px phone the drawer is 92vw (345px) minus 44px padding = ~301px
 * of content, but a line's bottom row — cycle words + "1 per domain" + stepper + Remove, ~360px —
 * was one flex row that could not wrap, so Remove sat off the right edge. jsdom cannot measure,
 * so this pins the shape that lets it fit (the 375px width itself is measured in a browser, see
 * the card): the row wraps, and the controls + Remove wrap TOGETHER as one group that never
 * squeezes below its own width.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { cartTotals, type CartLine } from "@/site/lib/money";

const lines: CartLine[] = [{
  key: "d1", label: "averyveryverylongbusinessname.co.in", detail: "Registration, 1 year", unitPrice: 649, qty: 1,
  unit: "year", cycle: "yearly", sku: "domain:co.in", domain: "averyveryverylongbusinessname.co.in", years: 1,
}];

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/domains" }));
vi.mock("./CartProvider", () => ({
  useCart: () => ({
    lines, drawerOpen: true, totals: cartTotals(lines, 0), justAdded: null,
    closeDrawer: vi.fn(), setQty: vi.fn(), remove: vi.fn(), setYears: vi.fn(), domainRenewals: {},
  }),
}));

import { CartDrawer } from "./CartDrawer";

describe("R-1626: a cart drawer line fits a 375px phone", () => {
  it("the line's bottom row wraps, and Remove stays in one group with the stepper", () => {
    render(<CartDrawer />);
    const remove = screen.getByRole("button", { name: "Remove" });
    const group = remove.parentElement as HTMLElement;
    const row = group.parentElement as HTMLElement;
    expect(row.style.flexWrap).toBe("wrap");
    // The stepper and Remove move to the next line together, at their own width.
    expect(group.contains(screen.getByRole("button", { name: /Fewer/ }))).toBe(true);
    expect(group.style.flexShrink).toBe("0");
    expect(group.style.marginLeft).toBe("auto");
  });

  it("a long domain name breaks instead of pushing the price off the edge", () => {
    render(<CartDrawer />);
    const name = screen.getAllByText("averyveryverylongbusinessname.co.in")[0] as HTMLElement;
    expect(parseFloat(name.style.minWidth)).toBe(0);
    expect(name.style.overflowWrap).toBe("anywhere");
  });
});
