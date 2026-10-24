// @vitest-environment jsdom
/* R-1860 — Settings → Company → "What do you sell?": Both picked by default, the owner changes and
   saves it, a non-owner only sees it, and before the migration it cannot be saved. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const state = vi.hoisted(() => ({
  saved: { mode: "both", columnMissing: false } as { mode: string; columnMissing: boolean },
  mutate: vi.fn(),
}));
vi.mock("@/lib/queries/sell-mode", () => ({
  useSellMode: () => ({ data: state.saved, isLoading: false, isError: false }),
  useSaveSellMode: () => ({ mutate: state.mutate, isPending: false }),
}));

import { SellModeCard } from "./sell-mode-card";

const option = (name: string) =>
  within(screen.getByRole("group", { name: "What do you sell?" })).getByRole("button", { name });

beforeEach(() => {
  state.saved = { mode: "both", columnMissing: false };
  state.mutate.mockReset();
});
afterEach(cleanup);

describe("SellModeCard (R-1860)", () => {
  it("shows the three answers with Both picked, and Save off until something changes", () => {
    render(<SellModeCard isOwner />);
    expect(option("Both").getAttribute("aria-pressed")).toBe("true");
    expect(option("Subscriptions").getAttribute("aria-pressed")).toBe("false");
    expect(option("One-time products & services").getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the owner picks One-time and saves it", () => {
    render(<SellModeCard isOwner />);
    fireEvent.click(option("One-time products & services"));
    expect(screen.getByText(/renewal screens stay out of the menu/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(state.mutate).toHaveBeenCalledWith("one_time");
  });

  it("says nothing is switched off", () => {
    render(<SellModeCard isOwner />);
    expect(screen.getByText(/Nothing is switched off/)).toBeTruthy();
  });

  it("a non-owner sees the answer but cannot change it", () => {
    state.saved = { mode: "one_time", columnMissing: false };
    render(<SellModeCard isOwner={false} />);
    expect(option("One-time products & services").getAttribute("aria-pressed")).toBe("true");
    expect((option("Both") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("before the migration: read-only, everything shown", () => {
    state.saved = { mode: "both", columnMissing: true };
    render(<SellModeCard isOwner />);
    expect(screen.getByText(/Needs a database update/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
