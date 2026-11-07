/**
 * Card test — R-2255 "Zoho Billing A20: Credit on change only up to what was paid" (R-2550).
 *
 * R-2255 adds the money rule (src/lib/subscriptions/change-credit.ts) that the two screens that
 * give credit on a change will use: Change plan (R-2227, A3) and Reduce seats (R-2252, A17).
 * Neither screen exists yet (8 Nov 2026), so there is no page to open on localhost:
 *   - Step 1 checks the owner's case through the rule itself (no browser, no data written).
 *   - Step 2 is a skip until R-2227 / R-2252 show the preview — their card tests check the lines.
 * Run: `node scripts/ops/card-tests.mjs R-2255`.
 */
import { expect, test } from "@playwright/test";
import { onlyInCardTests } from "./card-steps";
import { splitChangeCredit } from "../../src/lib/subscriptions/change-credit";

test.describe("R-2255 credit on a change only up to what was paid", () => {
  onlyInCardTests();

  test("Step 1: unpaid ₹2,700 invoice, unused ₹1,829.03 → credit ₹0, the open amount is lowered instead", () => {
    const unpaid = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: 0, invoiced: true });
    expect(unpaid.lines.map((l) => l.text)).toEqual([
      "Lowers what they still owe: ₹1,829.03",
      "Credit to customer (from money received): ₹0.00 — nothing received yet",
    ]);
    const paid = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: 270000, invoiced: true });
    expect(paid.creditPaise).toBe(182903);
  });

  test("Step 2: Change plan / Reduce seats preview shows both lines", () => {
    test.skip(true, "No screen yet — Change plan (R-2227) and Reduce seats (R-2252) are still in the list; their card tests check this preview.");
  });
});
