/**
 * R-2822 (Renewals 12-question audit, 14 Nov 2026): the quote's state on a Renewals row.
 *   (a) a whole-term row whose renewal quote is a DRAFT says "Draft ready" and its button is Continue (that draft);
 *   (b) a quote's period reads the same on Renewals as on its own page, with no +1 day (the subscription's start + term
 *       say where the next term starts: ON renewal_date for an app-made row, the day after for a last-day row);
 *   (c) the drawer always says "Sent <date> · valid till <date>" or "Marked sent by hand" (rows stay quiet, R-2767).
 * IST boundaries, frozen clock where a clock is involved.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  attachDocDetails, attachSendTimes, lastDocsBySubscription, quoteLinesPeriod, sendLogQuoteIds, sentDayWords, validTillWords,
  type DocQuote, type DocQuoteDetail, type LastDocsInput,
} from "./last-docs";
import { drawerDocRows, drawerQuoteRow } from "./drawer";
import {
  renewalStage, renewalPrimary, bulkSendDecision, CONTINUE, SEND_RENEWAL, DRAFT_READY,
  type StageSub, type PrimaryContext,
} from "@/lib/renewals/stage";

afterEach(() => vi.useRealTimers());

const SUB = "c2822000-0000-4000-8000-0000000000a1";
const TODAY = "2026-11-14";

const detail = (over: Partial<DocQuoteDetail> & { id: string }): DocQuoteDetail => ({
  line_items: [{ name: "Google Workspace Business Starter", commitment: "annual_monthly" }],
  is_renewal: true, is_extension: false, is_add_seats: false, is_one_off: false, extension_months: 12,
  renewal_term_date: "2026-11-24", created_date: "2026-11-01", ...over,
});
const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "sent", payment_status: "none", created_at: "2026-11-01T05:00:00Z", created_date: "2026-11-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, ...over,
});
const input = (over: Partial<LastDocsInput>): LastDocsInput => ({
  subs: [{ id: SUB, quote_id: null, renewal_quote_id: null, start_date: "2024-11-24" }], quotes: [], billings: [], invoices: [], ...over,
});

describe("R-2822 (b) the quote's period has no +1 day", () => {
  it("an app-made row (renewal_date = start + whole terms): the next term is 24 Nov 2026 – 23 Nov 2027, as the quote page says", () => {
    const sub = { id: SUB, start_date: "2024-11-24", term_months: 12 };
    expect(quoteLinesPeriod(detail({ id: "Q-CT2758-B" }), sub)).toBe("24 Nov 2026 – 23 Nov 2027");
  });

  it("a last-day row (Zoho import: renewal_date is the term's last day): the day after, 25 Nov 2026 – 24 Nov 2027", () => {
    const sub = { id: SUB, start_date: "2024-11-25", term_months: 12 };
    expect(quoteLinesPeriod(detail({ id: "Q-IMP" }), sub)).toBe("25 Nov 2026 – 24 Nov 2027");
  });

  it("start not known: exactly the old words (no guess)", () => {
    expect(quoteLinesPeriod(detail({ id: "Q-X" }), { id: SUB })).toBe("25 Nov 2026 – 24 Nov 2027");
    expect(quoteLinesPeriod(detail({ id: "Q-X" }))).toBe("25 Nov 2026 – 24 Nov 2027");
  });

  it("a 2-year term keeps both ends inclusive", () => {
    expect(quoteLinesPeriod(detail({ id: "Q-2Y", renewal_term_date: "2026-02-28", extension_months: 24 }), { id: SUB, start_date: "2024-02-28", term_months: 24 }))
      .toBe("28 Feb 2026 – 27 Feb 2028 (2 yr)");
  });

  it("through the row's documents: the sub's start + term reach the quote and the Last-quote cell", () => {
    const m = lastDocsBySubscription(input({
      subs: [{ id: SUB, quote_id: null, renewal_quote_id: "Q-CT2758-B", start_date: "2024-11-24", term_months: 12 }],
      quotes: [q({ id: "Q-CT2758-B", renewal_subscription_id: SUB })],
    }));
    const subs = [{ id: SUB, start_date: "2024-11-24", term_months: 12 }];
    const out = attachDocDetails(m, { quotes: [detail({ id: "Q-CT2758-B" })], notes: new Map() }, subs);
    expect(out.get(SUB)!.quote!.period).toBe("24 Nov 2026 – 23 Nov 2027");
  });
});

describe("R-2822 (c) drawer: Sent <date> · valid till <date> / Marked sent by hand", () => {
  const dq = (over: Record<string, unknown> = {}) => ({
    id: "Q-S", date: "2026-11-01", status: "sent", payment_status: "none", expires_date: "2026-11-19", invoice_id: null,
    part: null, period: null, supersededBy: null, amount: null, currency: null, fxRate: null, ...over,
  }) as Parameters<typeof drawerQuoteRow>[0];

  it("emailed: the send day (IST) and the last valid day, even 15 days out (rows hide it, the drawer does not)", () => {
    expect(drawerQuoteRow(dq({ sentAt: "2026-11-04T05:00:00Z", expires_date: "2026-11-29" }), TODAY).status).toBe("Sent 4 Nov 2026 · valid till 29 Nov 2026");
  });

  it("IST day boundary: 18:29Z is still 4 Nov in India, 18:30Z is 5 Nov", () => {
    expect(sentDayWords("2026-11-04T18:29:59Z")).toBe("4 Nov 2026");
    expect(sentDayWords("2026-11-04T18:30:00Z")).toBe("5 Nov 2026");
  });

  it("no email in the log (read, none): Marked sent by hand · valid till", () => {
    expect(drawerQuoteRow(dq({ sentAt: null }), TODAY).status).toBe("Marked sent by hand · valid till 19 Nov 2026");
  });

  it("log not read: plain Sent + validity, never a guess that it was by hand", () => {
    expect(drawerQuoteRow(dq(), TODAY).status).toBe("Sent · valid till 19 Nov 2026");
  });

  it("no expiry (a part proforma): just the send words; viewed keeps its state word", () => {
    expect(drawerQuoteRow(dq({ sentAt: "2026-11-04T05:00:00Z", expires_date: null }), TODAY).status).toBe("Sent 4 Nov 2026");
    expect(drawerQuoteRow(dq({ status: "viewed", sentAt: "2026-11-04T05:00:00Z" }), TODAY).status).toBe("Viewed · sent 4 Nov 2026 · valid till 19 Nov 2026");
  });

  it("valid on its last day; expired / accepted / draft keep their own words", () => {
    expect(drawerQuoteRow(dq({ sentAt: "2026-11-04T05:00:00Z", expires_date: TODAY }), TODAY).status).toBe("Sent 4 Nov 2026 · valid till 14 Nov 2026");
    expect(drawerQuoteRow(dq({ expires_date: "2026-11-13" }), TODAY).status).toBe("Expired");
    expect(drawerQuoteRow(dq({ status: "draft" }), TODAY).status).toBe("Draft");
    expect(drawerQuoteRow(dq({ status: "accepted" }), TODAY).status).toBe("Accepted");
  });

  it("validTillWords: none gives null", () => {
    expect(validTillWords(null)).toBeNull();
    expect(validTillWords("2026-11-19")).toBe("valid till 19 Nov 2026");
  });

  it("attachSendTimes: newest emailed row wins; failed sends are not sent; only sent / viewed quotes are looked up", () => {
    const m = lastDocsBySubscription(input({
      subs: [{ id: SUB, quote_id: null, renewal_quote_id: null, start_date: null }],
      quotes: [
        q({ id: "Q-A", renewal_subscription_id: SUB, status: "sent", created_at: "2026-11-01T05:00:00Z" }),
        q({ id: "Q-B", renewal_subscription_id: SUB, status: "sent", created_at: "2026-11-02T05:00:00Z" }),
        q({ id: "Q-D", renewal_subscription_id: SUB, status: "draft", created_at: "2026-11-03T05:00:00Z" }),
      ],
    }), { all: true });
    expect(sendLogQuoteIds(m)).toEqual(["Q-A", "Q-B"]);
    const out = attachSendTimes(m, [
      { quote_id: "Q-A", status: "sent", sent_at: "2026-11-02T04:00:00Z" },
      { quote_id: "Q-A", status: "sent", sent_at: "2026-11-05T04:00:00Z" },
      { quote_id: "Q-B", status: "failed", sent_at: "2026-11-05T04:00:00Z" },
    ]);
    const rows = Object.fromEntries(drawerDocRows(out.get(SUB), TODAY).map((r) => [r.id, r.status]));
    expect(rows["Q-A"]).toBe("Sent 5 Nov 2026");
    expect(rows["Q-B"]).toBe("Marked sent by hand");
    expect(rows["Q-D"]).toBe("Draft");
  });
});

describe("R-2822 (a) a draft renewal quote: Draft ready, Continue", () => {
  const annual = (over: Partial<StageSub> = {}): StageSub => ({
    status: "active", renewal_state: "upcoming", renewal_date: "2026-12-02", term_months: 12,
    billing_cycle: "yearly", start_date: "2024-12-02", auto_renew: true, grace_until: null, renewal_quote_id: "Q-F588-27-0156", ...over,
  });
  const owner: PrimaryContext = { role: "owner", canEndSubscription: true, tenantGraceDays: 3, offers: { followup: true, messaging: true }, vendorHold: "none" };
  const billing: PrimaryContext = { ...owner, role: "billing", canEndSubscription: false };
  const draft = { doc: { kind: "renewal" as const, quoteId: "Q-F588-27-0156", status: "draft" } };

  it("owner: the line under the chip says Draft ready and the button is Continue on THAT quote (chip stays Due)", () => {
    vi.useFakeTimers({ now: new Date("2026-11-14T10:00:00Z") });
    const sub = annual();
    const s = renewalStage({ sub, todayIst: TODAY, ...draft });
    expect(s).toMatchObject({ key: "due", label: "Due in 18d", note: DRAFT_READY, quoteId: "Q-F588-27-0156", quoteStatus: "draft" });
    expect(renewalPrimary(s, sub, owner).primary).toMatchObject({ kind: "continue", label: CONTINUE, quoteId: "Q-F588-27-0156", opensEditor: true });
    expect(renewalPrimary(s, sub, owner).menu).toContain("send-as-is");
  });

  it("a role that cannot open quotes keeps Send renewal (its confirm path sends that draft); bulk send still sends the draft", () => {
    const sub = annual();
    const s = renewalStage({ sub, todayIst: TODAY, ...draft });
    expect(renewalPrimary(s, sub, billing).primary).toMatchObject({ kind: "send-renewal", label: SEND_RENEWAL, opensEditor: false });
    expect(bulkSendDecision(s)).toEqual({ send: true });
  });

  it("no draft (nothing generated) gives Send renewal and no Draft ready", () => {
    const sub = annual({ renewal_quote_id: null });
    const none = renewalStage({ sub, todayIst: TODAY });
    expect(none.note).toBeNull();
    expect(renewalPrimary(none, sub, owner).primary?.label).toBe(SEND_RENEWAL);
  });

  it("a sent quote is not a draft: no Draft ready, no Continue", () => {
    const sub = annual();
    const s = renewalStage({ sub, todayIst: TODAY, doc: { kind: "renewal", quoteId: "Q-F588-27-0156", status: "sent" } });
    expect(s.note ?? "").not.toMatch(/Draft ready/);
    expect(renewalPrimary(s, sub, owner).primary?.label).not.toBe(CONTINUE);
  });
});
