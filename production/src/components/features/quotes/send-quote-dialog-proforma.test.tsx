// @vitest-environment jsdom
/* R-1523 — Send dialog: Quotation / Proforma Invoice choice goes to the send call, and a clear
   §24 line when the PDF will have no pay QR (no UPI ID, or a non-INR quote). */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const sendSpy = vi.fn();
vi.mock("@/lib/quotes/send-quote-email", async (orig) => {
  const real = await orig<typeof import("@/lib/quotes/send-quote-email")>();
  return {
    ...real,
    sendQuoteEmail: (...a: unknown[]) => {
      sendSpy(...a);
      return Promise.resolve({ status: "stubbed", email_mode: "stub", providerId: null, errorMessage: null, recipient: "a@b.in", attachedPdf: true, quoteStatus: "sent" });
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SendQuoteDialog } from "./send-quote-dialog";

afterEach(() => { cleanup(); sendSpy.mockReset(); });

function show(props: Partial<React.ComponentProps<typeof SendQuoteDialog>> = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <SendQuoteDialog open onOpenChange={() => {}} quoteId="Q-1" customerName="Acme" defaultRecipient="a@b.in" {...props} />
    </QueryClientProvider>,
  );
}

describe("SendQuoteDialog — R-1523", () => {
  it("no UPI ID → 'Add your UPI ID in Settings to show a Pay QR' + Settings button", () => {
    show({ upiVpa: null, currency: "INR" });
    expect(screen.getByText(/Add your UPI ID in Settings to show a Pay QR/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Settings/ });
    expect(link.getAttribute("href")).toBe("/settings?tab=company#payment-details");
  });

  it("non-INR quote → 'UPI works only for INR quotes'", () => {
    show({ upiVpa: "demo@okhdfcbank", currency: "USD" });
    expect(screen.getByText(/UPI works only for INR quotes/)).toBeTruthy();
  });

  it("UPI set on an INR quote → no message", () => {
    show({ upiVpa: "demo@okhdfcbank", currency: "INR" });
    expect(screen.queryByText(/Pay QR ke liye/)).toBeNull();
  });

  it("Proforma Invoice choose karke bhejo → template 'proforma' send call me", async () => {
    show({ upiVpa: "demo@okhdfcbank", currency: "INR" });
    fireEvent.click(screen.getByRole("radio", { name: /Proforma Invoice/ }));
    fireEvent.click(screen.getByRole("button", { name: /Send now/ }));
    await waitFor(() => expect(sendSpy).toHaveBeenCalled());
    expect(sendSpy.mock.calls[0][1]).toMatchObject({ template: "proforma" });
  });

  it("default Quotation → template 'quotation'", async () => {
    show({ upiVpa: "demo@okhdfcbank", currency: "INR" });
    fireEvent.click(screen.getByRole("button", { name: /Send now/ }));
    await waitFor(() => expect(sendSpy).toHaveBeenCalled());
    expect(sendSpy.mock.calls[0][1]).toMatchObject({ template: "quotation" });
  });
});
