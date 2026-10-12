import { describe, it, expect } from "vitest";
import { buildReplyContext, REPLY_SYSTEM_PROMPT, type ThreadTurn, type ReplyFacts } from "./reply-context";
import { denyTermsRe } from "@/test/deny-terms";

const FACTS: ReplyFacts = {
  sellerName: "ANUTECH DIGITAL PVT LTD",
  customerName: "Test Company",
  seats: 20,
  plan: "Google Workspace Business Standard",
  factsUnconfirmed: false,
  quote: null,
};

/* The real thread from lead L-MT4HUR6P, with the quoted block the way it actually
   arrives — CRLF, and our own previous message underneath. */
const CUSTOMER_REPLY =
  "Hi,\r\n\r\nActually, I need the quotation for 20 users of Google Workspace Business\r\n" +
  "Standard, not 50 users of Starter. Please adjust that.\r\n\r\n" +
  "On Sat, 22 Aug 2026 at 21:54, <sales@anutech.in> wrote:\r\n\r\n" +
  "> Hi test,\r\n> Thank you for your enquiry for 50 users of Google Workspace Business\r\n" +
  "> Starter. I am preparing the quotation now.\r\n";

const THREAD: ThreadTurn[] = [
  { direction: "inbound",  at: "2026-08-22T15:00:00Z", body: "Hi, please send a quote for Google Workspace." },
  { direction: "outbound", at: "2026-08-22T15:18:00Z", body: "Hi test,\n\nThank you for your enquiry for 50 users of Google Workspace Business Starter." },
  { direction: "inbound",  at: "2026-08-22T16:29:00Z", body: CUSTOMER_REPLY },
];

describe("buildReplyContext — the quoted thread never reaches the model", () => {
  it("strips our own previous message out of the customer's reply", () => {
    /* L29. The raw body holds both 20/Standard (theirs) and 50/Starter (ours, quoted).
       Handing it over unstripped is handing the model our words as if the customer had
       just said them — the exact mistake that produced "50 users of Starter" three
       times. */
    const c = buildReplyContext({ thread: THREAD, facts: FACTS });
    expect(c.latestInbound).toContain("20 users");
    expect(c.latestInbound).not.toContain("Thank you for your enquiry");
    expect(c.latestInbound).not.toMatch(/^\s*>/m);
  });

  it("strips every turn, not just the last", () => {
    /* A thread of eight replies contains seven copies of the conversation. Without this
       the model reads the same sentence eight times and weights it accordingly. */
    const c = buildReplyContext({ thread: THREAD, facts: FACTS });
    const ourQuotedSentence = "Thank you for your enquiry for 50 users";
    /* It appears ONCE — as our genuine outbound turn — and not again inside the
       customer's quoted block. */
    const hits = c.contextText.split(ourQuotedSentence).length - 1;
    expect(hits).toBe(1);
  });

  it("names the message being answered, separately from the history", () => {
    /* A model given a thread will summarise it unless told what the task is. */
    const c = buildReplyContext({ thread: THREAD, facts: FACTS });
    expect(c.contextText).toContain("ANSWER THIS, their most recent message:");
    expect(c.contextText.indexOf("ANSWER THIS")).toBeGreaterThan(c.contextText.indexOf("CONVERSATION"));
  });
});

describe("buildReplyContext — money", () => {
  it("forbids every figure when no quote exists", () => {
    const c = buildReplyContext({ thread: THREAD, facts: FACTS });
    expect(c.allowedAmounts).toEqual([]);
    expect(c.contextText).toMatch(/may NOT write any rupee figure/i);
  });

  it("allows exactly the sent quote's total, and nothing else", () => {
    const c = buildReplyContext({
      thread: THREAD,
      facts: { ...FACTS, quote: { id: "Q-ADPL-2026-27-0042", amount: 118_000 } },
    });
    expect(c.allowedAmounts).toEqual([118_000]);
    expect(c.contextText).toContain("₹1,18,000");
    expect(c.contextText).toMatch(/ONLY rupee figure/i);
  });

  it("tells the model to refer to an existing quote rather than promise a new one", () => {
    const c = buildReplyContext({
      thread: THREAD,
      facts: { ...FACTS, quote: { id: "Q-1", amount: 5_000 } },
    });
    expect(c.contextText).toContain("Q-1");
    expect(c.contextText).toMatch(/rather than promising a new one/i);
  });

  it("ignores a zero-amount quote rather than allowing 0 as a price", () => {
    const c = buildReplyContext({ thread: THREAD, facts: { ...FACTS, quote: { id: "Q-0", amount: 0 } } });
    expect(c.allowedAmounts).toEqual([]);
    expect(c.contextText).toMatch(/No quotation has been sent yet/i);
  });
});

