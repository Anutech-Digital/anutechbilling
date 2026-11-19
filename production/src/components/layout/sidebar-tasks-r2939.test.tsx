// @vitest-environment jsdom
/**
 * R-2939 — Tasks is a pinned sidebar row (next to Today), drawn as ONE link: no accordion, so
 * its Overdue count shows. Its Overview / Calendar pages are tabs on the page, so while you are
 * on one of them the Tasks row is the highlighted row — otherwise nothing in the menu says
 * where you are.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const st = vi.hoisted(() => ({ pathname: "/tasks", role: "owner" }));

vi.mock("next/navigation", () => ({
  usePathname: () => st.pathname,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...p }: { href: string; children: React.ReactNode; onClick?: (e: React.MouseEvent) => void }) => (
    <a href={href} {...p} onClick={(e) => { onClick?.(e); e.preventDefault(); }}>{children}</a>
  ),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { role: st.role, userId: "u1", tenantId: "t1", tenantName: "E2E Test Co", authEmail: "o@example.com" } }),
  useIdentity: () => ({ status: "member", email: null }),
}));
vi.mock("@/lib/hooks/useNavBadges", () => ({ useNavBadges: () => ({ tasks: 3 }) }));
vi.mock("@/lib/queries/sell-mode", () => ({
  useSellMode: () => ({ data: undefined }),
  useHasSubscriptions: () => undefined,
  useShowAllModules: () => [false, vi.fn()],
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: null }),
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
  }),
}));
vi.mock("./account-menu-items", () => ({ AccountMenuItems: () => null }));

import { Sidebar } from "./Sidebar";

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Sidebar /></QueryClientProvider>);
}

/** Row links of the desktop rail, in order (a count badge is its own link with a query string). */
const rowHrefs = () =>
  [...document.querySelectorAll("aside nav a[href]")].map((a) => a.getAttribute("href") ?? "").filter((h) => !h.includes("?"));
const tasksRow = () => document.querySelector<HTMLAnchorElement>("aside nav a[href='/tasks']");

beforeEach(() => { st.pathname = "/tasks"; st.role = "owner"; });
afterEach(cleanup);

describe("Sidebar — Tasks next to Today (R-2939)", () => {
  it("owner: Tasks is the row right after Today, before Dashboard", async () => {
    renderSidebar();
    await waitFor(() => expect(tasksRow()).not.toBeNull());
    const hrefs = rowHrefs();
    const today = hrefs.indexOf("/today");
    expect(today).toBeGreaterThanOrEqual(0);
    expect(hrefs[today + 1]).toBe("/tasks");
    expect(hrefs.indexOf("/dashboard")).toBeGreaterThan(today + 1);
  });

  it("is one link with its Overdue count — no Overview / Calendar rows under it", async () => {
    renderSidebar();
    await waitFor(() => expect(tasksRow()).not.toBeNull());
    expect(document.querySelectorAll("aside nav a[href='/tasks']")).toHaveLength(1);
    expect(document.querySelector("aside nav a[href='/tasks/overview']")).toBeNull();
    expect(document.querySelector("aside nav a[href='/tasks/calendar']")).toBeNull();
    const badge = document.querySelector("aside nav a[aria-label='3 overdue tasks']");
    expect(badge?.textContent).toBe("3");
  });

  it.each(["/tasks/overview", "/tasks/calendar"])("on %s the Tasks row is the highlighted one", async (path) => {
    st.pathname = path;
    renderSidebar();
    await waitFor(() => expect(tasksRow()).not.toBeNull());
    expect(tasksRow()!.className).toContain("bg-amber-soft");
    // aria-current="page" stays for the exact page only — the tab on the page carries it here.
    expect(tasksRow()!.getAttribute("aria-current")).toBeNull();
  });

  it("on /tasks itself it is the current page", async () => {
    renderSidebar();
    await waitFor(() => expect(tasksRow()).not.toBeNull());
    expect(tasksRow()!.getAttribute("aria-current")).toBe("page");
    expect(tasksRow()!.className).toContain("bg-amber-soft");
  });

  it("on another page it is not highlighted", async () => {
    st.pathname = "/dashboard";
    renderSidebar();
    await waitFor(() => expect(tasksRow()).not.toBeNull());
    expect(tasksRow()!.className.split(/\s+/)).not.toContain("bg-amber-soft");
    expect(tasksRow()!.getAttribute("aria-current")).toBeNull();
  });

  it("sales: Tasks is the first row of the menu", async () => {
    st.role = "sales";
    renderSidebar();
    await waitFor(() => expect(tasksRow()).not.toBeNull());
    // (The phone-only Quick Actions grid above the menu also links /leads and /deals — hence "last".)
    const hrefs = rowHrefs();
    expect(hrefs).not.toContain("/today");
    expect(hrefs.indexOf("/tasks")).toBeLessThan(hrefs.lastIndexOf("/leads"));
    expect(hrefs.indexOf("/tasks")).toBeLessThan(hrefs.indexOf("/ai-entry"));
  });
});
