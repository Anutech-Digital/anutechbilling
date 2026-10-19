// @vitest-environment jsdom
/* R-1681 — pausing a subscription by hand asks why, and "unpaid invoice" ties the pause to the
   invoice so paying it turns the service back on (suspend_subscription RPC). */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const rpc = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn(), info: vi.fn() } }));

import { SuspendSubscriptionDialog, suspendToast, type SuspendResult } from "./suspend-subscription-dialog";

const SUB = { id: "sub-18", customer_name: "T-18", plan: "Business Starter", outstanding_amount: 3823 };

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SuspendSubscriptionDialog sub={SUB} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

beforeEach(() => { rpc.mockReset(); toastSuccess.mockReset(); });
afterEach(cleanup);

describe("R-1681 SuspendSubscriptionDialog", () => {
  it("Pause waits for a reason — nothing is sent without one", async () => {
    renderDialog();
    const pause = screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
    expect(screen.getByText(/Write a few words to enable Pause/)).toBeTruthy();
    fireEvent.click(pause);
    await new Promise((r) => setTimeout(r, 20));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends the reason and 'for unpaid invoice' (ticked by default) to suspend_subscription", async () => {
    const result: SuspendResult = {
      subscription_id: "sub-18", status: "paused", reason: "INV unpaid 34 days",
      invoice_id: "INV-5F40-27-0080", invoice_due: 3823, resume_when_paid: true,
    };
    rpc.mockResolvedValue({ data: result, error: null });
    const onOpenChange = renderDialog();
    fireEvent.change(document.getElementById("suspend-sub-reason")!, { target: { value: "  INV unpaid 34 days " } });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc.mock.calls[0]).toEqual(["suspend_subscription", {
      p_subscription_id: "sub-18", p_reason: "INV unpaid 34 days", p_for_unpaid: true,
    }]);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastSuccess.mock.calls[0][0]).toBe("Paused until INV-5F40-27-0080 is paid");
  });

  it("unticking 'unpaid invoice' pauses with the reason only", async () => {
    rpc.mockResolvedValue({ data: { subscription_id: "sub-18", status: "paused", reason: "Customer asked", invoice_id: null, invoice_due: null, resume_when_paid: false }, error: null });
    renderDialog();
    fireEvent.change(document.getElementById("suspend-sub-reason")!, { target: { value: "Customer asked" } });
    fireEvent.click(document.getElementById("suspend-sub-for-unpaid")!);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_for_unpaid: false });
  });
});

describe("R-1681 suspendToast", () => {
  it("says it comes back by itself only when tied to the invoice", () => {
    const tied = suspendToast({ subscription_id: "s", status: "paused", reason: "x", invoice_id: "INV-1", invoice_due: 3823, resume_when_paid: true });
    expect(tied.title).toBe("Paused until INV-1 is paid");
    expect(tied.description).toMatch(/INV-1 \(₹3,823 due\) is paid it turns back on by itself/);
    expect(tied.description).toMatch(/Google \/ Microsoft admin/);
    const plain = suspendToast({ subscription_id: "s", status: "paused", reason: "x", invoice_id: null, invoice_due: null, resume_when_paid: false });
    expect(plain.title).toBe("Subscription paused");
    expect(plain.description).toMatch(/stays paused until someone resumes it/);
  });
});