describe("buildReplyContext — stale stored facts are withheld, not stated", () => {
  it("marks the requirement OUT OF DATE and forbids restating it", () => {
    /* L22 and L30. Three attempts at this bug were spent restating a snapshot as though
       it were current. The model must not be handed 20/Standard as truth when the
       customer has written twice and nobody has reconciled the row. */
    const c = buildReplyContext({ thread: THREAD, facts: { ...FACTS, factsUnconfirmed: true } });
    expect(c.contextText).toMatch(/may be OUT OF DATE/);
    expect(c.contextText).toMatch(/Do NOT state these figures back/);
  });

  it("permits the requirement when it IS confirmed", () => {
    const c = buildReplyContext({ thread: THREAD, facts: FACTS });
    expect(c.contextText).toMatch(/confirmed: 20 users of Google Workspace Business Standard/);
    expect(c.contextText).not.toMatch(/OUT OF DATE/);
  });

  it("says so plainly when nothing is on record", () => {
    const c = buildReplyContext({ thread: THREAD, facts: { ...FACTS, seats: null, plan: null } });
    expect(c.contextText).toMatch(/No seat count or product is on record yet\. Do not invent either\./);
  });
});

describe("buildReplyContext — identity", () => {
  it("uses the tenant's own name, never a hardcoded company", () => {
    /* L20. Three routes shipped with "Demo Co" baked into customer-facing
       text; the system prompt says sign off with the given name and nothing else. */
    const c = buildReplyContext({ thread: THREAD, facts: { ...FACTS, sellerName: "Delfos Technologies" } });
    expect(c.contextText).toContain("Delfos Technologies");
    expect(c.contextText).not.toMatch(denyTermsRe());
  });

  it("degrades to a neutral phrase rather than a placeholder company", () => {
    const c = buildReplyContext({ thread: THREAD, facts: { ...FACTS, sellerName: null } });
    expect(c.contextText).toContain("this reseller");
    expect(c.contextText).not.toContain("null");
  });
});

describe("buildReplyContext — refuses when there is nothing to answer", () => {
  it("blocks a thread with no inbound message", () => {
    const c = buildReplyContext({
      thread: [{ direction: "outbound", at: null, body: "Hi, here is your quote." }],
      facts: FACTS,
    });
    expect(c.blocked).toMatch(/no message from the customer/i);
    expect(c.contextText).toBe("");
  });

  it("blocks when the only inbound message is pure quoted text", () => {
    /* A top-post with nothing above the quote. Drafting a "reply" to our own message is
       how an AI feature starts talking to itself. */
    const c = buildReplyContext({
      thread: [{ direction: "inbound", at: null, body: "On Mon, we wrote:\n> your quote is ready" }],
      facts: FACTS,
    });
    expect(c.blocked).not.toBeNull();
  });

  it("blocks an empty thread", () => {
    expect(buildReplyContext({ thread: [], facts: FACTS }).blocked).not.toBeNull();
  });
});

describe("REPLY_SYSTEM_PROMPT", () => {
  it("puts answering the question first and the next step last", () => {
    /* The order is the instruction. A model given six equal rules follows the last one. */
    expect(REPLY_SYSTEM_PROMPT.indexOf("Answer what they actually asked"))
      .toBeLessThan(REPLY_SYSTEM_PROMPT.indexOf("exactly one clear next step"));
  });

  it("forbids inventing figures, dates, promises and credentials", () => {
    for (const rule of [/never write a rupee figure/i, /not in the context/i, /No fabricated titles/i, /partner claims/i]) {
      expect(REPLY_SYSTEM_PROMPT, String(rule)).toMatch(rule);
    }
  });

  it("asks for JSON only, matching what the caller parses", () => {
    expect(REPLY_SYSTEM_PROMPT).toContain('{"subject": string, "message": string}');
  });
});
