// @vitest-environment jsdom
//
// R-1520 — a Partial invoice whose remaining due is exactly a common TDS says so, with a
// "Record TDS" button that opens Record payment in TDS mode (INV-A378: ₹3,00,900 total,
// ₹2,75,400 received → "Baaki ₹25,500 = 10% TDS lagta hai").
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { InvoiceTdsBanner } from "./invoice-detail";

afterEach(cleanup);

describe("Invoice detail — TDS banner (R-1520)", () => {
  it("Partial invoice with a matching due → banner + Record TDS hands over section, rate and amount", () => {
    const onRecordTds = vi.fn();
    render(<InvoiceTdsBanner total={300_900} received={275_400} gstRatePct={18} onRecordTds={onRecordTds} />);
    expect(screen.getByText(/Balance ₹25,500 — looks like 10% TDS/)).toBeTruthy();
    expect(screen.getByText(/194J/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Record TDS/ }));
    expect(onRecordTds).toHaveBeenCalledWith(expect.objectContaining({ section: "194J", ratePct: 10, tds: 25_500 }));
  });

  it("a due that is not a TDS rate → nothing", () => {
    const { container } = render(<InvoiceTdsBanner total={300_900} received={280_000} gstRatePct={18} onRecordTds={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("nothing received yet (Unpaid, not Partial) → nothing", () => {
    const { container } = render(<InvoiceTdsBanner total={300_900} received={0} gstRatePct={18} onRecordTds={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("the page wires the banner to Record payment in TDS mode (tdsOnly), only when money is due", () => {
    const src = readFileSync(join(__dirname, "invoice-detail.tsx"), "utf8");
    expect(src).toMatch(/<InvoiceTdsBanner[\s\S]{0,400}onRecordTds=/);
    expect(src).toMatch(/moneyDue && quote\?\.id && \(\s*<InvoiceTdsBanner/);
    expect(src).toMatch(/tdsOnly=\{tdsOnly\}/);
  });
});
