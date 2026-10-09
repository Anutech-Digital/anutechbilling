// @vitest-environment jsdom
//
// R-490 (R-472 / R-468): "Leave site? Changes you made may not be saved" appeared on pages
// with no form at all (/products 404, lists) because the browser warning read the SAVED
// workspace-tab draft flag, which outlives its form. Now only a mounted, dirty form counts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasDirtyForm, setFormDirty } from "./dirty-forms";

vi.mock("@/components/providers/workspace-tabs-provider", () => ({
  useWorkspaceTabs: () => ({ activeId: "tab-1", setDraft: () => {} }),
}));

import { useDraftGuard } from "./useDraftGuard";

afterEach(() => cleanup());

describe("dirty-forms registry", () => {
  it("is clean until a form says otherwise, and clean again after", () => {
    const a = Symbol("a"), b = Symbol("b");
    expect(hasDirtyForm()).toBe(false);
    setFormDirty(a, true);
    setFormDirty(b, true);
    expect(hasDirtyForm()).toBe(true);
    setFormDirty(a, false);
    expect(hasDirtyForm()).toBe(true);
    setFormDirty(b, false);
    expect(hasDirtyForm()).toBe(false);
  });
});

describe("useDraftGuard feeds the browser warning", () => {
  it("an untouched form never arms it", () => {
    renderHook(() => useDraftGuard(false));
    expect(hasDirtyForm()).toBe(false);
  });

  it("a dirty form arms it; saving (clean) disarms it", () => {
    const { rerender } = renderHook(({ dirty }) => useDraftGuard(dirty), { initialProps: { dirty: true } });
    expect(hasDirtyForm()).toBe(true);
    rerender({ dirty: false });
    expect(hasDirtyForm()).toBe(false);
  });

  it("leaving the page (unmount) disarms it — the next page does not warn", () => {
    const { unmount } = renderHook(() => useDraftGuard(true));
    expect(hasDirtyForm()).toBe(true);
    unmount();
    expect(hasDirtyForm()).toBe(false);
  });
});

describe("the provider asks the live forms, not the saved flags", () => {
  const src = readFileSync(join(__dirname, "../../components/providers/workspace-tabs-provider.tsx"), "utf8");
  it("beforeunload checks hasDirtyForm()", () => {
    const handler = src.slice(src.indexOf("const onBeforeUnload"), src.indexOf("window.addEventListener(\"beforeunload\""));
    expect(handler).toContain("hasDirtyForm()");
    expect(handler).not.toContain("draftTabs(");
  });
  it("a reload drops restored draft flags", () => {
    const hydrate = src.slice(src.indexOf("const saved = loadPersisted();"), src.indexOf("hydrated.current = true;"));
    expect(hydrate).toMatch(/isDraft: false/);
  });
});
