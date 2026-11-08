// @vitest-environment jsdom
/* R-2603 — Banking → a money-OUT line (₹75,000) → Loan / EMI → "I am GIVING a loan/advance": the
   footer's Save books a Loans given row (record_loan_given_from_bank_out), never the old Balance Sheet
   line; it waits for the name; borrowers already on Loans given are offered once each. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { FooterSave } from "./reconcile-who-tiles";

const loanOut = vi.fn(() => Promise.resolve("loan-1"));
vi.mock("@/lib/queries/loans-given", () => ({
  useLoanGivenFromBankLine: () => ({ mutateAsync: loanOut, isPending: false }),
  useLoanBorrowerNames: () => ({ data: ["Julie Rawat", "Vinod Hem Raj"] }),
}));

import { LoanGivenOutFields, LOAN_GIVEN_BORROWERS_LIST_ID } from "./loan-given-out-fields";

afterEach(() => { cleanup(); loanOut.mockClear(); });

function renderWith(borrower: string) {
  let last: FooterSave | null = null;
  const onDone = vi.fn();
  const view = render(
    <LoanGivenOutFields txnId="t1" amount={75000} borrower={borrower} notes="IMPS DR JULIE"
      onDone={onDone} onFooterSave={(s) => { last = s; }} />,
  );
  return { view, onDone, save: () => last as FooterSave | null };
}

describe("R-2603 LoanGivenOutFields", () => {
  it("no name → the footer Save is off with the reason", () => {
    const { save } = renderWith("  ");
    expect(save()?.label).toBe("Book ₹75,000 as a loan given (Loans given)");
    expect(save()?.disabledReason).toBe("Enter the person's name.");
    save()?.onSave();
    expect(loanOut).not.toHaveBeenCalled();
  });

  it("with a name → Save books the Loans given row on this line, then closes", async () => {
    const { save, onDone } = renderWith(" Julie Rawat ");
    expect(save()?.disabledReason).toBeNull();
    save()?.onSave();
    expect(loanOut).toHaveBeenCalledWith({ txnId: "t1", borrower: "Julie Rawat", notes: "IMPS DR JULIE" });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("offers the borrowers already on Loans given", () => {
    const { view } = renderWith("");
    const list = view.container.querySelector(`datalist#${LOAN_GIVEN_BORROWERS_LIST_ID}`);
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"))).toEqual(["Julie Rawat", "Vinod Hem Raj"]);
  });
});
