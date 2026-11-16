/**
 * Card test — R-2658: a USD inward bank line ("INW … USD1024.0@93.6") is paired with its Zoho payment
 * by the USD amount (±1 USD, ±10 days); the one such payment paying an open USD invoice is a clean
 * pair in Reconcile from Zoho.
 *
 * One test per howToCheck step. Run: `node scripts/ops/card-tests.mjs R-2658`.
 *
 * Both steps need a company CONNECTED to Zoho Books with real customer payments — the local E2E Test
 * Co has no Zoho connection, and answering the page's request from the test would skip the very code
 * this card changes (the pairing runs on the server, inside the bulk-match route). The rules are
 * proven by unit tests instead:
 *   src/lib/banking/inward-remittance-r2658.test.ts                    (narration forms)
 *   src/lib/integrations/zoho-books/payment-batch-r2658.test.ts        (pairing, rivals, window)
 *   src/lib/integrations/zoho-books/payment-match-r2658.test.ts        (Find in Zoho on one line)
 *   src/lib/integrations/zoho-books/bulk-reconcile-plan-r2658.test.ts  (what is booked, clean pairs)
 */
import { test } from "@playwright/test";
import { onlyInCardTests } from "./card-steps";

test.describe("R-2658 — USD inward: match the Zoho payment by USD amount", () => {
  onlyInCardTests();

  test("Step 1: Banking → Reconcile from Zoho → a USD inward line says 'Matched by USD amount' and is a clean pair", async () => {
    test.skip(true, "Needs a company connected to Zoho Books (staging); the pairing is server-side and proven by the unit tests named above.");
  });

  test("Step 2: the line's Reconcile → Find in Zoho finds the payment dated up to 10 days from the bank date", async () => {
    test.skip(true, "Needs a company connected to Zoho Books (staging); proven by payment-match-r2658.test.ts.");
  });
});
