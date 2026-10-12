import { describe, it, expect } from "vitest";
import {
  normaliseSubject, threadKey, groupIntoThreads, threadFor, type ThreadableEmail,
} from "./threads";

const mail = (
  id: string, from: string | null, subject: string | null, created_at: string,
): ThreadableEmail => ({ id, from_email: from, subject, created_at });

describe("normaliseSubject", () => {
  it("strips a reply prefix", () => {
    expect(normaliseSubject("Re: Quote please")).toBe("quote please");
  });

  it("strips a stack of them — clients pile these up without limit", () => {
    expect(normaliseSubject("Re: Fwd: RE: Quote please")).toBe("quote please");
  });

  it("handles the numbered form some clients use", () => {
    expect(normaliseSubject("Re[2]: Quote please")).toBe("quote please");
  });

  it("collapses whitespace and case so the same subject keys the same", () => {
    expect(normaliseSubject("  Quote   PLEASE ")).toBe(normaliseSubject("quote please"));
  });

  it("does not eat a real word off the front", () => {
    /* An aggressive prefix list starts removing words that only look like prefixes.
       "Renewal" begins with "re" but is not a reply marker. */
    expect(normaliseSubject("Renewal for 14 seats")).toBe("renewal for 14 seats");
    expect(normaliseSubject("Response times")).toBe("response times");
  });

  it("survives a missing subject", () => {
    expect(normaliseSubject(null)).toBe("");
    expect(normaliseSubject("")).toBe("");
  });
});

describe("threadKey", () => {
  it("puts the sender in the key so two customers can never merge", () => {
    /* Both wrote "Quote please". Merging them would show one customer another
       customer's enquiry. */
    const a = mail("1", "user1@betaco.test", "Quote please", "2026-08-17T09:00:00Z");
    const b = mail("2", "arun@othercorp.com", "Quote please", "2026-08-17T10:00:00Z");
    expect(threadKey(a)).not.toBe(threadKey(b));
  });

  it("matches a reply to its original", () => {
    const a = mail("1", "user1@betaco.test", "Quote please", "2026-08-17T09:00:00Z");
    const b = mail("2", "user1@betaco.test", "Re: Quote please", "2026-08-17T10:00:00Z");
    expect(threadKey(a)).toBe(threadKey(b));
  });

  it("gives an email with no sender a thread of its own", () => {
    /* Grouping every anonymous message together would present a conversation
       nobody had. */
    const a = mail("1", null, "Quote please", "2026-08-17T09:00:00Z");
    const b = mail("2", null, "Quote please", "2026-08-17T10:00:00Z");
    expect(threadKey(a)).not.toBe(threadKey(b));
  });
});

describe("groupIntoThreads", () => {
  const emails = [
    mail("1", "user1@betaco.test",  "Quote please",        "2026-08-10T09:00:00Z"),
    mail("2", "user1@betaco.test",  "Re: Quote please",    "2026-08-17T08:00:00Z"),
    mail("3", "arun@othercorp.com", "New M365 licences",   "2026-08-15T09:00:00Z"),
  ];

  it("puts a reply with its original", () => {
    const threads = groupIntoThreads(emails);
    expect(threads).toHaveLength(2);
    const testuser1 = threads.find((t) => t.messages.length === 2)!;
    expect(testuser1.messages.map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("reads oldest first, because a conversation reads downwards", () => {
    const t = groupIntoThreads(emails).find((x) => x.messages.length === 2)!;
    expect(t.messages[0].id).toBe("1");
    expect(t.latest.id).toBe("2");
  });

  it("sorts threads by their LATEST message, not their first", () => {
    /* A two-week-old enquiry replied to this morning is today's work. Sorting on the
       first message would bury it under newer but finished conversations. */
    const threads = groupIntoThreads(emails);
    expect(threads[0].latest.id).toBe("2");   // 17 Aug, thread started 10 Aug
    expect(threads[1].latest.id).toBe("3");   // 15 Aug
  });

  it("marks a lone email as not really a conversation", () => {
    const threads = groupIntoThreads(emails);
    expect(threads.find((t) => t.latest.id === "3")!.isSingle).toBe(true);
    expect(threads.find((t) => t.messages.length === 2)!.isSingle).toBe(false);
  });

  it("a colleague writing from another address starts a separate thread", () => {
    /* A known limitation, stated in the module header and labelled in the UI.
       Grouping by domain instead would merge unrelated enquiries from a big
       customer, which is the worse failure. */
    const withColleague = [
      ...emails,
      mail("4", "deepak@betaco.test", "Re: Quote please", "2026-08-17T09:00:00Z"),
    ];
    expect(groupIntoThreads(withColleague)).toHaveLength(3);
  });

  it("handles an empty inbox", () => {
    expect(groupIntoThreads([])).toEqual([]);
  });
});

describe("threadFor", () => {
  it("finds the thread holding a given email, including a middle message", () => {
    const threads = groupIntoThreads([
      mail("1", "user1@betaco.test", "Quote please",     "2026-08-10T09:00:00Z"),
      mail("2", "user1@betaco.test", "Re: Quote please", "2026-08-17T08:00:00Z"),
    ]);
    expect(threadFor(threads, "1")?.messages).toHaveLength(2);
    expect(threadFor(threads, "2")?.messages).toHaveLength(2);
    expect(threadFor(threads, "nope")).toBeNull();
  });
});
