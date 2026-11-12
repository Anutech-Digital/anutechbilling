// @vitest-environment jsdom
/* R-2685 — "Reconcile from Zoho": Pause took ~1 min on staging (it was only seen after a 65 s "Zoho busy"
   wait or a pacing wait ran out). Pause now wakes that wait: the sheet shows Paused and Continue at once. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const none = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock("@/lib/queries/customers", async (orig) => ({ ...(await orig<object>()), useCustomers: () => none, useCreateCustomer: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/subscriptions", async (orig) => ({ ...(await orig<object>()), useSubscriptions: () => none }));
vi.mock("@/lib/queries/items", async (orig) => ({ ...(await orig<object>()), useItems: () => none }));
vi.mock("@/lib/queries/customer-payers", async (orig) => ({ ...(await orig<object>()), usePayerMemory: () => ({ payers: [], ownNames: [] }) }));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: null }) }));
vi.mock("@/lib/queries/tenant-luts", () => ({ useTenantLuts: () => ({ data: [], isError: false }) }));

import { ZohoBulkReconcile } from "./zoho-bulk-reconcile";

const ids = Array.from({ length: 16 }, (_, i) => `txn-${i}`);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe("R-2685 Reconcile from Zoho — Pause answers at once", () => {
  it("Zoho busy → a 65 s wait; Pause during it shows Continue right away, and no more lines are asked", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { txnIds?: string[] };
      calls.push(body);
      const json = body.txnIds ? { ok: true, rows: [], skipped: [], zohoCalls: 3, stopped: true } : { ok: true, ids };
      return { status: 200, json: async () => json } as unknown as Response;
    }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ZohoBulkReconcile accountId="acct-1" accountName="HDFC 4523" open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    act(() => { screen.getByRole("button", { name: "Start" }).click(); });
    await screen.findByText(/Zoho is busy|waiting/i);   // in the 65 s busy wait
    const asked = calls.length;
    const t0 = Date.now();
    act(() => { screen.getByRole("button", { name: "Pause" }).click(); });
    await waitFor(() => expect((screen.getByRole("button", { name: /^Continue \(16 left\)$/ }) as HTMLButtonElement).disabled).toBe(false), { timeout: 1000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(calls.length).toBe(asked);   // the paused read asked Zoho nothing more
  });
});
