// @vitest-environment jsdom
/* R-1520 — Record payment: a short payment whose gap is exactly a common TDS gets a hint
   with one button that fills the TDS fields. It never ticks the box by itself.
   Also: a TDS-only receipt (bank ₹0, TDS settles the rest) is allowed ONLY with TDS ticked. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, renderHook, act } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import {
  TdsShortfallHint,
  applyTdsSuggestion,
  recordPaymentSchema,
  type RecordPaymentFormData,
} from "./record-payment-dialog";
import { matchTdsShortfall } from "@/lib/accounting/tds-match";

afterEach(cleanup);

function setupSheetForm(values: Partial<RecordPaymentFormData>) {
  return renderHook(function useSheet() {
    const form = useForm<RecordPaymentFormData>({
      resolver: zodResolver(recordPaymentSchema),
      defaultValues: {
        amount: 275_400, method: "bank_transfer", reference: "UTR402312345678", receivedDate: "2026-10-17",
        tdsDeducted: false, tdsSection: "194C", tdsRatePct: 1, ...values,
      },
    });
    /* Read during render, as the sheet does — react-hook-form only re-renders for what is read. */
    void form.formState.errors;
    return form;
  });
}

describe("Record payment — 'shayad TDS hai' hint (R-1520)", () => {
  it("shows the hint and one click sets tdsDeducted + section + rate", () => {
    const { result } = setupSheetForm({});
    const match = matchTdsShortfall({ totalInclGst: 300_900, received: 275_400, gstRatePct: 18 })!;
    render(<TdsShortfallHint match={match} onApply={() => applyTdsSuggestion(result.current, match)} />);

    expect(screen.getByText(/Baaki ₹25,500 shayad TDS hai \(194J 10%\)/)).toBeTruthy();
    expect(result.current.getValues("tdsDeducted")).toBe(false); // never ticked by itself

    act(() => { fireEvent.click(screen.getByRole("button", { name: /TDS deducted tick karein/ })); });
    expect(result.current.getValues("tdsDeducted")).toBe(true);
    expect(result.current.getValues("tdsSection")).toBe("194J");
    expect(result.current.getValues("tdsRatePct")).toBe(10);
    expect(result.current.getValues("amount")).toBe(275_400); // bank amount untouched
  });

  it("no match → no hint", () => {
    const { container } = render(<TdsShortfallHint match={null} onApply={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("the sheet shows the hint only while TDS is not ticked", () => {
    const src = readFileSync(join(__dirname, "record-payment-dialog.tsx"), "utf8");
    expect(src).toMatch(/!tdsDeducted && !split[\s\S]{0,200}matchTdsShortfall/);
  });
});

describe("Record payment — ₹0 in bank only when TDS settles it (R-1520 'Record TDS')", () => {
  const check = async (values: Partial<RecordPaymentFormData>) => {
    const { result } = setupSheetForm(values);
    let saved = false;
    await act(async () => { await result.current.handleSubmit(() => { saved = true; })(); });
    return { saved, error: result.current.formState.errors.amount?.message };
  };

  it("₹0 without TDS is still refused with the same message", async () => {
    const r = await check({ amount: 0, tdsDeducted: false });
    expect(r.saved).toBe(false);
    expect(r.error).toBe("Amount must be more than ₹0.");
  });

  it("₹0 with TDS ticked is accepted (the TDS is the settlement)", async () => {
    const r = await check({ amount: 0, tdsDeducted: true, tdsSection: "194J", tdsRatePct: 10, method: "other", reference: "TDS 194J" });
    expect(r.saved).toBe(true);
  });

  it("negative is refused either way", async () => {
    expect((await check({ amount: -5, tdsDeducted: true })).saved).toBe(false);
  });
});
