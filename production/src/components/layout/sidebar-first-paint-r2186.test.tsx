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
import { render, cleanup, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Me = { role: string; userId: string; tenantId: string; tenantName: string; authEmail: string } | null | undefined;
const st = vi.hoisted(() => ({
  me: undefined as Me,
  identity: "loading" as string,
  pathname: "/dashboard",
  search: "",
  /** The login this browser's local session holds (auth.getSession — no identity round trip). */
  sessionUid: "u-owner" as string | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => st.pathname,
  useSearchParams: () => new URLSearchParams(st.search),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...p }: { href: string; children: React.ReactNode; onClick?: (e: React.MouseEvent) => void }) => (
    // Like next/link: the caller's onClick runs first, then the link takes over the navigation.
    <a href={href} {...p} onClick={(e) => { onClick?.(e); e.preventDefault(); }}>{children}</a>
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
  createClient: () => ({
    rpc: async () => ({ data: null }),
    auth: { getSession: async () => ({ data: { session: st.sessionUid ? { user: { id: st.sessionUid } } : null } }) },
  }),
}));
vi.mock("./account-menu-items", () => ({ AccountMenuItems: () => null }));

import { Sidebar } from "./Sidebar";
import { NavProgressBar, clearNavPending } from "./nav-progress";

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
  st.search = "";
  st.sessionUid = "u-owner";
  clearNavPending();
});
afterEach(cleanup);

describe("Sidebar first paint (R-2186)", () => {
  const remember = (role: string, uid = "u-owner") => localStorage.setItem(ROLE_KEY, JSON.stringify({ role, uid }));
  const menuDrawn = () => document.querySelector("nav a[href='/dashboard']") !== null;

  it("draws the menu from the remembered role while the identity query is still loading", async () => {
    remember("owner");
    renderShell();
    // The pinned Dashboard row — any menu link proves the rail is not blank.
    await waitFor(() => expect(menuDrawn()).toBe(true));
    expect(screen.queryByLabelText("Loading menu")).toBeNull();
  });

  it("not for a different login on this browser (sign-out is a form POST the sidebar never sees)", async () => {
    remember("owner", "u-owner");
    st.sessionUid = "u-sales";
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(menuDrawn()).toBe(false);
    expect(screen.getByLabelText("Loading menu")).toBeTruthy();
  });

  it("not when this browser has no session at all", async () => {
    remember("owner");
    st.sessionUid = null;
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(menuDrawn()).toBe(false);
  });

  it("ignores a remembered value that is not a real role (or the old plain-string form)", async () => {
    remember("superuser");
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(menuDrawn()).toBe(false);
    cleanup();
    localStorage.setItem(ROLE_KEY, "owner");
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(menuDrawn()).toBe(false);
    expect(screen.getByLabelText("Loading menu")).toBeTruthy();
  });

  it("shows placeholder rows, not a blank rail, on a first visit with nothing remembered", () => {
    renderShell();
    expect(screen.getByLabelText("Loading menu")).toBeTruthy();
  });

  it("remembers the role with the login once the identity query answers", () => {
    st.me = { role: "accountant", userId: "u-acc", tenantId: "t1", tenantName: "Co", authEmail: "a@b.c" };
    st.identity = "member";
    renderShell();
    expect(JSON.parse(localStorage.getItem(ROLE_KEY)!)).toEqual({ role: "accountant", uid: "u-acc" });
    expect(screen.queryByLabelText("Loading menu")).toBeNull();
  });

  it("the identity answer wins over a remembered role (a role changed since)", async () => {
    remember("owner", "u-owner");
    st.me = { role: "sales", userId: "u-owner", tenantId: "t1", tenantName: "Co", authEmail: "a@b.c" };
    st.identity = "member";
    renderShell();
    await act(async () => { await Promise.resolve(); });
    // Settings is an owner row a sales login does not get.
    expect(document.querySelector("nav a[href='/settings']")).toBeNull();
    expect(JSON.parse(localStorage.getItem(ROLE_KEY)!).role).toBe("sales");
  });

  it("forgets the role when nobody is signed in", () => {
    remember("owner");
    st.me = null;
    st.identity = "anonymous";
    renderShell();
    expect(localStorage.getItem(ROLE_KEY)).toBeNull();
    expect(menuDrawn()).toBe(false);
  });
});

describe("Sidebar click feedback (R-2186)", () => {
  beforeEach(() => {
    st.me = { role: "owner", userId: "u-owner", tenantId: "t1", tenantName: "Co", authEmail: "a@b.c" };
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

  const rerenderShell = (rerender: (ui: React.ReactElement) => void) =>
    act(() => {
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <NavProgressBar />
          <Sidebar />
        </QueryClientProvider>,
      );
    });

  it("a redirect back to this same page (refused row → ?denied=…) ends the wait", () => {
    const { rerender } = renderShell();
    const link = document.querySelector<HTMLAnchorElement>("nav a[href='/dashboard']")!;
    fireEvent.click(link);
    expect(screen.getByTestId("nav-progress")).toBeTruthy();
    st.search = "denied=%2Fdashboard";
    rerenderShell(rerender);
    expect(screen.queryByTestId("nav-progress")).toBeNull();
    expect(document.querySelector("nav a[href='/dashboard']")!.getAttribute("aria-busy")).toBeNull();
  });

  it("Back/Forward abandons the click", () => {
    renderShell();
    fireEvent.click(document.querySelector<HTMLAnchorElement>("nav a[href='/dashboard']")!);
    expect(screen.getByTestId("nav-progress")).toBeTruthy();
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
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
