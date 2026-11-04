import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoQuoteNotSentReason,
  heldQuoteTotals,
  isAutoQuoteHeld,
  type SendAutoQuoteHeld,
} from "./send-auto-quote";
import { autoQuoteOutcomeFromSend, agentMaySendSeparateReply } from "./auto-quote-for-lead";

/* ─────────────────────────────────────────────────────────────────────────────
   R-2460 — a HELD auto-quote is not a FAILED one.

   R-2456 made sendAutoQuote hold a quote the customer-copy gate refuses (lead with no state,
   company with no state, needs approval) — but it returned "failed". Two harms followed:
     1. callers told the owner "the quotation email failed to send" (it never tried);
     2. lib/inbound/ingest.ts ran the AI sales agent with the held draft's totals authorised,
        so an unapproved price could reach the customer in the agent's reply.
   This file pins the result shape and the callers' words; the agent half is pinned in
   lib/ai/held-quote-*.test.ts.
   ───────────────────────────────────────────────────────────────────────────── */

const HELD: SendAutoQuoteHeld = {
  status: "held",
  quoteId: "Q-TEST-2026-27-0001",
  kind: "customer_state",
  reason: "The lead has no state, so the place of supply is unknown.",
  nextStep: "Set the lead's state, then send the quote.",
  href: "/leads?lead=lead-1",
  totals: [10000, 1800, 11800],
};

describe("R-2460 — the held result and its words", () => {
  it("isAutoQuoteHeld tells a hold from sent/failed", () => {
    expect(isAutoQuoteHeld(HELD)).toBe(true);
    expect(isAutoQuoteHeld("failed")).toBe(false);
    expect(isAutoQuoteHeld("sent")).toBe(false);
  });

  it("a hold reads 'Quote held — <reason>', never 'failed'", () => {
    const s = autoQuoteNotSentReason(HELD);
    expect(s).toMatch(/^Quote held — The lead has no state/);
    expect(s).toContain("Set the lead's state");
    expect(s).not.toMatch(/fail/i);
    expect(autoQuoteNotSentReason("failed")).toMatch(/failed to send/);
  });

  it("the held totals are every figure the draft carries: subtotal, taxable, GST, gross", () => {
    expect(heldQuoteTotals({ subtotal: 10000, discount_pct: 10, tax_rate: 18, amount: 10620 }))
      .toEqual([10000, 9000, 1620, 10620]);
    expect(heldQuoteTotals({ subtotal: null, amount: null })).toEqual([]);
    // An older row with no tax rate and no stored total: the send path prices it at 18%.
    expect(heldQuoteTotals({ subtotal: 10000, tax_rate: null, amount: null })).toEqual([10000, 1800, 11800]);
  });
});

describe("R-2460 — autoQuoteForLead carries the hold to its callers", () => {
  it("held → not emailed, reason 'Quote held — …', the hold attached; the agent still answers", () => {
    const out = autoQuoteOutcomeFromSend(HELD, "Q-TEST-2026-27-0001");
    expect(out.emailed).toBe(false);
    if (out.emailed) return;
    expect(out.reason).toMatch(/^Quote held — /);
    expect(out.held).toEqual(HELD);
    // The customer is still owed an answer (asking for the state) — just without the price.
    expect(agentMaySendSeparateReply(out)).toBe(true);
  });

  it("failed stays failed, sent stays sent", () => {
    expect(autoQuoteOutcomeFromSend("failed", "Q-1")).toEqual({ emailed: false, reason: "the quotation email failed to send — the draft is saved" });
    expect(autoQuoteOutcomeFromSend("sent", "Q-1")).toEqual({ emailed: true, quoteId: "Q-1" });
  });
});

/* Source checks — the callers' wiring, which a unit test of the helpers cannot see. */
const SRC = join(process.cwd(), "src");
const code = (p: string) =>
  readFileSync(join(SRC, p), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("R-2460 — callers say 'held', and the agent is told", () => {
  it("the website enquiry route uses the shared hold sentence, not its own 'failed' line", () => {
    const route = code("app/api/public/enquiry/workspace/route.ts");
    expect(route).toMatch(/autoQuoteNotSentReason\(/);
    expect(route).not.toMatch(/holdReason = "the quotation email failed to send/);
  });

  it("ingest hands the hold to the sales agent", () => {
    const ingest = code("lib/inbound/ingest.ts");
    expect(ingest).toMatch(/heldQuote:\s*quote\.held\s*\?\?\s*null/);
  });
});
