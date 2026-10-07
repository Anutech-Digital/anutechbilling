// @vitest-environment jsdom
/**
 * R-327 — ApiKeysCard scopes on screen.
 * Pinned: each key lists its scopes; a new key can be made with Telecalling ticked (POST
 * carries scopes); the owner can change an existing key's scopes (PATCH); a non-owner sees
 * no create form and no Scopes/Revoke buttons.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const me = vi.hoisted(() => ({ role: "owner" as string }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { role: me.role } }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));

import ApiKeysCard from "./api-keys-card";

const KEYS = [
  { id: "K1", label: "DSP", key_prefix: "rsk_live_ab", scopes: ["read"], last_used_at: null, revoked_at: null, created_at: "2026-10-01T00:00:00Z" },
];

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  me.role = "owner";
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = method === "GET" ? KEYS : method === "POST" ? { id: "K2", key: "rsk_live_secret" } : { ok: true };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderCard = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ApiKeysCard />
    </QueryClientProvider>,
  );

describe("ApiKeysCard scopes (R-327)", () => {
  it("shows each key's scopes", async () => {
    renderCard();
    const list = await screen.findByRole("list", { name: "Scopes of DSP" });
    expect(list.textContent).toBe("Read");
  });

  it("creates a key with Telecalling ticked → POST carries both scopes", async () => {
    renderCard();
    await screen.findByText("DSP");
    fireEvent.click(screen.getByRole("checkbox", { name: /Telecalling/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create key/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ label: "", scopes: ["read", "telecalling"] });
  });

  it("Create is disabled when no scope is ticked", async () => {
    renderCard();
    await screen.findByText("DSP");
    fireEvent.click(screen.getByRole("checkbox", { name: /^Read/ }));
    expect((screen.getByRole("button", { name: /Create key/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Pick at least one scope.")).toBeTruthy();
  });

  it("owner changes an existing key's scopes → PATCH", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Change scopes of DSP" }));
    const boxes = screen.getAllByRole("checkbox", { name: /Telecalling/ });
    fireEvent.click(boxes[boxes.length - 1]);
    fireEvent.click(screen.getByRole("button", { name: /Save scopes/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const p = calls.find((c) => c.method === "PATCH")!;
    expect(p.url).toBe("/api/settings/api-keys/K1");
    expect(p.body).toEqual({ scopes: ["read", "telecalling"] });
  });

  it("non-owner: no create form, no Scopes or Revoke button", async () => {
    me.role = "manager";
    renderCard();
    await screen.findByText("DSP");
    expect(screen.queryByRole("button", { name: /Create key/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Change scopes/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
  });
});
