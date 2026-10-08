/* R-374 — a payment whose reference is already on the quote (record_payment's idempotent replay). */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isReplayResult, paymentTagPatch, replayToast } from "./record-payment-replay";

describe("isReplayResult", () => {
  it("reads either flag the RPC sets on a replay", () => {
    expect(isReplayResult({ idempotent_replay: true, already_recorded: true })).toBe(true);
    expect(isReplayResult({ already_recorded: true })).toBe(true);
    expect(isReplayResult({ idempotent_replay: true })).toBe(true);
  });
  it("a fresh insert (idempotent_replay: false) is not a replay", () => {
    expect(isReplayResult({ idempotent_replay: false })).toBe(false);
    expect(isReplayResult({})).toBe(false);
  });
});

describe("paymentTagPatch", () => {
  it("replay → no patch, so the earlier payment's date and bank account are never rewritten", () => {
    expect(paymentTagPatch({ isReplay: true, receivedDate: "2026-10-07", bankAccountId: "bank-2" })).toBeNull();
  });
  it("new payment → tags the chosen date and bank account (unchanged behaviour)", () => {
    expect(paymentTagPatch({ isReplay: false, receivedDate: "2026-10-07", bankAccountId: "bank-2" })).toEqual({
      received_at: new Date("2026-10-07").toISOString(),
      bank_account_id: "bank-2",
    });
    expect(paymentTagPatch({ isReplay: false, receivedDate: "", bankAccountId: "bank-2" })).toEqual({ bank_account_id: "bank-2" });
  });
  it("new payment with nothing to tag → null (no empty update)", () => {
    expect(paymentTagPatch({ isReplay: false, receivedDate: null, bankAccountId: null })).toBeNull();
  });
});

describe("replayToast", () => {
  it("names the date and amount already recorded and says nothing new was saved", () => {
    const t = replayToast({ amount: 20000, receivedAt: "2026-10-05T06:30:00.000Z" });
    expect(t.tone).toBe("warning");
    expect(t.title).toBe("This reference is already recorded on 5 Oct 2026 for ₹20,000 — nothing new saved.");
    expect(t.lines).toEqual(["Use a different reference for a new payment."]);
    expect(t.title).not.toMatch(/Payment recorded|still pending/);
  });
  it("uses the IST date (a 23:00 UTC payment is the next day in India)", () => {
    expect(replayToast({ amount: 500, receivedAt: "2026-10-04T23:00:00.000Z" }).title).toMatch(/on 5 Oct 2026 for ₹500/);
  });
  it("still says nothing was saved when the earlier row could not be read", () => {
    expect(replayToast(null).title).toBe("This reference is already recorded — nothing new saved.");
  });
});

/* Wiring in the Record payment sheet: on a replay it must return BEFORE any post-save write. */
describe("record-payment-dialog replay wiring (R-374)", () => {
  const src = fs
    .readFileSync(path.join(process.cwd(), "src/components/features/quotes/record-payment-dialog.tsx"), "utf8")
    .replace(/\r\n/g, "\n");
  const fnStart = src.indexOf("mutationFn: async");
  const replayAt = src.indexOf("if (isReplay) {", fnStart);
  const replayEnd = src.indexOf("\n      }\n", replayAt);
  const replayBlock = src.slice(replayAt, replayEnd);

  it("detects the replay from the RPC result and returns early", () => {
    expect(src).toMatch(/const isReplay = isReplayResult\(r\);/);
    expect(replayAt).toBeGreaterThan(fnStart);
    expect(replayBlock).toMatch(/return \{\s*isReplay: true as const,/);
  });

  it("the replay branch writes nothing to payments / invoices / subscriptions", () => {
    expect(replayBlock).not.toMatch(/\.update\(/);
    expect(replayBlock).not.toMatch(/\/receipt`/);
    expect(replayBlock).toMatch(/from\("payments"\)\.select\("amount, received_at"\)/);
  });

  it("every post-save write comes AFTER the replay return", () => {
    for (const marker of [
      '.from("payments")\n          .update(',
      '.from("invoices")\n          .update({ paid_date',
      '.from("subscriptions")\n            .update({ domain',
      "/api/payments/${r.payment_id}/receipt",
    ]) {
      const at = src.indexOf(marker, fnStart);
      expect(at, marker).toBeGreaterThan(replayEnd);
    }
  });

  it("the date/bank tag goes through paymentTagPatch", () => {
    expect(src).toMatch(/paymentTagPatch\(\{ isReplay, receivedDate: data\.receivedDate, bankAccountId \}\)/);
  });

  it("redeemed advance credit is restored on a replay, as on an RPC error", () => {
    expect(replayBlock).toMatch(/await restoreAppliedCredit\(/);
    expect(src).toMatch(/if \(error\) \{[\s\S]{0,400}await restoreAppliedCredit\("payment failed"\);\s*throw error;/);
  });

  it("onSuccess shows the replay toast and does not close the sheet or show 'Payment recorded'", () => {
    const at = src.indexOf("if (res.isReplay) {");
    expect(at).toBeGreaterThan(src.indexOf("onSuccess: async"));
    const block = src.slice(at, src.indexOf("\n      }\n", at));
    expect(block).toMatch(/replayToast\(res\.replayOf\)/);
    expect(block).toMatch(/toast\.warning/);
    expect(block).toMatch(/return;/);
    expect(block).not.toMatch(/onOpenChange\(false\)|paymentToast\(/);
    expect(at).toBeLessThan(src.indexOf("paymentToast({"));
  });
});
