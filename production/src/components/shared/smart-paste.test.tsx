// @vitest-environment jsdom
//
// R-491 (9 Oct 2026): Smart Paste on a LEAD form fills company, seats, GSTIN, state and billing
// from Abhishek's message; on the customer form (no `lead`) it behaves exactly as before.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SmartPaste, type SmartPasteValues } from "./smart-paste";

afterEach(cleanup);

const CATALOGUE = [
  { id: "gw-bs", name: "Google Workspace Business Starter" },
  { id: "gw-std", name: "Google Workspace Standard" },
];

const MSG = `Hi, main Rahul Gupta, Gupta Traders Pvt Ltd se.
Hume 15 Google Workspace Business Starter chahiye.
Email: rahul@guptatraders.in, Phone +91 98765 43210
GSTIN 07AABCG1234K1Z5, Delhi
Billing monthly rakhna hai.`;

function pasteAndFill(props: { lead?: boolean; contactOnly?: boolean }): SmartPasteValues {
  const onFill = vi.fn();
  render(<SmartPaste catalogue={CATALOGUE} onFill={onFill} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /smart paste/i }));
  fireEvent.change(screen.getByLabelText("Message to read details from"), { target: { value: MSG } });
  fireEvent.click(screen.getByRole("button", { name: /^Fill \d+ fields?$/ }));
  expect(onFill).toHaveBeenCalledTimes(1);
  return onFill.mock.calls[0][0] as SmartPasteValues;
}

describe("SmartPaste lead mode (R-491)", () => {
  it("Add lead: all ten fields found and filled", () => {
    const onFill = vi.fn();
    render(<SmartPaste catalogue={CATALOGUE} onFill={onFill} lead />);
    fireEvent.click(screen.getByRole("button", { name: /smart paste/i }));
    fireEvent.change(screen.getByLabelText("Message to read details from"), { target: { value: MSG } });
    expect(screen.getByText("Found 10 of 10")).toBeTruthy();
    expect(screen.getByText("Delhi (07)")).toBeTruthy();
    expect(screen.getByText(/check digit does not match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fill 10 fields" }));
    expect(onFill.mock.calls[0][0]).toEqual({
      name: "Rahul Gupta",
      email: "rahul@guptatraders.in",
      phone: "9876543210",
      seats: 15,
      product: CATALOGUE[0],
      domain: "guptatraders.in",
      company: "Gupta Traders Pvt Ltd",
      gstin: "07AABCG1234K1Z5",
      stateCode: "07",
      billingCycle: "monthly",
    });
  });

  it("Quick add (contactOnly + lead): name, email, phone and company only", () => {
    expect(pasteAndFill({ lead: true, contactOnly: true })).toEqual({
      name: "Rahul Gupta",
      email: "rahul@guptatraders.in",
      phone: "9876543210",
      company: "Gupta Traders Pvt Ltd",
    });
  });

  it("customer form (no lead): unchanged — no company/GSTIN/state/billing, seats from extractor only", () => {
    const v = pasteAndFill({});
    expect(v.company).toBeUndefined();
    expect(v.gstin).toBeUndefined();
    expect(v.stateCode).toBeUndefined();
    expect(v.billingCycle).toBeUndefined();
    expect(v.seats).toBeUndefined();
    expect(v.name).toBe("Rahul Gupta");
  });
});
