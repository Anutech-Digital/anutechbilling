// @vitest-environment jsdom
/**
 * R-2265 (Design D5) — the Quotes list's "Commitment due" banner and section render ON the
 * Quotes list next to its header "New quote" (the page's one primary). Rendered with real
 * sample rows, neither may add a second amber (primary) button. Labels and handlers stay.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { CommitmentDueSection, CommitmentDueStrip } from "./commitment-due-section";
import type { CommitmentDueRow } from "./commitment-due";

afterEach(cleanup);

const rows: CommitmentDueRow[] = [
  {
    quoteId: "Q-A", customerId: "c-a", customerName: "Alpha Traders",
    period: "Advance payment for Q1 · 1 Oct–31 Dec 2026", amount: 2443, stillDue: 2443, partPaid: false,
    billOn: "2026-10-01", due: { days: 27, text: "27 days overdue", tone: "overdue" },
  },
  {
    quoteId: "Q-B", customerId: null, customerName: "Beta Apps",
    period: "Advance payment for Q2 · 28 Oct–27 Jan 2027", amount: 4814, stillDue: 3814, partPaid: true,
    billOn: "2026-10-28", due: { days: 0, text: "Due today", tone: "today" },
  },
];

/** Amber (primary) buttons in the render — the primary variant's `bg-amber` class. */
const amberButtons = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("button, a")).filter((el) => /(^|\s)bg-amber(\s|$)/.test(el.className));

describe("R-2265 — Quotes list keeps one primary with the commitment banner on screen", () => {
  it("self-check: the page CTA (primary Button) is counted", () => {
    const { container } = render(<Button variant="primary">New quote</Button>);
    expect(amberButtons(container)).toHaveLength(1);
  });

  it("banner + header New quote → exactly one amber button; Commitment due still works", () => {
    const onShow = vi.fn();
    const { container } = render(
      <div>
        <Button variant="primary">New quote</Button>
        <CommitmentDueStrip count={2} total={7670} onShow={onShow} />
      </div>,
    );
    expect(amberButtons(container).map((b) => b.textContent?.trim())).toEqual(["New quote"]);
    fireEvent.click(screen.getByRole("button", { name: /Commitment due/ }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("commitment section with rows + header New quote → exactly one amber button; row actions kept", () => {
    const onRecordPayment = vi.fn();
    const { container } = render(
      <div>
        <Button variant="primary">New quote</Button>
        <CommitmentDueSection
          rows={rows}
          total={2443 + 3814}
          mayRecordMoney
          onRecordPayment={onRecordPayment}
          onCustomerStopped={() => {}}
          onClose={() => {}}
        />
      </div>,
    );
    expect(amberButtons(container).map((b) => b.textContent?.trim())).toEqual(["New quote"]);
    const pay = screen.getAllByRole("button", { name: /Record payment/ });
    expect(pay.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(pay[0]);
    expect(onRecordPayment).toHaveBeenCalled();
  });
});
