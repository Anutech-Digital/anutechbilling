// @vitest-environment jsdom
/**
 * R-2477 review + R-2517: the "Invite from <company>" banner. Pinned: nothing for a login without
 * invites; one row per invite with company + role, "open the link we emailed to <address>" and
 * "You keep your current company"; NO Accept button and nothing is posted (R-2517 — only the emailed
 * link accepts); an invite without a link says to ask again; "Not now" hides it.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const st = vi.hoisted(() => ({
  rows: [] as Array<{ invite_id: string; tenant_id: string; company_name: string; role: string; email?: string; has_link?: boolean }>,
  posts: [] as string[],
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async () => ({ data: st.rows, error: null }) }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { userId: "u1", role: "owner", tenantId: "t1" } }),
}));

import { CompanyInvitesBanner } from "./company-invites-banner";

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><CompanyInvitesBanner /></QueryClientProvider>);
}

beforeEach(() => {
  st.rows = [{ invite_id: "i1", tenant_id: "t2", company_name: "Beta Traders", role: "sales", email: "ravi@x.test", has_link: true }];
  st.posts = [];
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { st.posts.push(url); return new Response("{}"); }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("CompanyInvitesBanner (R-2477 + R-2517)", () => {
  it("renders nothing without invites", async () => {
    st.rows = [];
    const { container } = renderBanner();
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("shows the company, the role, the emailed link as the way to accept, and that they keep their company", async () => {
    renderBanner();
    await screen.findByText("Beta Traders");
    expect(screen.getByRole("region", { name: /Invites from other companies/ }).textContent)
      .toMatch(/Invite from Beta Traders to join as Sales. To accept, open the link we emailed to ravi@x.test..*You keep your current company/);
  });

  it("R-2517: there is no Accept button and nothing is posted", async () => {
    renderBanner();
    await screen.findByText("Beta Traders");
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(st.posts).toEqual([]);
  });

  it("an invite without a link says to ask the company again", async () => {
    st.rows = [{ invite_id: "i1", tenant_id: "t2", company_name: "Beta Traders", role: "sales", email: "ravi@x.test", has_link: false }];
    renderBanner();
    await screen.findByText("Beta Traders");
    expect(screen.getByRole("region").textContent).toMatch(/Ask Beta Traders to invite you again/);
  });

  it("Not now hides it", async () => {
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: /Not now/ }));
    await waitFor(() => expect(screen.queryByText("Beta Traders")).toBeNull());
    expect(st.posts).toEqual([]);
  });
});
