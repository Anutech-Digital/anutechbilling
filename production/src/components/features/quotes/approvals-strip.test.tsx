// @vitest-environment jsdom
//
// The predicate behind this strip is covered in lib/quotes/awaiting-approval.test.ts.
// What is checked here is the half a predicate test cannot reach: that the strip actually
// appears, says a number a person can act on, and disappears when the queue is empty.
//
// It exists because this cannot be browser-verified from this machine — the single pending
// quote in the live books was raised by the only login available, and nobody may approve
// their own quote, so the real app correctly shows this strip to no one. The count query
// was measured against the live database instead (Deepak 1, Omegaco 1, Pardeep 0), and
// this covers the rendering that measurement cannot see.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ApprovalsStrip } from "./approvals-strip";

afterEach(cleanup);

describe("the approvals strip", () => {
  it("says nothing at all when nothing is waiting", () => {
    /* The important half of "only shows when count > 0": an empty queue must not leave a
       permanent amber bar on the page, or the colour stops meaning anything. */
    const { container } = render(<ApprovalsStrip count={0} filtered={false} onToggle={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("names the number and what is blocked by it", () => {
    render(<ApprovalsStrip count={3} filtered={false} onToggle={() => {}} />);
    expect(screen.getByText(/3 quotes need your approval/i)).toBeTruthy();
    /* §24 — the consequence, not just the state. "Needs approval" alone does not tell an
       owner that a colleague is stuck. */
    expect(screen.getByText(/Nobody else can send them until you decide/i)).toBeTruthy();
  });

  it("reads correctly for exactly one, which is the common case", () => {
    render(<ApprovalsStrip count={1} filtered={false} onToggle={() => {}} />);
    expect(screen.getByText(/1 quote needs your approval/i)).toBeTruthy();
    expect(screen.getByText(/send it until you decide/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Review it/i })).toBeTruthy();
    /* Guards the plural branches in both directions — "1 quotes need" and "3 quote needs"
       are the two ways this normally breaks. */
    expect(screen.queryByText(/1 quotes/i)).toBeNull();
  });

  it("offers a way back once the filter is on", () => {
    /* A filter with no visible off switch is how an operator concludes their quotes have
       vanished. */
    render(<ApprovalsStrip count={2} filtered onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: /Show all quotes/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Review them/i })).toBeNull();
  });

  it("toggles the filter in both directions", () => {
    const onToggle = vi.fn();

    const { unmount } = render(<ApprovalsStrip count={2} filtered={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: /Review them/i }));
    expect(onToggle).toHaveBeenLastCalledWith(true);
    unmount();

    render(<ApprovalsStrip count={2} filtered onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: /Show all quotes/i }));
    expect(onToggle).toHaveBeenLastCalledWith(false);
    /* Both directions, not just the on switch: a toggle that cannot be turned off is how
       an operator concludes their quotes have disappeared. */
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("announces itself, because the count arrives after the page does", () => {
    render(<ApprovalsStrip count={1} filtered={false} onToggle={() => {}} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
