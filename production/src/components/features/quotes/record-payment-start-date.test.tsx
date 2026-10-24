// @vitest-environment jsdom
/* R-1442 — Record payment: a past "Received on" date jumped back to today.
   The sheet's fill-on-open effect also listed `remaining` and `customerTdsDefaults` as
   dependencies, and both arrive AFTER the sheet opens (the split-billing lookup and the
   customer's TDS defaults are async). Each arrival re-ran reset(), putting receivedDate back
   to today — and the method and reference with it — while the operator was typing. Now the
   form is filled once per open; late data only sets its own fields. */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { useFillOnOpen } from "./record-payment-dialog";

describe("R-1442 Record payment keeps the date the operator chose", () => {
  it("data arriving after open does not reset the form", () => {
    const fill = vi.fn();
    const { result, rerender } = renderHook(
      ({ open, remaining }: { open: boolean; remaining: number }) => {
        const form = useForm<{ receivedDate: string }>({ defaultValues: { receivedDate: "2026-10-23" } });
        useFillOnOpen(open, () => { fill(remaining); form.reset({ receivedDate: "2026-10-23" }); });
        return form;
      },
      { initialProps: { open: true, remaining: 1000 } },
    );
    expect(fill).toHaveBeenCalledTimes(1);
    act(() => { result.current.setValue("receivedDate", "2026-09-01"); });
    rerender({ open: true, remaining: 800 });   // split expectation lands
    rerender({ open: true, remaining: 800 });
    expect(fill).toHaveBeenCalledTimes(1);
    expect(result.current.getValues("receivedDate")).toBe("2026-09-01");
  });

  it("closing and opening again fills afresh", () => {
    const fill = vi.fn();
    const { rerender } = renderHook(({ open }: { open: boolean }) => useFillOnOpen(open, fill), { initialProps: { open: true } });
    rerender({ open: false });
    rerender({ open: true });
    expect(fill).toHaveBeenCalledTimes(2);
  });

  it("the sheet fills through it, not through an effect keyed on remaining / TDS defaults", () => {
    const src = readFileSync(join(__dirname, "record-payment-dialog.tsx"), "utf8");
    expect(src).toContain("useFillOnOpen(open, () => {");
    expect(src).not.toMatch(/\}, \[open, reset, remaining, customerTdsDefaults, tdsOnly\]\);/);
  });
});
