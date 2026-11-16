// @vitest-environment jsdom
/* R-2846 — Record payment on a part payment request.
   R-2865 (owner, 16 Nov): a renewal part is NOT an advance — the sheet says "Payment for …" / "Amount due"
   under the usual title; an old stored line ("Advance payment for …") is still read for its month · period.
   Owner, 15 Nov (Q-F588-27-0059): the proforma reads "Renewal · Part 1 of 1 · Oct 2026" with the
   line "Advance payment for month 1 · 1 Oct–31 Oct 2026", but Record payment said "Log a payment
   against quote … Quote total / Expected this payment" — nothing said it is the ADVANCE for that
   month, or that the tax invoice is raised on confirm. Wording only: amounts are unchanged. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { PaymentSummaryRows, RecordPaymentSubtext, recordPaymentTitle } from "./record-payment-dialog";
import { partAdvanceOf, partAdvanceText } from "@/lib/billing/part-requests";

afterEach(cleanup);

const OWNER_LINE = "Advance payment for month 1 · 1 Oct–31 Oct 2026";
const INVOICE_ON_CONFIRM = "The tax invoice is raised when you confirm the full payment.";

describe("R-2846 partAdvanceOf — what the advance is for", () => {
  it("owner's request: month 1 · period, Part 1 of 1, the subscription", () => {
    const adv = partAdvanceOf({ lines: [{ name: OWNER_LINE }], partShort: "Part 1 of 1", subscription: "Google Workspace Business Starter · greentin.in" });
    expect(adv).toEqual({ what: "month 1 · 1 Oct–31 Oct 2026", part: "Part 1 of 1", subscription: "Google Workspace Business Starter · greentin.in" });
    expect(partAdvanceText(adv, "Greentin Check 2095")).toBe(
      `Payment for month 1 · 1 Oct–31 Oct 2026 of Google Workspace Business Starter · greentin.in (Part 1 of 1) from Greentin Check 2095. ${INVOICE_ON_CONFIRM}`,
    );
  });

  it("newer line style (… (part 1 of 12)) → the line's own period", () => {
    const adv = partAdvanceOf({
      lines: [{ name: "Google Workspace · acme.in · 10 seats · 1 Nov–30 Nov 2026 (part 1 of 12)", period_start: "2026-11-01", period_end: "2026-11-30" }],
      partShort: "Part 1 of 12", subscription: null,
    });
    expect(adv.what).toBe("1 Nov–30 Nov 2026");
    expect(partAdvanceText(adv, "Acme")).toBe(`Payment for 1 Nov–30 Nov 2026 (Part 1 of 12) from Acme. ${INVOICE_ON_CONFIRM}`);
  });

  it("a request billing several subscriptions together: the group label from the description, no one subscription named", () => {
    const adv = partAdvanceOf({
      lines: [
        { name: "Google Workspace · acme.in · 1 Nov–30 Nov 2026", description: "Advance payment for Q2 · 1 Nov 2026–31 Jan 2027", period_start: "2026-11-01", period_end: "2026-11-30" },
        { name: "Microsoft 365 · acme.in · 1 Nov–30 Nov 2026" },
      ],
      partShort: "Part 2 of 4", subscription: "Google Workspace · acme.in",
    });
    expect(adv).toEqual({ what: "Q2 · 1 Nov 2026–31 Jan 2027", part: "Part 2 of 4", subscription: null });
  });

  it("nothing known about the period → 'this part', facts not invented", () => {
    const adv = partAdvanceOf({ lines: [{ name: "Something else" }], partShort: null, subscription: null });
    expect(partAdvanceText(adv, "Acme")).toBe(`Payment for this part from Acme. ${INVOICE_ON_CONFIRM}`);
  });
});

describe("R-2846 Record payment sheet wording", () => {
  const adv = partAdvanceOf({ lines: [{ name: OWNER_LINE }], partShort: "Part 1 of 1", subscription: "Google Workspace Business Starter" });

  it("title: the same on a part request as on any quote — never 'advance' (R-2865)", () => {
    expect(recordPaymentTitle(false)).toBe("Record payment received");
    expect(recordPaymentTitle(true)).toBe("Record additional payment");
    const src = readFileSync(join(__dirname, "record-payment-dialog.tsx"), "utf8");
    expect(src).not.toMatch(/Record advance payment|Record rest of advance|"Advance due"/);
  });

  it("subtext on a part request says month · period, part, customer and the invoice on confirm", () => {
    render(<RecordPaymentSubtext advance={adv} quoteId="Q-F588-27-0059" customerName="Greentin Check 2095" hasPriorPayments={false} />);
    expect(screen.getByText(/Payment for month 1 · 1 Oct–31 Oct 2026 of Google Workspace Business Starter \(Part 1 of 1\) from Greentin Check 2095\./)).toBeTruthy();
    expect(screen.getByText(/The tax invoice is raised when you confirm the full payment\./)).toBeTruthy();
    expect(screen.queryByText(/advance/i)).toBeNull();
    expect(screen.queryByText(/Log a payment against quote/)).toBeNull();
  });

  it("subtext on a normal quote is unchanged", () => {
    const { container } = render(<RecordPaymentSubtext advance={null} quoteId="Q-1" customerName="Acme" hasPriorPayments={false} />);
    expect(container.textContent).toBe("Log a payment against quote Q-1 from Acme. You can record more payments later if it's paid in installments.");
  });

  it("totals on a part request: one 'Amount due' row (no 'Quote total' / 'Expected this payment' / 'Advance')", () => {
    const { container } = render(<PaymentSummaryRows split={null} expectedAmount={3835} alreadyReceived={0} remaining={3835} advance />);
    expect(screen.getByText("Amount due")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Quote total|Expected this payment|[Aa]dvance/);
    expect(container.textContent).toContain("3,835");
  });

  it("totals on a part-paid request: Amount due / Already received / Remaining", () => {
    const { container } = render(<PaymentSummaryRows split={null} expectedAmount={3835} alreadyReceived={1000} remaining={2835} advance />);
    expect(screen.getByText("Amount due")).toBeTruthy();
    expect(container.textContent).not.toMatch(/[Aa]dvance/);
    expect(screen.getByText("Already received")).toBeTruthy();
    expect(screen.getByText("Remaining")).toBeTruthy();
    expect(container.textContent).toContain("2,835");
  });

  it("totals on a normal quote are unchanged", () => {
    render(<PaymentSummaryRows split={null} expectedAmount={5000} alreadyReceived={0} remaining={5000} advance={false} />);
    expect(screen.getByText("Quote total")).toBeTruthy();
    expect(screen.getByText("Expected this payment")).toBeTruthy();
    expect(screen.queryByText("Amount due")).toBeNull();
  });

  it("the quote page passes the advance only for an uninvoiced part request, with the header stamp's part", () => {
    const page = readFileSync(join(__dirname, "../../../app/(app)/quotes/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/partAdvance=\{partRequest && !quote\.invoice_id \?/);
    expect(page).toContain("kindStamp?.partShort");
  });
});
