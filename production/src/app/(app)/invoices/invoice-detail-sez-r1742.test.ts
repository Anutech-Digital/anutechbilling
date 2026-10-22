/* R-1742 — the invoice page's live inter-state recompute reads the GST treatment, so an SEZ
   customer in the seller's own state is IGST on the dialog / PDF button and on its receipts
   (the treatment frozen on the invoice first, the customer's for older invoices). Every
   isInterStateSupply call on the page must pass `treatment`. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/app/(app)/invoices/invoice-detail.tsx", "utf8");

describe("invoice-detail passes the GST treatment to isInterStateSupply", () => {
  const calls = src.match(/isInterStateSupply\(\s*[a-z][\s\S]*?\);/g) ?? [];
  it("has the two live recompute calls", () => {
    expect(calls.length).toBe(2);
  });
  it.each([0, 1])("call %i passes treatment from the invoice, then the customer", (i) => {
    expect(calls[i]).toMatch(/treatment:\s*\w+\.gst_treatment\s*\?\?\s*customer\?\.gst_treatment/);
  });
});
