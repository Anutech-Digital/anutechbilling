// @vitest-environment jsdom
/* R-2462 — Purchase Inbox "Add to expenses" books one order email ONCE.
   The hook no longer inserts the expense from the browser and then flips the row: it calls the
   atomic import_inbound_purchase RPC (lock + pending check + expense + imported, one transaction).
   A second click / a second person gets {already: true} → "Already added to expenses" with an
   "Open it" button to that expense. Ignore goes through set_inbound_purchase_status. */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), success: vi.fn(), info: vi.fn(), toastError: vi.fn() }));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: h.success, info: h.info, error: vi.fn() }) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: h.toastError }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: h.rpc, from: h.from, auth: { getUser: vi.fn() } }),
}));

import { useImportPurchase, useIgnorePurchase, expenseHref } from "@/lib/queries/inbound-purchases";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return Wrapper;
}

const row = { id: 7 } as const;

describe("R-2462 Add to expenses books once", () => {
  it("first click: one RPC call, no direct table write, success toast with Open it", async () => {
    h.rpc.mockResolvedValue({ data: { expense_id: "EXP-1", already: false }, error: null });
    const openHref = vi.fn();
    const { result } = renderHook(() => useImportPurchase({ openHref }), { wrapper: wrap() });
    await act(async () => { await result.current.mutateAsync(row); });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("import_inbound_purchase", { p_id: 7 });
    expect(h.from).not.toHaveBeenCalled();
    expect(h.success).toHaveBeenCalledTimes(1);
    expect(h.info).not.toHaveBeenCalled();
    const opts = h.success.mock.calls[0][1] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe("Open it");
    opts.action.onClick();
    expect(openHref).toHaveBeenCalledWith("/accounting/expenses?edit=EXP-1");
  });

  it("second click (already booked): says Already added to expenses and opens the SAME expense", async () => {
    h.rpc.mockResolvedValue({ data: { expense_id: "EXP-1", already: true }, error: null });
    const openHref = vi.fn();
    const { result } = renderHook(() => useImportPurchase({ openHref }), { wrapper: wrap() });
    let res: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => { res = await result.current.mutateAsync(row); });
    expect(res).toEqual({ expenseId: "EXP-1", already: true });
    expect(h.success).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledTimes(1);
    expect(h.info.mock.calls[0][0]).toBe("Already added to expenses");
    const opts = h.info.mock.calls[0][1] as { description: string; action: { label: string; onClick: () => void } };
    expect(opts.description).toMatch(/nothing new was booked/);
    opts.action.onClick();
    expect(openHref).toHaveBeenCalledWith(expenseHref("EXP-1"));
  });

  it("a refusal (e.g. sales role) goes to toastError with the server's message", async () => {
    const err = { message: "Only the owner, a manager or the accountant can add purchases to expenses — ask one of them.", code: "42501" };
    h.rpc.mockResolvedValue({ data: null, error: err });
    const { result } = renderHook(() => useImportPurchase(), { wrapper: wrap() });
    act(() => result.current.mutate(row));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(h.toastError).toHaveBeenCalledWith(err);
    expect(h.success).not.toHaveBeenCalled();
  });

  it("Ignore goes through set_inbound_purchase_status, not a table update", async () => {
    h.rpc.mockResolvedValue({ data: "ignored", error: null });
    const { result } = renderHook(() => useIgnorePurchase(), { wrapper: wrap() });
    await act(async () => { await result.current.mutateAsync(9); });
    expect(h.rpc).toHaveBeenCalledWith("set_inbound_purchase_status", { p_id: 9, p_status: "ignored" });
    expect(h.from).not.toHaveBeenCalled();
  });
});
