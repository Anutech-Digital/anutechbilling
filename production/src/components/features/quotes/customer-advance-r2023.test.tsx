// @vitest-environment jsdom
/* R-2023 — a customer advance (R-1863 holder quote) reads as "Customer advance · ₹X available",
   never as a sale with "Generate GST Invoice"; and Record payment's "Use advance" can pay a bill
   in full with ₹0 cash, or use only part of the advance. Owner's example: LINKS INFOTECH ₹47,348. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const creditRows = vi.fn();
vi.mock("@/lib/queries/customer-advances", () => ({
  useCustomerCreditRows: () => creditRows(),
}));

import { UseAdvanceBox, recordPaymentSchema } from "./record-payment-dialog";
import { CustomerAdvanceView } from "./customer-advance-view";

afterEach(cleanup);

const ADV_PAYMENT = {
  id: "p-adv", status: "received", amount: 47348, received_at: "2026-10-23T00:00:00Z",
  receipt_voucher_no: "RV-A378-27-0005", reference: "UTR123456789012", quote_id: "Q-A378-27-0019",
} as never;

describe("R-2023 — the advance's own page", () => {
  it("says 'Customer advance · ₹47,348 available', shows the RV, and has no invoice button", () => {
    creditRows.mockReturnValue({ isLoading: false, data: [
      { id: "c1", amount: 47348, status: "open", source_payment_id: "p-adv", source_quote_id: "Q-A378-27-0019" },
    ] });
    const onOpen = vi.fn();
    render(
      <CustomerAdvanceView
        quote={{ id: "Q-A378-27-0019", customer_id: "cust-1", customer_name: "LINKS INFOTECH", payment_amount: 47348 }}
        payments={[ADV_PAYMENT]}
        onOpenReceipt={onOpen}
      />,
    );
    expect(screen.getByTestId("advance-status").textContent).toBe("Customer advance · ₹47,348 available");
    expect(document.body.textContent).not.toMatch(/Generate GST Invoice|Raise the GST invoice|Provisioned|Accepted/i);
    fireEvent.click(screen.getByRole("button", { name: "RV-A378-27-0005" }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("after part is used: available drops, used shows", () => {
    creditRows.mockReturnValue({ isLoading: false, data: [
      { id: "c1", amount: 40000, status: "open", source_payment_id: "p-adv" },
      { id: "c2", amount: 7348, status: "used", source_payment_id: "p-adv" },
    ] });
    render(<CustomerAdvanceView quote={{ id: "Q", customer_id: "c", customer_name: "L" }} payments={[ADV_PAYMENT]} />);
    expect(screen.getByTestId("advance-available").textContent).toBe("₹40,000");
    expect(screen.getByTestId("advance-status").textContent).toBe("Customer advance · ₹40,000 available");
  });

  it("the quote page shows this view for an advance, before the stepper / Generate button", () => {
    const src = readFileSync(join(__dirname, "../../../app/(app)/quotes/[id]/page.tsx"), "utf8");
    const viewAt = src.indexOf("isCustomerAdvanceQuote(quote)");
    expect(viewAt).toBeGreaterThan(0);
    expect(viewAt).toBeLessThan(src.indexOf("<LifecycleStepper steps="));
    expect(viewAt).toBeLessThan(src.indexOf('"Generate GST Invoice"}'));
  });
});

describe("R-2023 — Payments Received", () => {
  it("an advance has its own Advance view + tag and is not in 'GST invoice not generated'", () => {
    const src = readFileSync(join(__dirname, "../../../app/(app)/payments/page.tsx"), "utf8");
    expect(src).toContain(`awaitingInvoiceQuotes = scoped.quotes.filter((q) => q.payment_status === "received" && !isCustomerAdvanceQuote(q))`);
    expect(src).toContain(`if (view === "subscription" && isAdvancePay(p)) return false;`);
    expect(src).toContain(`id: "advance", label: "Advance"`);
    expect(src).toContain(`data-testid="advance-tag">Advance<`);
  });
});

describe("R-2023 — Record payment: Use advance", () => {
  it("is labelled 'Use advance — ₹X available' and lets a part be used", () => {
    const onAmount = vi.fn();
    render(<UseAdvanceBox available={47348} checked applied={5900} onCheckedChange={() => {}} onAmountChange={onAmount} />);
    expect(screen.getByText("Use advance — ₹47,348 available")).toBeTruthy();
    expect(screen.getByText("₹41,448 stays as advance")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Advance to use (₹)"), { target: { value: "2000" } });
    expect(onAmount).toHaveBeenCalledWith(2000);
  });

  it("₹0 cash is allowed when the advance pays the bill (was refused 'Amount must be more than ₹0')", () => {
    const base = { amount: 0, method: "bank_transfer", reference: "", receivedDate: "2026-10-27" };
    expect(recordPaymentSchema.safeParse({ ...base, creditApplied: 5900 }).success).toBe(true);
    const r = recordPaymentSchema.safeParse({ ...base, creditApplied: 0 });
    expect(r.success).toBe(false);
  });
});
