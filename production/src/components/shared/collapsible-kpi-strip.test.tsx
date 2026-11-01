// @vitest-environment jsdom
// R-2266 (Design D6 — work list above the fold): the KPI strip on Quotes, Invoices, Renewals,
// Companies and Subscriptions starts CLOSED as one line with the key numbers, remembers the
// owner's open / closed choice per user, keeps linked counts (banners moved onto the line)
// one click away, and never prints the same number in the header AND in the tiles.
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CollapsibleKpiStrip, StripFact, StripLink, kpiStripKey } from "./collapsible-kpi-strip";
import { CommitmentDueStrip } from "@/app/(app)/quotes/commitment-due-section";

/* jsdom here has no working localStorage — an in-memory stand-in (same as subs-insights-strip.test). */
const mem = new Map<string, string>();
const realStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
};
Object.defineProperty(window, "localStorage", { configurable: true, value: realStorage });

afterEach(cleanup);
beforeEach(() => {
  mem.clear();
  Object.defineProperty(window, "localStorage", { configurable: true, value: realStorage });
});

function Strip({ userId = "u-owner", onLink = () => {} }: { userId?: string | null; onLink?: () => void }) {
  return (
    <CollapsibleKpiStrip
      stripId="quotes"
      userId={userId}
      title="Insights"
      summary={<><StripFact label="Pipeline" value="₹4.2L" /><StripFact label="Accepted" value="₹1.1L" tone="emerald" /></>}
      extras={<StripLink onClick={onLink}>3 waiting on customer</StripLink>}
    >
      <p>TILES Pipeline ₹4.2L</p>
    </CollapsibleKpiStrip>
  );
}

const toggle = () => screen.getByRole("button", { name: /Insights/ });

describe("R-2266 CollapsibleKpiStrip", () => {
  it("starts CLOSED as one line that carries the key numbers", () => {
    render(<Strip />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/TILES/)).toBeNull();
    expect(toggle().textContent).toMatch(/Pipeline ₹4\.2L/);
    expect(toggle().textContent).toMatch(/Accepted ₹1\.1L/);
    expect(toggle().textContent).toMatch(/Expand/);
  });

  it("open → the tiles show and the header line no longer repeats their numbers", () => {
    render(<Strip />);
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/TILES/)).toBeDefined();
    expect(toggle().textContent).not.toMatch(/₹4\.2L/);
    expect(toggle().textContent).toMatch(/Collapse/);
  });

  it("remembers open / closed per user across a reload", () => {
    render(<Strip />);
    fireEvent.click(toggle());
    expect(mem.get(kpiStripKey("quotes", "u-owner")!)).toBe("open");
    cleanup();
    render(<Strip />);                          // same user, page reloaded
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    cleanup();
    render(<Strip userId="u-staff" />);         // another user on the same browser
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    cleanup();
    render(<Strip />);
    fireEvent.click(toggle());                  // close again
    expect(mem.get(kpiStripKey("quotes", "u-owner")!)).toBe("closed");
    cleanup();
    render(<Strip />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("each page has its own key", () => {
    expect(kpiStripKey("quotes", "u1")).not.toBe(kpiStripKey("invoices", "u1"));
    expect(kpiStripKey("quotes", null)).toBeNull();
  });

  it("no user yet → still works, stores nothing", () => {
    render(<Strip userId={null} />);
    fireEvent.click(toggle());
    expect(screen.getByText(/TILES/)).toBeDefined();
    expect(mem.size).toBe(0);
  });

  it("blocked storage (private mode) → renders closed and still toggles", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError"); },
    });
    render(<Strip />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle());
    expect(screen.getByText(/TILES/)).toBeDefined();
  });

  it("a linked count on the line is one click away, open or closed, and does not toggle", () => {
    const onLink = vi.fn();
    render(<Strip onLink={onLink} />);
    fireEvent.click(screen.getByRole("button", { name: /3 waiting on customer/ }));
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle());
    expect(screen.getByRole("button", { name: /3 waiting on customer/ })).toBeDefined();
  });
});

describe("R-2266 Commitment due as a linked count on the Quotes strip", () => {
  it("compact: names count + total, opens the list in one click", () => {
    const onShow = vi.fn();
    render(<CommitmentDueStrip compact count={2} total={6257} onShow={onShow} />);
    const b = screen.getByRole("button", { name: /Commitment due/ });
    expect(b.textContent).toMatch(/Commitment due 2/);
    expect(b.getAttribute("aria-label")).toMatch(/6,257/);
    fireEvent.click(b);
    expect(onShow).toHaveBeenCalledTimes(1);
  });
  it("compact is silent at zero", () => {
    const { container } = render(<CommitmentDueStrip compact count={0} total={0} onShow={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
