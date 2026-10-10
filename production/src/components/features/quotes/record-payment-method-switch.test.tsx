// @vitest-environment jsdom
/* R-819 — Record payment: changing the method must re-check the reference with the NEW
   method's rule. Abhishek (staging, 10 Oct): UPI + "INDBH06054327633" → Confirm → UPI error →
   switch to Bank transfer → the UPI error stayed and blocked a valid bank UTR.
   Runs the sheet's own schema + applyPaymentMethod through a real react-hook-form. */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import fs from "node:fs";
import path from "node:path";
import {
  applyPaymentMethod,
  recordPaymentSchema,
  type RecordPaymentFormData,
} from "./record-payment-dialog";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const UTR = "INDBH06054327633";

function setup(method: string, reference: string) {
  const { result } = renderHook(() => {
    const form = useForm<RecordPaymentFormData>({
      resolver: zodResolver(recordPaymentSchema),
      defaultValues: { amount: 1000, method, reference, receivedDate: "2026-10-10", tdsDeducted: false },
    });
    /* Read during render, as the sheet does — react-hook-form only re-renders for what is read. */
    void form.formState.errors;
    void form.formState.isSubmitted;
    return form;
  });
  /** Press Confirm: returns true when the form would save. */
  const confirm = async () => {
    let saved = false;
    await act(async () => { await result.current.handleSubmit(() => { saved = true; })(); });
    return saved;
  };
  const switchTo = async (m: string) => {
    await act(async () => {
      const f = result.current;
      await applyPaymentMethod(f, m, f.formState.isSubmitted || !!f.formState.errors.reference);
    });
  };
  const refError = () => result.current.formState.errors.reference?.message;
  return { result, confirm, switchTo, refError };
}

describe("Record payment — switching the method re-checks the reference (R-819)", () => {
  it("UPI error → switch to Bank transfer → error gone and the alphanumeric UTR is accepted", async () => {
    const f = setup("upi", UTR);
    expect(await f.confirm()).toBe(false);
    expect(f.refError()).toBe("A UPI reference is 12 digits, numbers only.");

    await f.switchTo("bank_transfer");
    expect(f.refError()).toBeUndefined();
    expect(await f.confirm()).toBe(true);
    expect(f.result.current.getValues("method")).toBe("bank_transfer");
  });

  it("switching back to UPI applies the 12-digit rule again", async () => {
    const f = setup("upi", UTR);
    await f.confirm();
    await f.switchTo("bank_transfer");
    expect(await f.confirm()).toBe(true);

    await f.switchTo("upi");
    expect(f.refError()).toBe("A UPI reference is 12 digits, numbers only.");
    expect(await f.confirm()).toBe(false);

    await act(async () => { f.result.current.setValue("reference", "402312345678"); });
    expect(await f.confirm()).toBe(true);
  });

  it("a bad bank UTR still fails after switching from UPI (the new rule, not no rule)", async () => {
    const f = setup("upi", "12345");
    expect(await f.confirm()).toBe(false);
    await f.switchTo("bank_transfer");
    expect(f.refError()).toBe("A bank UTR is 12 to 22 letters and digits (IMPS 12, NEFT 16, RTGS 22).");
    expect(await f.confirm()).toBe(false);
  });

  it("other methods behave as before", async () => {
    const f = setup("upi", "");
    await f.switchTo("cash");
    expect(await f.confirm()).toBe(true);                 // cash: blank allowed

    await f.switchTo("cheque");
    expect(await f.confirm()).toBe(false);                // cheque: needs a real number
    expect(f.refError()).toMatch(/real UTR/);
    await act(async () => { f.result.current.setValue("reference", "004521 SBI"); });
    expect(await f.confirm()).toBe(true);

    await f.switchTo("razorpay");
    expect(f.refError()).toBeUndefined();
    await act(async () => { f.result.current.setValue("reference", "pay_P1a2B3c4D5e6F7"); });
    expect(await f.confirm()).toBe(true);
  });

  it("before the first Confirm, switching does not show an error early", async () => {
    const f = setup("upi", UTR);
    await f.switchTo("upi");
    expect(f.refError()).toBeUndefined();
  });

  it("the method dropdown uses applyPaymentMethod (wiring)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/components/features/quotes/record-payment-dialog.tsx"), "utf8");
    expect(src).toMatch(/void applyPaymentMethod\(\{ setValue, clearErrors, trigger, getValues \}, m, isSubmitted \|\| !!errors\.reference\)/);
    expect(src).not.toMatch(/setValue\("method", m\);/);
  });
});
