// @vitest-environment jsdom
/**
 * R-1508: the website's "Report a problem" / "Back to dashboard" strip is for a signed-in TEAM
 * member only. A visitor without the preview cookie gets nothing (and never loads the tools); with
 * the cookie, nothing until a team member (users row with a workspace) is confirmed. "Report a
 * problem" opens the app's own Help panel on its Report tab.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const st = vi.hoisted(() => ({ me: null as null | { tenantId: string | null } }));
const openHelpReport = vi.fn();

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: st.me }) }));
vi.mock("@/components/shared/ai-help", () => {
  return { openHelpReport: () => openHelpReport(), AiHelp: () => <div data-testid="ai-help-panel" /> };
});
vi.mock("@/components/shared/global-bug-reporter", () => ({ GlobalBugReporter: () => null }));

import { SitePreviewBar } from "./SitePreviewBar";
import { SITE_PREVIEW_COOKIE } from "@/site/lib/site-preview";

function setCookie(on: boolean) {
  document.cookie = on ? `${SITE_PREVIEW_COOKIE}=1; path=/` : `${SITE_PREVIEW_COOKIE}=; path=/; max-age=0`;
}

beforeEach(() => { st.me = null; openHelpReport.mockClear(); setCookie(false); });
afterEach(() => cleanup());

describe("SitePreviewBar (R-1508)", () => {
  it("a visitor without the preview cookie sees nothing", async () => {
    st.me = { tenantId: "t1" };
    const { container } = render(<SitePreviewBar />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: /report a problem/i })).toBeNull();
  });

  it("with the cookie but not a signed-in team member: nothing", async () => {
    setCookie(true);
    const { container } = render(<SitePreviewBar />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("[data-site-preview-bar]")).toBeNull();
    expect(screen.queryByRole("button", { name: /report a problem/i })).toBeNull();
    st.me = { tenantId: null };
    cleanup();
    render(<SitePreviewBar />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: /report a problem/i })).toBeNull();
  });

  it("a signed-in team member previewing gets Report a problem (the app's Help panel) and Back to dashboard", async () => {
    setCookie(true);
    st.me = { tenantId: "t1" };
    render(<SitePreviewBar />);
    const btn = await waitFor(() => screen.getByRole("button", { name: /report a problem/i }));
    expect(screen.getByRole("link", { name: /back to dashboard/i }).getAttribute("href")).toBe("/dashboard");
    expect(screen.getByTestId("ai-help-panel")).toBeTruthy();
    fireEvent.click(btn);
    expect(openHelpReport).toHaveBeenCalledTimes(1);
  });
});
