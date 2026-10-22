// @vitest-environment jsdom
/* R-1694 — "Preview · This is how the customer will see it" never showed the scan-to-pay UPI QR
   the PDF prints. The preview now asks /api/quotes/{id}/pay-qr (the PDF's own rule, quotePayQr)
   and shows the same block; with no UPI ID it tells the OWNER, in the preview chrome, where to
   add one — never inside the customer's document. */
import * as React from "react";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { QuotePreviewDialog } from "./quote-preview-dialog";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

let fetchMock: ReturnType<typeof vi.fn>;
function stubQr(qr: { dataUrl: string; vpa: string; amount: number } | null) {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ qr }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
}
beforeEach(() => stubQr(null));

function preview(props: Partial<React.ComponentProps<typeof QuotePreviewDialog>>) {
  render(
    <QuotePreviewDialog
      open onOpenChange={() => {}} tenantName="ANUTECH DIGITAL PVT LTD" quoteId="Q-ADPL-2026-27-0017" customerName="Test Co"
      lineItems={[]} subtotal={1000} discountPct={0} discount={0} taxable={1000} taxRate={18} tax={180} total={1180}
      interState={false} billingCycle="yearly" validityDays={7} notes="" {...props}
    />,
  );
}

describe("quote preview — scan-to-pay UPI QR (R-1694)", () => {
  it("UPI ID set and money due → the PDF's QR and the UPI ID show in the preview", async () => {
    stubQr({ dataUrl: "data:image/png;base64,QR", vpa: "anutech@okhdfcbank", amount: 1180 });
    preview({ upiVpa: "anutech@okhdfcbank", payQrQuoteId: "Q-ADPL-2026-27-0017" });
    const img = await screen.findByTestId("preview-upi-qr");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,QR");
    expect(screen.getByText("anutech@okhdfcbank")).toBeTruthy();
    expect(screen.getByText("Scan to pay this advance")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/quotes/Q-ADPL-2026-27-0017/pay-qr", expect.anything());
    expect(screen.queryByText(/Add your UPI ID in Settings to show a Pay QR/)).toBeNull();
  });

  it("no UPI ID → owner hint with a Settings link in the chrome, no QR, no fetch", async () => {
    preview({ upiVpa: null, payQrQuoteId: "Q-ADPL-2026-27-0017" });
    const hint = screen.getByTestId("preview-staff-hint-upi");
    expect(hint.textContent).toContain("Add your UPI ID in Settings to show a Pay QR");
    expect(hint.querySelector("a")?.getAttribute("href")).toMatch(/^\/settings/);
    expect(hint.closest("[data-testid='preview-document']")).toBeNull();
    expect(screen.queryByTestId("preview-upi-qr")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("paid or USD quote (server rule says no QR) → no QR, no hint — same as the PDF", async () => {
    stubQr(null);
    preview({ upiVpa: "anutech@okhdfcbank", payQrQuoteId: "Q-ADPL-2026-27-0017" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("preview-upi-qr")).toBeNull();
    expect(screen.queryByText(/Add your UPI ID in Settings to show a Pay QR/)).toBeNull();
  });

  it("USD quote with no UPI ID → no 'add UPI' hint (UPI can't collect dollars anyway)", () => {
    preview({ upiVpa: null, payQrQuoteId: "Q-1", currency: "USD", exchangeRate: 90 });
    expect(screen.queryByTestId("preview-staff-hint-upi")).toBeNull();
  });

  it("unsaved quote (builder) → no fetch; chrome says the QR comes after saving", () => {
    preview({ upiVpa: "anutech@okhdfcbank", payQrQuoteId: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("preview-staff-hint-unsaved").textContent).toMatch(/save/i);
  });
});
