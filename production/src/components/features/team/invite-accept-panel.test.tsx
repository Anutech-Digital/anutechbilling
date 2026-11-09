// @vitest-environment jsdom
/**
 * R-2517: the /invites/accept#token=… page. Pinned: a bad token never calls the server; signed out
 * → Sign in that comes back to /invites/accept (no token in that URL); open → "Accept and join" posts the token and then offers
 * "Switch to <company> now"; an accept that made it the selected company loads the app fresh;
 * other_login / used / expired / not_found show the reason with NO Accept button; a refusal is shown
 * in the server's words; two-step pending → link to /mfa.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const TOKEN = "Abc_def-ghiJKLmnopQRstuVWXyz0123456789abcde";

const st = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: unknown }>,
  answers: {} as Record<string, { status: number; body: unknown }>,
  went: [] as string[],
}));

import { InviteAcceptPanel, inviteAcceptNav } from "./invite-accept-panel";

function renderPanel(token = TOKEN) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><InviteAcceptPanel token={token} /></QueryClientProvider>);
}

const OPEN = { state: "open", companyName: "Excel Co", role: "sales", email: "ravi@x.test", signedInAs: "ravi@x.test" };

beforeEach(() => {
  st.calls = []; st.went = [];
  st.answers = {
    "/api/team/invites/lookup": { status: 200, body: OPEN },
    "/api/team/invites/accept": { status: 200, body: { ok: true, tenantId: "t2", companyName: "Excel Co", role: "sales", selected: false } },
    "/api/team/switch-company": { status: 200, body: { ok: true } },
  };
  window.sessionStorage.clear();
  window.sessionStorage.setItem("ros.invite-accept.token.v1", TOKEN);
  vi.spyOn(inviteAcceptNav, "go").mockImplementation((h: string) => { st.went.push(h); });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    st.calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const a = st.answers[url] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status });
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("InviteAcceptPanel (R-2517)", () => {
  it("a missing / malformed token says the link is incomplete and calls nothing", async () => {
    renderPanel("");
    expect(await screen.findByText("Link not complete")).toBeTruthy();
    cleanup();
    renderPanel("not a token");
    expect(await screen.findByText(/Open the link from the invite email again/)).toBeTruthy();
    expect(st.calls).toEqual([]);
  });

  it("signed out → Sign in that comes back to /invites/accept, never with the token in the URL", async () => {
    st.answers["/api/team/invites/lookup"] = { status: 401, body: { error: "Sign in first, then open the invite link again." } };
    renderPanel();
    const link = await screen.findByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe(`/login?next=${encodeURIComponent("/invites/accept")}`);
    expect(link.getAttribute("href")).not.toContain(TOKEN);
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
  });

  it("the middleware's two-step 401 is NOT treated as signed out → link to /mfa", async () => {
    st.answers["/api/team/invites/lookup"] = { status: 401, body: { error: "Enter the code from your authenticator app first. Open /mfa, type the 6-digit code, then try again." } };
    renderPanel();
    const link = await screen.findByRole("link", { name: "Open two-step sign-in" });
    expect(link.getAttribute("href")).toBe(`/mfa?next=${encodeURIComponent("/invites/accept")}`);
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("open → company + role; Accept posts the token, then offers Switch now", async () => {
    renderPanel();
    expect(await screen.findByRole("heading", { name: "Join Excel Co?" })).toBeTruthy();
    expect(st.calls[0]).toEqual({ url: "/api/team/invites/lookup", body: { token: TOKEN } });
    expect(document.body.textContent).toMatch(/invited you to join them as Sales/);
    fireEvent.click(screen.getByRole("button", { name: "Accept and join Excel Co" }));
    expect(await screen.findByRole("heading", { name: "Invite accepted" })).toBeTruthy();
    expect(st.calls[1]).toEqual({ url: "/api/team/invites/accept", body: { token: TOKEN } });
    expect(document.body.textContent).toMatch(/You joined Excel Co as Sales/);
    expect(window.sessionStorage.getItem("ros.invite-accept.token.v1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Excel Co now" }));
    await waitFor(() => expect(st.went).toHaveLength(1));
    expect(st.calls[2]).toEqual({ url: "/api/team/switch-company", body: { tenantId: "t2" } });
  });

  it("an accept that made it the selected company loads the app fresh", async () => {
    st.answers["/api/team/invites/accept"] = { status: 200, body: { ok: true, tenantId: "t2", companyName: "Excel Co", role: "sales", selected: true } };
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Accept and join Excel Co" }));
    await waitFor(() => expect(st.went).toHaveLength(1));
  });

  it("a refusal on Accept is shown in the server's words", async () => {
    st.answers["/api/team/invites/accept"] = { status: 403, body: { error: "This invite from Excel Co has expired. Ask them to invite you again." } };
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Accept and join Excel Co" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This invite from Excel Co has expired. Ask them to invite you again.");
  });

  it.each([
    ["blocked", "This invite cannot be accepted", /no longer an owner there/],
    ["other_login", "Signed in as someone else", /sent to ravi@x\.test, but you are signed in as boss@y\.test/],
    ["used", "Invite already used", /already used/],
    ["expired", "Invite expired", /has expired/],
    ["not_found", "Link not valid any more", /newer invite or withdrew it/],
  ])("%s → the reason, no Accept button", async (state, title, line) => {
    st.answers["/api/team/invites/lookup"] = { status: 200, body: { ...OPEN, state, signedInAs: "boss@y.test",
      reason: state === "blocked" ? "This invite from Excel Co is no longer valid (the person who sent it is no longer an owner there). Ask them to invite you again." : null } };
    renderPanel();
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect(document.body.textContent).toMatch(line);
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
  });

  it("two-step sign-in pending → the server's words and a link to /mfa", async () => {
    st.answers["/api/team/invites/lookup"] = { status: 403, body: { error: "Finish two-step sign-in first: type the 6-digit code from your authenticator app, then open the invite link again." } };
    renderPanel();
    const link = await screen.findByRole("link", { name: "Open two-step sign-in" });
    expect(link.getAttribute("href")).toMatch(/^\/mfa\?next=/);
  });
});
