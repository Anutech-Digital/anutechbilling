// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import {
  BulkActionBar,
  BulkBarButton,
  BulkBarConfirmButton,
} from "./bulk-action-bar";

/* ─────────────────────────────────────────────────────────────────────────────
   The two-step confirm is tested HERE and not in the browser, deliberately.

   Proving it by clicking "Delete" on the leads table means clicking a destructive bulk
   action on eleven real leads and trusting that the guard holds. If the guard is what is
   broken, the test destroys the data it was written to protect. So the browser verified the
   bar renders and the actions are wired; this file verifies the click that cannot be undone.
   ───────────────────────────────────────────────────────────────────────────── */

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("BulkActionBar", () => {
  it("renders nothing when nothing is selected", () => {
    /* The parent mounts it unconditionally so the slide-up has somewhere to animate from —
       so "count 0 renders nothing" is the contract, not an optimisation. */
    const { container } = render(<BulkActionBar count={0} noun="lead" onClear={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("pluralises the accessible label, so a screen reader hears a sentence", () => {
    const { rerender } = render(<BulkActionBar count={1} noun="invoice" onClear={() => {}} />);
    expect(screen.getByRole("toolbar").getAttribute("aria-label")).toBe("Bulk actions on 1 selected invoice");
    rerender(<BulkActionBar count={4} noun="invoice" onClear={() => {}} />);
    expect(screen.getByRole("toolbar").getAttribute("aria-label")).toBe("Bulk actions on 4 selected invoices");
  });

  it("always offers a way out of the selection", () => {
    /* Clear is rendered by the shell rather than by each caller, so a page cannot ship a bulk
       bar that traps the user in a selection they cannot dismiss. */
    const onClear = vi.fn();
    render(<BulkActionBar count={2} noun="lead" onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe("BulkBarConfirmButton — the click that cannot be undone", () => {
  it("does NOT fire on the first click", () => {
    /* The whole point. A dense pill of small buttons, a pointer already moving, and an action
       that applies to every selected row at once. */
    const onConfirm = vi.fn();
    render(<BulkBarConfirmButton onConfirm={onConfirm}>Delete</BulkBarConfirmButton>);

    fireEvent.click(screen.getByRole("button"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("arms visibly, then fires on the second click", () => {
    const onConfirm = vi.fn();
    render(<BulkBarConfirmButton onConfirm={onConfirm}>Delete</BulkBarConfirmButton>);

    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("Delete");

    fireEvent.click(btn);
    expect(btn.textContent).toContain("Tap to confirm");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("disarms itself after the timeout, so a forgotten bar cannot fire later", () => {
    /* A confirm that stays armed forever is a confirm the user stops seeing — they walk away
       mid-decision, come back, and one stray click deletes the selection. */
    const onConfirm = vi.fn();
    render(<BulkBarConfirmButton onConfirm={onConfirm}>Delete</BulkBarConfirmButton>);

    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(btn.textContent).toContain("Tap to confirm");

    act(() => { vi.advanceTimersByTime(4000); });

    expect(btn.textContent).toContain("Delete");
    fireEvent.click(btn);
    expect(onConfirm, "a click after the timeout must re-arm, not fire").not.toHaveBeenCalled();
  });

  it("re-arms after firing, rather than staying hot for the next row", () => {
    const onConfirm = vi.fn();
    render(<BulkBarConfirmButton onConfirm={onConfirm}>Delete</BulkBarConfirmButton>);

    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toContain("Delete");

    /* One more click must NOT fire a second time — otherwise a double-click on the armed
       button deletes twice. */
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("announces the armed state, not just recolours it", () => {
    /* A screen-reader user gets no benefit from the button turning red. */
    render(<BulkBarConfirmButton onConfirm={() => {}}>Delete</BulkBarConfirmButton>);
    expect(screen.getByRole("button").getAttribute("aria-live")).toBe("polite");
  });
});

describe("BulkBarButton", () => {
  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(<BulkBarButton onClick={onClick} disabled>Export</BulkBarButton>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("fires once per click", () => {
    const onClick = vi.fn();
    render(<BulkBarButton onClick={onClick}>Export</BulkBarButton>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

/* R-268: on a 375×812 phone the bar sat at bottom-6 — UNDER the 56px bottom tab bar (same
   z-40), and wider than the screen with three actions. jsdom has no layout, so the contract
   is pinned on the classes that produce the geometry: lift above --bottom-nav-h on phones,
   never wider than the viewport minus the gutter, and a marker the FAB hides itself against. */
describe("BulkActionBar — phone geometry (R-268)", () => {
  it("sits above the mobile bottom nav, not under it", () => {
    render(<BulkActionBar count={2} noun="invoice" onClear={() => {}} />);
    const cls = screen.getByRole("toolbar").className;
    expect(cls).toContain("bottom-[calc(var(--bottom-nav-h,56px)+0.75rem)]");
    expect(cls).toContain("md:bottom-6");
    expect(cls).not.toMatch(/(^|\s)bottom-6(\s|$)/);
  });

  it("is never wider than the viewport and scrolls its actions instead", () => {
    render(<BulkActionBar count={2} noun="invoice" onClear={() => {}} />);
    const cls = screen.getByRole("toolbar").className;
    expect(cls).toContain("max-w-[calc(100vw-1.5rem)]");
    expect(cls).toContain("overflow-x-auto");
  });

  it("marks itself so the FAB can step aside while rows are selected", () => {
    render(<BulkActionBar count={2} noun="invoice" onClear={() => {}} />);
    expect(screen.getByRole("toolbar").hasAttribute("data-bulk-bar")).toBe(true);
  });
});
