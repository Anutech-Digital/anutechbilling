// @vitest-environment jsdom
/**
 * R-2186 (G-ZOHO, Zoho Books audit): after a reload the sidebar was EMPTY until the identity
 * query answered (5–15 s in dev) — buildSidebarApps(undefined) has no rows — and a click on a
 * menu row gave no sign anything happened, so people clicked again.
 *
 *  - The role the menu was last drawn for is remembered (localStorage), so a reload draws the
 *    menu on the first client paint, before useCurrentUser answers. The real answer replaces it.
 *  - No remembered role (first visit) → placeholder rows, never a blank rail.
 *  - Signed out (useCurrentUser → null) → the remembered role is forgotten.
 *  - A plain click marks the row pending AT ONCE (aria-busy) and the top progress bar shows
 *    until the route changes; a Ctrl/Cmd-click (new tab) does not.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Me = { role: string; tenantId: string; tenantName: string; authEmail: string } | null | undefined;
const st = vi.hoisted(() => ({
  me: undefined as Me,
  identity: "loading" as string,
  pathname: "/dashboard",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => st.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...p }: { href: string; children: React.ReactNode; onClick?: (e: React.MouseEvent) => void }) => (
    <a href={href} {...p} onClick={(e) => { e.preventDefault(); onClick?.(e); }}>{children}</a>
  ),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: st.me }),
  useIdentity: () => ({ status: st.identity, email: null }),
}));
vi.mock("@/lib/hooks/useNavBadges", () => ({ useNavBadges: () => ({}) }));
vi.mock("@/lib/queries/sell-mode", () => ({
  useSellMode: () => ({ data: undefined }),
  useHasSubscriptions: () => undefined,
  useShowAllModules: () => [false, vi.fn()],
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async () => ({ data: null }) }),
}));
vi.mock("../account-menu-items", () => ({ AccountMenuItems: () => null }));

import { Sidebar } from "../Sidebar";
import { NavProgressBar, clearNavPending } from "../nav-progress";

const ROLE_KEY = "ros_nav_role";

/* Node's own (flag-gated) localStorage shadows jsdom's here — give the window a plain one. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}
Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
const localStorage = window.localStorage;

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NavProgressBar />
      <Sidebar />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  st.me = undefined;
  st.identity = "loading";
  st.pathname = "/dashboard";
  clearNavPending();
});
afterEach(cleanup);

describe("Sidebar first paint (R-2186)", () => {
  it("draws the menu from the remembered role while the identity query is still loading", () => {
    localStorage.setItem(ROLE_KEY, "owner");
    renderShell();
    // Invoices is an owner row (Billing app or flat list) — any menu link proves the rail is not blank.
    const nav = document.querySelector("nav")!;
    expect(nav.querySelectorAll("a[href='/dashboard']").length).toBeGreaterThan(0);
  });

  it("ignores a remembered value that is not a real role", () => {
    localStorage.setItem(ROLE_KEY, "superuser");
    renderShell();
    expect(document.querySelector("nav a[href='/dashboard']")).toBeNull();
    expect(screen.getByLabelText("Loading menu")).toBeTruthy();
  });

  it("shows placeholder rows, not a blank rail, on a first visit with nothing remembered", () => {
    renderShell();
    expect(screen.getByLabelText("Loading menu")).toBeTruthy();
  });

  it("remembers the role once the identity query answers", () => {
    st.me = { role: "accountant", tenantId: "t1", tenantName: "Co", authEmail: "a@b.c" };
    st.identity = "member";
    renderShell();
    expect(localStorage.getItem(ROLE_KEY)).toBe("accountant");
    expect(screen.queryByLabelText("Loading menu")).toBeNull();
  });

  it("forgets the role when nobody is signed in", () => {
    localStorage.setItem(ROLE_KEY, "owner");
    st.me = null;
    st.identity = "anonymous";
    renderShell();
    expect(localStorage.getItem(ROLE_KEY)).toBeNull();
    expect(document.querySelector("nav a[href='/dashboard']")).toBeNull();
  });
});

describe("Sidebar click feedback (R-2186)", () => {
  beforeEach(() => {
    st.me = { role: "owner", tenantId: "t1", tenantName: "Co", authEmail: "a@b.c" };
    st.identity = "member";
    st.pathname = "/settings";
  });

  it("marks the clicked row pending at once and shows the top progress bar", () => {
    const { rerender } = renderShell();
    expect(screen.queryByTestId("nav-progress")).toBeNull();
    const link = document.querySelector<HTMLAnchorElement>("nav a[href='/dashboard']")!;
    fireEvent.click(link);
    // Synchronous: no waiting, no timers.
    expect(link.getAttribute("aria-busy")).toBe("true");
    expect(link.getAttribute("data-pending")).toBe("true");
    expect(screen.getByTestId("nav-progress")).toBeTruthy();

    // The route paints → pending ends, bar gone, row is now the current page.
    st.pathname = "/dashboard";
    const qc = new QueryClient();
    act(() => {
      rerender(
        <QueryClientProvider client={qc}>
          <NavProgressBar />
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    expect(screen.queryByTestId("nav-progress")).toBeNull();
    const now = document.querySelector<HTMLAnchorElement>("nav a[href='/dashboard']")!;
    expect(now.getAttribute("aria-busy")).toBeNull();
    expect(now.getAttribute("aria-current")).toBe("page");
  });

  it("a Ctrl/Cmd-click (opens a new tab) is not a pending navigation", () => {
    renderShell();
    const link = document.querySelector<HTMLAnchorElement>("nav a[href='/dashboard']")!;
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    expect(link.getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByTestId("nav-progress")).toBeNull();
  });

  it("clicking the page you are already on starts nothing", () => {
    st.pathname = "/dashboard";
    renderShell();
    const link = document.querySelector<HTMLAnchorElement>("nav a[href='/dashboard']")!;
    fireEvent.click(link);
    expect(screen.queryByTestId("nav-progress")).toBeNull();
  });
});
