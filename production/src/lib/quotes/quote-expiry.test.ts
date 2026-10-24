/**
 * R-1679 (staging 19 Oct, Q-5F40-27-0096 "Valid until 18 Oct"): one rule for "this quote's
 * validity has ended", judged on the IST calendar day.
 */
import { describe, it, expect } from "vitest";
import { validityEnded, validityDaysLeft, shownQuoteStatus, expiredByDate } from "./quote-expiry";
import { isQuoteExpired } from "@/lib/utils";
import { unifiedStatus, isClosedQuote } from "./status-badge";
import { quoteListTab } from "./list-tab";

const q = (over: Record<string, unknown> = {}) => ({
  status: "sent", expires_date: "2026-10-18", payment_status: "none", invoice_id: null,
  amount: 38_232, payment_amount: 0, ...over,
}) as never;

describe("validityEnded / validityDaysLeft", () => {
  it("valid through the whole last day, ended the next IST day", () => {
    expect(validityEnded("2026-10-18", "2026-10-18")).toBe(false);
    expect(validityEnded("2026-10-18", "2026-10-19")).toBe(true);
    expect(validityEnded(null, "2026-10-19")).toBe(false);
  });
  it("agrees with the server's accept check (isQuoteExpired, end of day IST)", () => {
    // 19 Oct 00:10 IST = 18 Oct 18:40 UTC
    const justAfter = new Date("2026-10-18T18:40:00Z");
    expect(isQuoteExpired("2026-10-18", justAfter)).toBe(true);
    expect(validityEnded("2026-10-18", "2026-10-19")).toBe(true);
    const lastEvening = new Date("2026-10-18T18:00:00Z"); // 23:30 IST on the 18th
    expect(isQuoteExpired("2026-10-18", lastEvening)).toBe(false);
    expect(validityEnded("2026-10-18", "2026-10-18")).toBe(false);
  });
  it("days left counts today: last day = 1, yesterday = 0", () => {
    expect(validityDaysLeft("2026-10-18", "2026-10-18")).toBe(1);
    expect(validityDaysLeft("2026-10-18", "2026-10-19")).toBe(0);
    expect(validityDaysLeft("2026-11-17", "2026-10-19")).toBe(30);
  });
});

describe("shownQuoteStatus — staff see Expired once a waiting quote's date passed", () => {
  it("sent / viewed past validity → expired", () => {
    expect(shownQuoteStatus(q(), "2026-10-19")).toBe("expired");
    expect(shownQuoteStatus(q({ status: "viewed" }), "2026-10-19")).toBe("expired");
    expect(expiredByDate(q(), "2026-10-19")).toBe(true);
  });
  it("still valid → unchanged", () => {
    expect(shownQuoteStatus(q(), "2026-10-18")).toBe("sent");
  });
  it("money outranks the date; accepted / draft / rejected are left alone", () => {
    expect(shownQuoteStatus(q({ payment_status: "partial" }), "2026-10-19")).toBe("sent");
    expect(shownQuoteStatus(q({ invoice_id: "INV-1" }), "2026-10-19")).toBe("sent");
    expect(shownQuoteStatus(q({ status: "accepted" }), "2026-10-19")).toBe("accepted");
    expect(shownQuoteStatus(q({ status: "draft" }), "2026-10-19")).toBe("draft");
    expect(shownQuoteStatus(q({ status: "rejected" }), "2026-10-19")).toBe("rejected");
  });
});

describe("the list badge, tab and closed rule use it", () => {
  const today = "2026-10-19";
  it("Q-5F40-27-0096: badge 'Expired', tab 'expired', closed (no Send / Mark accepted)", () => {
    expect(unifiedStatus(q(), today)).toEqual({ label: "Expired", kind: "danger" });
    expect(quoteListTab(q(), today)).toBe("expired");
    expect(isClosedQuote(q(), today)).toBe(true);
  });
  it("on its last valid day it is still 'Out for review'", () => {
    expect(unifiedStatus(q(), "2026-10-18").label).toBe("Out for review");
    expect(isClosedQuote(q(), "2026-10-18")).toBe(false);
  });
});
