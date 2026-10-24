// @vitest-environment jsdom
/**
 * R-1749 — Settings → Integrations → Zoho Books card, one state at a time:
 * not set up on this server, not connected, connected without an organization (picker with the
 * only organization pre-selected), connected (Preview from Zoho shows counts), and a role that
 * cannot connect. Server answers are faked; Zoho is never called.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true, useAskText: () => async () => "T-reason" }));

import ZohoBooksCard from "./zoho-books-card";

let status: Record<string, unknown>;
let posts: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  posts = [];
  toastMock.mockReset(); toastMock.success.mockReset(); toastMock.error.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (init?.method === "POST" || init?.method === "DELETE") {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/preview")) {
        return j({ ok: true, preview: { contacts: 237, invoices: 1450, openInvoices: 38, withSubsPeriod: 912, withServiceExpiry: 640, capped: false } });
      }
      if (url.endsWith("/organizations")) return j({ ok: true, org_name: "Acme Traders Pvt Ltd" });
      return j({ ok: true, revoked: true });
    }
    if (url.endsWith("/organizations")) return j({ ok: true, organizations: [{ id: "60001", name: "Acme Traders Pvt Ltd" }] });
    return j(status);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ZohoBooksCard /></QueryClientProvider>);
}

describe("Zoho Books card", () => {
  it("server without Zoho app settings: says so, and the button starts nothing", async () => {
    status = { configured: false, connected: false, needs_org: false, org_name: null, can_manage: true, message: "Zoho Books is not set up on this server" };
    show();
    expect(await screen.findByText("Zoho Books is not set up on this server")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Connect Zoho Books" });
    fireEvent.click(btn);
    expect(toastMock).toHaveBeenCalledWith("Zoho Books is not set up on this server");
    expect(screen.queryByRole("link", { name: "Connect Zoho Books" })).toBeNull();
  });

  it("not connected: Connect Zoho Books goes to the server's connect route", async () => {
    status = { configured: true, connected: false, needs_org: false, org_name: null, can_manage: true };
    show();
    const link = await screen.findByRole("link", { name: "Connect Zoho Books" });
    expect(link.getAttribute("href")).toBe("/api/integrations/zoho-books/connect");
  });

  it("connected without an organization: the only organization is pre-selected", async () => {
    status = { configured: true, connected: true, needs_org: true, org_name: null, can_manage: true };
    show();
    const select = await screen.findByLabelText("Zoho Books organization") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("60001"));
    fireEvent.click(screen.getByRole("button", { name: "Use this organization" }));
    await waitFor(() => expect(posts[0]).toEqual({ url: "/api/integrations/zoho-books/organizations", body: { organization_id: "60001" } }));
  });

  it("connected: shows the organization, and Preview from Zoho shows counts only", async () => {
    status = { configured: true, connected: true, needs_org: false, org_name: "Acme Traders Pvt Ltd", can_manage: true };
    show();
    expect(await screen.findByText("Connected: Acme Traders Pvt Ltd")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview from Zoho" }));
    expect(await screen.findByText("1,450")).toBeTruthy();
    expect(screen.getByText("Open invoices (balance due)")).toBeTruthy();
    expect(screen.getByText("912")).toBeTruthy();
    expect(screen.getByText(/Nothing has been imported/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    // R-1753: the next step is the import
    expect(screen.getByRole("button", { name: "Import from Zoho" })).toBeTruthy();
  });

  it("a billing user is told who can connect, with no buttons", async () => {
    status = { configured: true, connected: false, needs_org: false, org_name: null, can_manage: false };
    show();
    expect(await screen.findByText(/only an owner, manager or accountant can connect Zoho Books/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Connect Zoho Books" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });
});
