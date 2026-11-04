// @vitest-environment jsdom
/* R-2095 follow-up (30 Oct 2026): Record balance payment with "Customer deducted TDS" ticked and ₹0
   in bank still showed Payment method UPI and Received in <bank> — the receipt saves as method
   other / no bank account (tdsOnlyReceipt), so the screen said something the record did not.
   A TDS-only receipt now hides both fields and says why. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { isTdsOnlyEntry, TdsOnlyNoBankNote } from "./record-payment-dialog";

afterEach(cleanup);

describe("R-2095: TDS-only receipt hides method and bank account", () => {
  it("TDS ticked + ₹0 bank = TDS-only; anything else is a normal receipt", () => {
    expect(isTdsOnlyEntry(true, 0)).toBe(true);
    expect(isTdsOnlyEntry(true, 450)).toBe(false);
    expect(isTdsOnlyEntry(false, 0)).toBe(false);
    expect(isTdsOnlyEntry(true, Number.NaN)).toBe(false);
  });

  it("the note says no money reached a bank and how it is saved", () => {
    render(<TdsOnlyNoBankNote />);
    expect(screen.getByTestId("tds-only-no-bank").textContent).toMatch(/no money reached your bank/i);
    expect(screen.getByTestId("tds-only-no-bank").textContent).toMatch(/TDS deducted by customer/);
  });

  it("the sheet shows the method and Received in fields only when it is not TDS-only", () => {
    const src = readFileSync(join(__dirname, "record-payment-dialog.tsx"), "utf8");
    const method = src.indexOf('htmlFor="paymentMethod"');
    const receivedIn = src.indexOf('htmlFor="depositAccount"');
    const gate = src.lastIndexOf("{tdsOnlyEntry ? <TdsOnlyNoBankNote /> : (", method);
    expect(gate).toBeGreaterThan(-1);
    expect(receivedIn).toBeGreaterThan(method);
    expect(src.slice(gate, receivedIn)).not.toMatch(/\n\s*\)\}\n/);   // both fields inside the one gate
  });
});
