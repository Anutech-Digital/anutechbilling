// @vitest-environment jsdom
/**
 * R-2477 review: the "Invite from <company>" banner. Pinned: nothing for a login without invites;
 * one row per invite with company + role and "You keep your current company"; Accept posts to the
 * accept route and says what happened with the next step; an accept that switched company loads the
 * app fresh; "Not now" hides it without accepting; a refusal is shown in the server's words.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const st = vi.hoisted(() => ({
  rows: [] as Array<{ invite_id: string; tenant_id: string; company_name: string; role: string }>,
  posts: [] as string[],
  answer: { status: 200, body: { ok: true, companyName: "Beta Traders", role: "sales", selected: false } as Record<string, unknown> },
  toasts: [] as Array<{ kind: string; text: string }>,
  went: [] as string[],
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async () => ({ data: st.rows, error: null }) }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { userId: "u1", role: "owner", tenantId: "t1" } }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: (t: string) => st.toasts.push({ kind: "success", text: t }),
    error: (t: string) => st.toasts.push({ kind: "error", text: t }),
  },
}));

import { CompanyInvitesBanner, invitesNav } from "./company-invites-banner";

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><CompanyInvitesBanner /></QueryClientProvider>);
}

beforeEach(() => {
  st.rows = [{ invite_id: "i1", tenant_id: "t2", company_name: "Beta Traders", role: "sales" }];
  st.posts = []; st.toasts = []; st.went = [];
  st.answer = { status: 200, body: { ok: true, companyName: "Beta Traders", role: "sales", selected: false } };
  window.sessionStorage.clear();
  vi.spyOn(invitesNav, "go").mockImplementation((h: string) => { st.went.push(h); });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    st.posts.push(url);
    return new Response(JSON.stringify(st.answer.body), { status: st.answer.status });
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("CompanyInvitesBanner (R-2477)", () => {
  it("renders nothing without invites", async () => {
    st.rows = [];
    const { container } = renderBanner();
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("shows the company, the role and that they keep their company", async () => {
    renderBanner();
    await screen.findByText("Beta Traders");
    expect(screen.getByRole("region", { name: /Invites from other companies/ }).textContent)
      .toMatch(/Invite from Beta Traders to join as Sales\..*You keep your current company/);
  });

  it("Accept posts to the accept route and says where to find the company", async () => {
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: "Accept the invite from Beta Traders" }));
    await waitFor(() => expect(st.toasts).toHaveLength(1));
    expect(st.posts).toEqual(["/api/team/invites/i1/accept"]);
    expect(st.toasts[0]).toEqual({ kind: "success", text: "You joined Beta Traders as Sales. Switch to it from the company switcher in the top bar." });
    expect(st.went).toEqual([]);
  });

  it("an accept that switched company loads the app fresh", async () => {
    st.answer = { status: 200, body: { ok: true, companyName: "Beta Traders", role: "sales", selected: true } };
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: "Accept the invite from Beta Traders" }));
    await waitFor(() => expect(st.went).toHaveLength(1));
  });

  it("Not now hides it without accepting", async () => {
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: /Not now/ }));
    await waitFor(() => expect(screen.queryByText("Beta Traders")).toBeNull());
    expect(st.posts).toEqual([]);
  });

  it("a refusal is shown in the server's words", async () => {
    st.answer = { status: 403, body: { error: "This invite from Beta Traders has expired. Ask them to invite you again." } };
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: "Accept the invite from Beta Traders" }));
    await waitFor(() => expect(st.toasts).toHaveLength(1));
    expect(st.toasts[0]).toEqual({ kind: "error", text: "This invite from Beta Traders has expired. Ask them to invite you again." });
  });
});
