// @vitest-environment jsdom
/**
 * R-1423 — AI Entry: pressing "Read it" with nothing in the box must not call the AI and must
 * not show an error. It shows a plain inline hint next to the box and puts the cursor in it.
 * Non-empty input still goes to /api/ai/data-entry as before.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, message: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: undefined }) }));
vi.mock("@/components/features/ai-entry/entry-card", () => ({ EntryCard: () => null }));

import AiEntryPage from "./page";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ entries: [], notes: [], mode: "ai" }) });
  vi.stubGlobal("fetch", fetchMock);
  toastError.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const box = () => screen.getByRole("textbox", { name: "What to enter" }) as HTMLTextAreaElement;
const readIt = () => screen.getByRole("button", { name: /Read it/ });

describe("R-1423 AI Entry empty 'Read it'", () => {
  it("empty box: no API call, no error toast, inline hint shown, cursor in the box", () => {
    render(<AiEntryPage />);
    fireEvent.click(readIt());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByText(/Paste or type something first — e\.g\./)).toBeTruthy();
    expect(document.activeElement).toBe(box());
    expect(box().getAttribute("aria-invalid")).toBeNull();
  });

  it("whitespace only counts as empty (Ctrl+Enter too)", () => {
    render(<AiEntryPage />);
    fireEvent.change(box(), { target: { value: "   \n  " } });
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Paste or type something first/)).toBeTruthy();
  });

  it("hint goes away once something is typed, and non-empty input is read as before", async () => {
    render(<AiEntryPage />);
    fireEvent.click(readIt());
    fireEvent.change(box(), { target: { value: "Paid ₹500 cash to Gupta" } });
    expect(screen.queryByText(/Paste or type something first/)).toBeNull();
    fireEvent.click(readIt());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ai/data-entry");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Paid ₹500 cash to Gupta" });
  });
});
