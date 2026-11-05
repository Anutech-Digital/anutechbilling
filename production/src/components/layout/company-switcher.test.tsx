// @vitest-environment jsdom
/**
 * R-2476 (R-2471 slice 2): the top-bar company switcher.
 *  - hidden for a login with ONE active membership (and while loading / on error);
 *  - with two, lists company name + role, the current one ticked;
 *  - picking another POSTs /api/team/switch-company, then drops every cached query and the old
 *    company's workspace tabs and loads the app fresh — nothing of the old company stays on screen;
 *    the login's other browser tabs are told to load fresh too;
 *  - an unsaved form refuses the switch up front (the server switch would otherwise outrun the
 *    browser's "Leave site?");
 *  - a lost answer is checked against the database before saying anything;
 *  - a refused switch (two-step sign-in pending) shows what happened, why and a button to /mfa,
 *    and leaves the caches alone.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Row = { tenant_id: string; company_name: string; role: string; is_current: boolean };
const st = vi.hoisted(() => ({
  rows: [] as Row[],
  listError: null as { message: string } | null,
  switchError: null as { message: string } | null,
  rpc: vi.fn(),
  fetch: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: st.rpc }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: st.push, refresh: vi.fn() }), usePathname: () => "/quotes/Q-1" }));
vi.mock("sonner", () => ({ toast: { error: st.toastError, success: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { userId: "u-1", role: "manager" } }) }));

import { CompanySwitcher, CompanySwitcherMenuItem, companySwitchNav } from "./company-switcher";
import { COMPANY_SWITCH_CHANNEL, WORKSPACE_TABS_STORAGE_KEY } from "@/lib/auth/company-switch";

const A = "c2476000-0000-0000-0000-0000000000f1";
const B = "c2476000-0000-0000-0000-0000000000f2";
const twoCompanies: Row[] = [
  { tenant_id: A, company_name: "Alpha Traders", role: "manager", is_current: true },
  { tenant_id: B, company_name: "Beta Cloud Pvt Ltd", role: "sales", is_current: false },
];

let qc: QueryClient;
function renderSwitcher() {
  return render(
    <QueryClientProvider client={qc}>
      <CompanySwitcher />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  st.listError = null;
  st.switchError = null;
  st.rpc.mockReset().mockImplementation(async (fn: string) => {
    if (fn === "my_companies") return { data: st.listError ? null : st.rows, error: st.listError };
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
  st.fetch.mockReset().mockImplementation(async () =>
    st.switchError
      ? new Response(JSON.stringify({ error: st.switchError.message }), { status: 403 })
      : new Response(JSON.stringify({ ok: true, tenantId: B }), { status: 200 }));
  vi.stubGlobal("fetch", st.fetch);
  st.toastError.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("CompanySwitcher (R-2476)", () => {
  it("is hidden for a login with one company", async () => {
    st.rows = [twoCompanies[0]];
    const { container } = renderSwitcher();
    await waitFor(() => expect(st.rpc).toHaveBeenCalledWith("my_companies"));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: /switch company/i })).toBeNull();
  });

  it("is hidden when the list cannot load (never a broken button)", async () => {
    st.listError = { message: "network down" };
    const { container } = renderSwitcher();
    await waitFor(() => expect(st.rpc).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });

  it("phone menu item is hidden for one company too", async () => {
    st.rows = [twoCompanies[0]];
    const { container } = render(
      <QueryClientProvider client={qc}>
        <CompanySwitcherMenuItem onSelect={() => {}} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(st.rpc).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });

  it("with two companies lists name + role and ticks the current one", async () => {
    st.rows = twoCompanies;
    renderSwitcher();
    const trigger = await screen.findByRole("button", { name: /switch company — now in Alpha Traders/i });
    expect(trigger.className).toMatch(/\bhidden\b/);
    expect(trigger.className).toMatch(/\bsm:inline-flex\b/);
    fireEvent.click(trigger);
    const current = await screen.findByRole("button", { name: /Alpha Traders.*Manager.*current/i });
    expect(current.getAttribute("aria-current")).toBe("true");
    const other = screen.getByRole("button", { name: /Beta Cloud Pvt Ltd.*Sales/i });
    expect(other.getAttribute("aria-current")).toBeNull();
  });

  it("switching posts the switch, clears every cache and the old tabs, then loads the app fresh", async () => {
    st.rows = twoCompanies;
    const go = vi.spyOn(companySwitchNav, "go").mockImplementation(() => {});
    window.sessionStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, '{"tabs":{"tabs":[{"id":"/quotes/Q-1"}]}}');
    qc.setQueryData(["quotes", "Q-1"], { id: "Q-1", company: "Alpha Traders" });
    const clear = vi.spyOn(qc, "clear");

    renderSwitcher();
    fireEvent.click(await screen.findByRole("button", { name: /switch company/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta Cloud Pvt Ltd/i }));

    await waitFor(() => expect(go).toHaveBeenCalledWith("/dashboard"));
    expect(st.fetch).toHaveBeenCalledWith("/api/team/switch-company", expect.objectContaining({ method: "POST", body: JSON.stringify({ tenantId: B }) }));
    expect(clear).toHaveBeenCalled();
    expect(qc.getQueryData(["quotes", "Q-1"])).toBeUndefined();
    expect(window.sessionStorage.getItem(WORKSPACE_TABS_STORAGE_KEY)).toBeNull();
    expect(st.toastError).not.toHaveBeenCalled();
  });

  it("an unsaved form refuses the switch up front with the next step — nothing sent", async () => {
    st.rows = twoCompanies;
    const go = vi.spyOn(companySwitchNav, "go").mockImplementation(() => {});
    const dirty = await import("@/lib/hooks/dirty-forms");
    const token = Symbol("form");
    dirty.setFormDirty(token, true);
    try {
      renderSwitcher();
      fireEvent.click(await screen.findByRole("button", { name: /switch company/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Beta Cloud Pvt Ltd/i }));
      await waitFor(() => expect(st.toastError).toHaveBeenCalled());
      const [msg, opts] = st.toastError.mock.calls[0] as [string, { description: string }];
      expect(msg).toMatch(/unsaved changes/);
      expect(opts.description).toMatch(/Save or discard/);
      expect(st.fetch).not.toHaveBeenCalled();
      expect(go).not.toHaveBeenCalled();
    } finally {
      dirty.setFormDirty(token, false);
    }
  });

  it("a lost answer: the database says it switched → load fresh; says not → tell the person", async () => {
    st.rows = twoCompanies;
    const go = vi.spyOn(companySwitchNav, "go").mockImplementation(() => {});
    st.fetch.mockRejectedValue(new TypeError("Failed to fetch"));

    renderSwitcher();
    fireEvent.click(await screen.findByRole("button", { name: /switch company/i }));
    st.rows = [{ ...twoCompanies[0], is_current: false }, { ...twoCompanies[1], is_current: true }];
    fireEvent.click(await screen.findByRole("button", { name: /Beta Cloud Pvt Ltd/i }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("/dashboard"));
    expect(st.toastError).not.toHaveBeenCalled();

    cleanup();
    go.mockClear();
    st.rows = twoCompanies;
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderSwitcher();
    fireEvent.click(await screen.findByRole("button", { name: /switch company/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta Cloud Pvt Ltd/i }));
    await waitFor(() => expect(st.toastError).toHaveBeenCalled());
    expect(go).not.toHaveBeenCalled();
    expect((st.toastError.mock.calls[0] as [string, { description: string }])[1].description).toMatch(/Try again/);
  });

  it("another tab of this login switched → this tab drops its cache and loads fresh", async () => {
    expect(typeof BroadcastChannel).toBe("function");
    st.rows = twoCompanies;
    const go = vi.spyOn(companySwitchNav, "go").mockImplementation(() => {});
    qc.setQueryData(["quotes", "Q-1"], { id: "Q-1" });
    renderSwitcher();
    await screen.findByRole("button", { name: /switch company/i });
    const other = new BroadcastChannel(COMPANY_SWITCH_CHANNEL);
    other.postMessage({ type: "switched" });
    other.close();
    await waitFor(() => expect(go).toHaveBeenCalledWith("/dashboard"));
    expect(qc.getQueryData(["quotes", "Q-1"])).toBeUndefined();
  });

  it("a refused switch (two-step sign-in pending) says why + next step with a button, caches kept", async () => {
    st.rows = twoCompanies;
    st.switchError = { message: "Finish two-step sign-in before switching company: open the two-step sign-in page, type the 6-digit code from your authenticator app, then switch again." };
    const go = vi.spyOn(companySwitchNav, "go").mockImplementation(() => {});
    qc.setQueryData(["quotes", "Q-1"], { id: "Q-1" });

    renderSwitcher();
    fireEvent.click(await screen.findByRole("button", { name: /switch company/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Beta Cloud Pvt Ltd/i }));

    await waitFor(() => expect(st.toastError).toHaveBeenCalled());
    const [msg, opts] = st.toastError.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(msg).toMatch(/two-step sign-in/i);
    expect(opts.description).toMatch(/authenticator app/);
    expect(opts.action.label).toBe("Open two-step sign-in");
    expect((opts as { duration?: number }).duration).toBeGreaterThanOrEqual(10_000);
    opts.action.onClick();
    expect(st.push).toHaveBeenCalledWith("/mfa");
    expect(go).not.toHaveBeenCalled();
    expect(qc.getQueryData(["quotes", "Q-1"])).toEqual({ id: "Q-1" });
  });
});
