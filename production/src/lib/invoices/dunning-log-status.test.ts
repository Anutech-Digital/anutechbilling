import { describe, it, expect } from "vitest";
import { dunningLogStatus, reachedNobody, dunningOutcome, stepHistory, stepSettled, blocksResend, MAX_STEP_ATTEMPTS } from "./dunning-log-status";

/* The real rows, from invoice_dunning_log on 22 Aug 2026. Both said "sent" and both
   reached nobody: INV-3BBD-2026-27-0002's customer (BETA CO PROJECTS PRIVATE
   LIMITED) has no contact_email, and the route only sends when it has an address. */
const REAL_ROW = { recipient: null, hasMessage: true, emailConfigured: true };

describe("dunningLogStatus", () => {
  it("does not call it sent when there was no address — the 19 and 21 Aug rows", () => {
    expect(dunningLogStatus(REAL_ROW)).toBe("no_recipient");
  });

  it("checks the recipient BEFORE the provider, which is where the old line went wrong", () => {
    /* `isEmailConfigured() ? "sent" : "stubbed"` answers whether Resend is set up. That is
       true here, and it was true then, and it is not the question. */
    expect(dunningLogStatus({ recipient: null, hasMessage: true, emailConfigured: true })).toBe("no_recipient");
    expect(dunningLogStatus({ recipient: null, hasMessage: true, emailConfigured: false })).toBe("no_recipient");
  });

  it("treats blank and whitespace-only addresses as no address", () => {
    for (const r of ["", "   ", "\t", undefined, null]) {
      expect(dunningLogStatus({ recipient: r, hasMessage: true, emailConfigured: true }), JSON.stringify(r))
        .toBe("no_recipient");
    }
  });

  it("says no_recipient when no message could be composed either", () => {
    expect(dunningLogStatus({ recipient: "a@b.com", hasMessage: false, emailConfigured: true }))
      .toBe("no_recipient");
  });

  it("still says sent when a real address really was emailed", () => {
    /* The no-regression half. A truthful status is only useful if the true case is intact. */
    expect(dunningLogStatus({ recipient: "accounts@betaco.example", hasMessage: true, emailConfigured: true }))
      .toBe("sent");
  });

  it("still says stubbed when the provider is off but an address existed", () => {
    /* Kept distinct from no_recipient on purpose: "we would have emailed them, the server
       cannot" is a different problem from "we have nowhere to email". */
    expect(dunningLogStatus({ recipient: "accounts@betaco.example", hasMessage: true, emailConfigured: false }))
      .toBe("stubbed");
  });

  it("trims before deciding, so a padded address is a real one", () => {
    expect(dunningLogStatus({ recipient: "  a@b.com  ", hasMessage: true, emailConfigured: true })).toBe("sent");
  });
});

describe("reachedNobody", () => {
  it("is true only for no_recipient", () => {
    expect(reachedNobody("no_recipient")).toBe(true);
    expect(reachedNobody("sent")).toBe(false);
    expect(reachedNobody("stubbed")).toBe(false);
  });

  it("flags the two real rows so a count can be surfaced to the reseller", () => {
    /* The point of counting: a missing customer email is the reseller's to fix, and they
       cannot fix what the cron reports as sent. */
    const rows = [REAL_ROW, REAL_ROW, { recipient: "x@y.com", hasMessage: true, emailConfigured: true }];
    expect(rows.map(dunningLogStatus).filter(reachedNobody)).toHaveLength(2);
  });
});

/* R-1538 / R-1539 / R-1572 — the provider's answer decides the row, not the configuration. */
describe("dunningOutcome", () => {
  const to = "pay@customer.example";
  it("sent only when the provider accepted it", () => {
    expect(dunningOutcome({ recipient: to, hasMessage: true, send: { status: "sent" } })).toEqual({ status: "sent", reason: null });
  });
  it("a refusal by the Customer messages switch is 'failed' with the reason — not 'sent'", () => {
    expect(dunningOutcome({ recipient: to, hasMessage: true, send: { status: "failed", errorMessage: "Customer messages are switched off" } }))
      .toEqual({ status: "failed", reason: "Customer messages are switched off" });
  });
  it("practice run / provider not set up is 'stubbed'", () => {
    expect(dunningOutcome({ recipient: to, hasMessage: true, send: { status: "stubbed", errorMessage: null } }).status).toBe("stubbed");
  });
  it("no address → no_recipient, whatever the send", () => {
    expect(dunningOutcome({ recipient: "  ", hasMessage: true, send: null })).toEqual({ status: "no_recipient", reason: expect.stringMatching(/no email address/) });
  });
});

describe("stepHistory / stepSettled", () => {
  const row = (status: string, at: string) => ({ dunning_step: "reminder", status, sent_at: at, error_message: status === "failed" ? "refused" : null });
  it("undelivered rows do not settle a step until MAX_STEP_ATTEMPTS", () => {
    const rows = Array.from({ length: MAX_STEP_ATTEMPTS - 1 }, (_, i) => row("failed", `2026-09-0${i + 1}`));
    expect(stepSettled(stepHistory(rows).get("reminder"))).toBe(false);
    rows.push(row("no_recipient", "2026-09-09"));
    const h = stepHistory(rows).get("reminder")!;
    expect(stepSettled(h)).toBe(true);
    expect(h.lastReason).toMatch(/no email address/);
  });
  it("sent or sending settles it at once; sending is never re-sent", () => {
    expect(stepSettled(stepHistory([row("sent", "2026-09-02")]).get("reminder"))).toBe(true);
    expect(stepSettled(stepHistory([row("sending", "2026-09-02")]).get("reminder"))).toBe(true);
    expect(blocksResend("sending")).toBe(true);
    expect(blocksResend("stubbed")).toBe(false);
  });
});
