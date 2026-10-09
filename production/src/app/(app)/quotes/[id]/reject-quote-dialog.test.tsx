// @vitest-environment jsdom
/**
 * R-452 — "Mark rejected" asks why and offers to mark the lead Lost.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RejectQuoteDialog } from "./reject-quote-dialog";

afterEach(cleanup);

function setup(offer: { offer: boolean; note: string | null }) {
  const onConfirm = vi.fn();
  render(
    <RejectQuoteDialog open onOpenChange={() => {}} quoteId="Q-8" leadOffer={offer} pending={false} onConfirm={onConfirm} />,
  );
  return onConfirm;
}

describe("RejectQuoteDialog", () => {
  it("needs a reason before it rejects", () => {
    const onConfirm = setup({ offer: true, note: null });
    const btn = screen.getByRole("button", { name: /mark rejected/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /price too high/i }));
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledWith({ reason: "price", note: null, markLeadLost: true });
  });

  it("lets the lead stay open when the box is unticked", () => {
    const onConfirm = setup({ offer: true, note: null });
    fireEvent.click(screen.getByRole("radio", { name: /no response/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /also mark the lead lost/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark rejected/i }));
    expect(onConfirm).toHaveBeenCalledWith({ reason: "no_response", note: null, markLeadLost: false });
  });

  it("says why the lead is not offered, and never marks it Lost", () => {
    const onConfirm = setup({ offer: false, note: "The lead has another open quote (Q-9), so it stays open." });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/another open quote/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^Other/ }));
    expect((screen.getByRole("button", { name: /mark rejected/i }) as HTMLButtonElement).disabled).toBe(true);   // "Other" needs a note
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "went in-house" } });
    fireEvent.click(screen.getByRole("button", { name: /mark rejected/i }));
    expect(onConfirm).toHaveBeenCalledWith({ reason: "other", note: "went in-house", markLeadLost: false });
  });
});
