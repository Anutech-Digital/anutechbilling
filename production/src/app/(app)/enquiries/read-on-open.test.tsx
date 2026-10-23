// @vitest-environment jsdom
//
// R-1125 — j/k through the list opened (and so marked read) every thread it passed.
// Now a thread is marked read only after it stays open READ_AFTER_MS, or at once on an
// explicit click; and "Mark unread" puts the dot back.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useReadOnOpen, READ_AFTER_MS, type ReadThread } from "./read-on-open";

const PAGE = resolve(process.cwd(), "src/app/(app)/enquiries/page.tsx");

const th = (key: string, read = false): ReadThread => ({
  key,
  messages: [
    { id: `${key}-1`, read_at: read ? "2026-10-01T00:00:00Z" : null },
    { id: `${key}-2`, read_at: null },
  ],
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe("useReadOnOpen (R-1125)", () => {
  it("holding j through 5 threads leaves them unread", () => {
    const mark = vi.fn();
    const { rerender } = renderHook(({ t }) => useReadOnOpen(t, mark), { initialProps: { t: th("a") } });
    for (const k of ["b", "c", "d", "e"]) {
      act(() => { vi.advanceTimersByTime(300); });
      rerender({ t: th(k) });
    }
    // The last one is still open but not for 2s yet.
    act(() => { vi.advanceTimersByTime(READ_AFTER_MS - 300); });
    expect(mark).not.toHaveBeenCalled();
  });

  it("a thread left open for 2s is marked read (only its unread messages)", () => {
    const mark = vi.fn();
    renderHook(() => useReadOnOpen(th("a", true), mark));
    act(() => { vi.advanceTimersByTime(READ_AFTER_MS); });
    expect(mark.mock.calls).toEqual([["a-2", true]]);
  });

  it("an explicit open marks read at once", () => {
    const mark = vi.fn();
    const { result } = renderHook(() => useReadOnOpen(null, mark));
    act(() => { result.current.markRead(th("x")); });
    expect(mark.mock.calls).toEqual([["x-1", true], ["x-2", true]]);
  });

  it("Mark unread restores the dot and is not undone by the pending timer", () => {
    const mark = vi.fn();
    const allRead: ReadThread = { key: "a", messages: [{ id: "a-1", read_at: "x" }, { id: "a-2", read_at: "x" }] };
    const { result } = renderHook(() => useReadOnOpen(allRead, mark));
    act(() => { result.current.markUnread(allRead); });
    expect(mark.mock.calls).toEqual([["a-2", false]]);
    act(() => { vi.advanceTimersByTime(READ_AFTER_MS * 2); });
    expect(mark.mock.calls).toEqual([["a-2", false]]);
  });
});

describe("Enquiries page wiring (R-1125)", () => {
  const src = readFileSync(PAGE, "utf8");
  it("does not mark every message read the moment the selection moves", () => {
    expect(src).not.toMatch(/setState\.mutate\(\{\s*id:\s*m\.id,\s*read:\s*true\s*\}\)/);
    expect(src).toMatch(/useReadOnOpen\(/);
  });
  it("has a Mark unread action", () => {
    expect(src).toMatch(/Mark unread/);
    expect(src).toMatch(/markUnread\(/);
  });
});
