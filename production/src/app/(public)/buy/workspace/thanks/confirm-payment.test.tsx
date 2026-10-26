// @vitest-environment jsdom
/**
 * R-1625 (24 Oct 2026): after a Workspace payment our server never confirmed it — Razorpay's
 * handler only redirected, the webhook did all the work, and until it landed the thanks page
 * said "Order not found" to a buyer who had just paid.
 *
 * Pinned: the buy page keeps Razorpay's answer for THIS order; the thanks page asks
 * /api/public/checkout/verify (the R-1596 path, idempotent with the webhook — see
 * lib/checkout/verify-payment.test.ts "verify twice records once" / "webhook after verify is a
 * no-op") with a BusyPanel while it waits; "paid" reloads into the order; a failure, a refusal
 * or a payment still completing says so honestly with a support next step; and a page with no
 * kept payment still shows the plain not-found card (a guessed number learns nothing).
 * Razorpay is never called — fetch is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ThanksClient } from "./thanks-client";
import {
  CONFIRM_EVERY_MS, CONFIRM_TRIES, WORKSPACE_PAYMENT_KEY, confirmView, pageReload, readWorkspacePayment, saveWorkspacePayment,
} from "./payment-handoff";

const Q = "Q-ADPL-27-0050";
const PAY = { orderId: "order_Abc123", paymentId: "pay_Xyz789", signature: "deadbeef" };

type Answer = { state: string; message?: string; quoteId?: string };
let answers: Answer[] = [];
const fetchMock = vi.fn(async () => {
  const a = answers.length > 1 ? answers.shift()! : answers[0];
  return { json: async () => a } as Response;
});
const reload = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  answers = [];
  fetchMock.mockClear();
  reload.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  pageReload.run = reload;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("the thanks page confirms the payment on our server (R-1625)", () => {
  it("a kept payment → BusyPanel 'Confirming your payment', never 'Order not found', then reload on paid", async () => {
    saveWorkspacePayment(Q, PAY);
    answers = [{ state: "confirming", message: "Razorpay is completing it." }, { state: "paid", quoteId: Q, message: "Payment received" }];
    render(<ThanksClient order={null} isSimulation={false} orderRef={Q} />);
    await flush();
    expect(screen.getAllByText(/Confirming your payment/).length).toBeGreaterThan(0);
    expect(document.querySelector("[data-busy-panel], [role=status]")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/Order not found/);
    // It asked OUR server with the three ids — nothing else.
    expect(fetchMock).toHaveBeenCalledWith("/api/public/checkout/verify", expect.objectContaining({ method: "POST" }));
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(firstCall[1].body))).toEqual(PAY);
    expect(reload).not.toHaveBeenCalled();
    await flush(CONFIRM_EVERY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readWorkspacePayment(Q)?.state).toBe("paid");
  });

  it("after the reload, if the order still did not load, it says paid + Reload — no loop, no second ask", async () => {
    saveWorkspacePayment(Q, { ...PAY, state: "paid" });
    render(<ThanksClient order={null} isSimulation={false} orderRef={Q} />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading").textContent).toBe("Payment received");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Order not found/);
  });

  it("Razorpay says failed → an honest failure with Try again and a support link, never 'nothing was charged'", async () => {
    saveWorkspacePayment(Q, PAY);
    answers = [{ state: "failed", quoteId: Q, message: "Razorpay says this payment didn't go through. If money left your account, your bank refunds it automatically." }];
    const { container } = render(<ThanksClient order={null} isSimulation={false} orderRef={Q} />);
    await flush();
    expect(screen.getByRole("heading").textContent).toBe("Your payment didn't go through");
    expect(container.textContent).toMatch(/bank refunds it automatically/);
    expect(container.textContent).not.toMatch(/nothing was charged|no money was taken/i);
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/buy/workspace");
    expect([...container.querySelectorAll("a")].some((a) => /^mailto:|^https:\/\/wa\.me\//.test(a.getAttribute("href") ?? ""))).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("refused → 'We couldn't confirm this payment', don't pay again, support link", async () => {
    saveWorkspacePayment(Q, PAY);
    answers = [{ state: "refused", message: "This payment confirmation didn't check out. Please don't pay again — email support with your order number and we'll finish it for you." }];
    const { container } = render(<ThanksClient order={null} isSimulation={false} orderRef={Q} />);
    await flush();
    expect(screen.getByRole("heading").textContent).toBe("We couldn't confirm this payment");
    expect(container.textContent).toMatch(/don't pay again/);
    expect([...container.querySelectorAll("a")].some((a) => (a.getAttribute("href") ?? "").includes(encodeURIComponent(Q)))).toBe(true);
  });

  it("still completing after every try → 'still being confirmed', don't pay again, Check again asks once more", async () => {
    saveWorkspacePayment(Q, PAY);
    answers = [{ state: "confirming", message: "Your bank has approved the payment and Razorpay is completing it." }];
    const { container } = render(<ThanksClient order={null} isSimulation={false} orderRef={Q} />);
    await flush();
    await flush(CONFIRM_EVERY_MS * CONFIRM_TRIES);
    expect(fetchMock).toHaveBeenCalledTimes(CONFIRM_TRIES);
    expect(screen.getByRole("heading").textContent).toBe("Your payment is still being confirmed");
    expect(container.textContent).toMatch(/Please don't pay again/);
    expect(container.textContent).not.toMatch(/Order not found/);
    await act(async () => { screen.getByRole("button", { name: "Check again" }).click(); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(CONFIRM_TRIES + 1);
  });

  it("a network failure is 'still confirming', not a failure (confirmPayment never throws)", async () => {
    saveWorkspacePayment(Q, PAY);
    fetchMock.mockImplementation(async () => { throw new Error("offline"); });
    render(<ThanksClient order={null} isSimulation={false} orderRef={Q} />);
    await flush(CONFIRM_EVERY_MS * CONFIRM_TRIES);
    expect(screen.getByRole("heading").textContent).toBe("Your payment is still being confirmed");
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => {
      const a = answers.length > 1 ? answers.shift()! : answers[0];
      return { json: async () => a } as Response;
    });
  });

  it("no kept payment, or one for ANOTHER order → the plain not-found card, and the server is not asked", async () => {
    render(<ThanksClient order={null} isSimulation={false} orderRef={Q} />);
    await flush();
    expect(screen.getByRole("heading").textContent).toBe("Order not found");
    cleanup();
    saveWorkspacePayment("Q-ADPL-27-0099", PAY);
    render(<ThanksClient order={null} isSimulation={false} orderRef={Q} />);
    await flush();
    expect(screen.getByRole("heading").textContent).toBe("Order not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a 'paid' answer naming another quote is not this order's confirmation", () => {
    expect(confirmView("paid", false, "Q-OTHER-27-0001", Q)).toBe("refused");
    expect(confirmView("paid", false, Q, Q)).toBe("paid");
    expect(confirmView("paid", true, Q, Q)).toBe("checking");
    expect(confirmView(null, false, undefined, Q)).toBe("checking");
    expect(confirmView("confirming", false, Q, Q)).toBe("still-confirming");
  });

  it("its own storage key — never the cart checkout's, so /done and this page can't pick up each other's payment", () => {
    expect(WORKSPACE_PAYMENT_KEY).not.toBe("anutech.payment");
  });
});

describe("the buy page hands the payment over (R-1625)", () => {
  /* R-1971: the buy page's checkout is inline now — the submit logic lives in _parts/submit-order.ts. */
  const src = readFileSync(join(process.cwd(), "src/app/(public)/buy/workspace/_parts/submit-order.ts"), "utf8");
  it("Razorpay's success handler keeps {order, payment, signature} for this quote before redirecting", () => {
    expect(src).toMatch(/handler: \(resp\) => \{\s*(?:\/\/.*\s*)*saveWorkspacePayment\(json\.quoteId, fromRazorpayHandler\(resp\)\);\s*window\.location\.href = thanksUrl\(json\.quoteId, json\.publicToken, false\);/);
  });
  it("the workspace order is findable by the verify path: payment_reference = the Razorpay order id", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/public/checkout/workspace/route.ts"), "utf8");
    expect(route).toMatch(/\.update\(\{ payment_reference: order\.id \}\)/);
    expect(route).toMatch(/amount:\s+amount \* 100/);
  });
});
