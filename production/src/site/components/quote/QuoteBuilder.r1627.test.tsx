// @vitest-environment jsdom
/**
 * R-1627 (weekly UX audit, 19 Oct): on /quote, select the quantity, delete it and type "40" —
 * the line vanished. onChange parsed "" as 0 and setQty(0) deleted the line before the "4"
 * arrived. An empty box while typing now keeps the line; leaving it empty (or 0) puts back 1
 * and says why. Only an explicit action removes a line: unticking it, or "–" at 1.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/quote",
  useRouter: () => ({ push: vi.fn() }),
}));

import { QuoteBuilder } from "./QuoteBuilder";

afterEach(cleanup);

const qtyBox = () => screen.getByRole("textbox", { name: "Google Workspace Business Starter quantity" }) as HTMLInputElement;
const picked = () => screen.getByRole("checkbox", { name: "Select Google Workspace Business Starter" }).getAttribute("aria-checked");

describe("R-1627 /quote quantity box", () => {
  it("clearing the box and typing 40 keeps the line at 40", () => {
    render(<QuoteBuilder />);
    fireEvent.change(qtyBox(), { target: { value: "" } });
    expect(picked()).toBe("true");
    expect(qtyBox().value).toBe("");
    fireEvent.change(qtyBox(), { target: { value: "4" } });
    fireEvent.change(qtyBox(), { target: { value: "40" } });
    fireEvent.blur(qtyBox());
    expect(picked()).toBe("true");
    expect(qtyBox().value).toBe("40");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaving the box empty keeps the line, puts back 1 and says why", () => {
    render(<QuoteBuilder />);
    fireEvent.change(qtyBox(), { target: { value: "" } });
    fireEvent.blur(qtyBox());
    expect(picked()).toBe("true");
    expect(qtyBox().value).toBe("1");
    expect(screen.getByRole("alert").textContent).toMatch(/at least 1/i);
  });

  it("typing 0 does not remove the line either", () => {
    render(<QuoteBuilder />);
    fireEvent.change(qtyBox(), { target: { value: "0" } });
    expect(picked()).toBe("true");
    fireEvent.blur(qtyBox());
    expect(picked()).toBe("true");
    expect(qtyBox().value).toBe("1");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("unticking the line still removes it", () => {
    render(<QuoteBuilder />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Google Workspace Business Starter" }));
    expect(picked()).toBe("false");
  });
});
