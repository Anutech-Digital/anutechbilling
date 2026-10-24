// @vitest-environment jsdom
//
// R-1506 (17 Oct 2026, Pawan on staging, 3 reports): on the website, "See how migration works"
// (<a href="#move"> on /hosting) and every other in-page #section button made the page flicker
// and go nowhere. Root cause, measured in the browser: the click is a same-page fragment
// navigation, which fires `popstate` with a NULL state; this provider (mounted in the ROOT
// layout, so it runs on the website too) answered every popstate with router.replace(path) —
// the #hash was stripped, the page jumped back to the top and re-fetched.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, act } from "@testing-library/react";

const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/hosting",
  useRouter: () => ({ replace, push, refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("./confirm-provider", () => ({ useConfirm: () => () => Promise.resolve(false) }));

import { WorkspaceTabsProvider } from "./workspace-tabs-provider";

function pop(state: unknown) {
  act(() => { window.dispatchEvent(new PopStateEvent("popstate", { state })); });
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState({ __NA: true }, "", "/hosting");
  render(<WorkspaceTabsProvider><a href="#move">See how migration works</a><section id="move" /></WorkspaceTabsProvider>);
  replace.mockClear();
  push.mockClear();
});
afterEach(cleanup);

describe("WorkspaceTabsProvider popstate — R-1506", () => {
  it("leaves a #section click alone: no router.replace, the hash stays", () => {
    // What the browser does for <a href="#move">: a new entry with a null state, then popstate.
    window.history.pushState(null, "", "/hosting#move");
    pop(null);
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#move");
  });

  it("still follows a real Back between router entries, keeping any #fragment", () => {
    window.history.pushState({ __NA: true }, "", "/hosting#move");
    pop({ __NA: true });
    expect(replace).toHaveBeenCalledWith("/hosting#move");
  });
});
