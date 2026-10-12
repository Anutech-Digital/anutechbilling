import { describe, it, expect } from "vitest";
import { parseSearch, matchesSearch, isEmptySearch, type SearchableEmail } from "./search";

const email = (over: Partial<SearchableEmail> = {}): SearchableEmail => ({
  from_email:      "user1@betaco.test",
  from_name:       "testuser1 Rao",
  to_email:        "sales@anutech.in",
  subject:         "Renewal quote for 14 seats",
  body_text:       "We need Google Workspace renewed for 14 seats before August.",
  route:           "workspace",
  read_at:         null,
  starred:         false,
  attachment_name: null,
  ...over,
});

describe("parseSearch", () => {
  it("reads the operators a rep actually types", () => {
    const p = parseSearch("from:testuser1 is:unread label:workspace seats");
    expect(p.from).toEqual(["testuser1"]);
    expect(p.read).toBe(false);
    expect(p.label).toEqual(["workspace"]);
    expect(p.text).toEqual(["seats"]);
    expect(p.unknown).toEqual([]);
  });

  it("REPORTS an operator it does not support instead of dropping it", () => {
    /* The whole point. A box that silently ignores is:important returns every email
       and looks like it filtered — the rep reads the top twenty believing they are
       the important ones. */
    const p = parseSearch("is:important from:testuser1");
    expect(p.unknown).toEqual(["is:important"]);
    expect(p.from).toEqual(["testuser1"]);
  });

  it("does not smuggle an unknown operator in as free text", () => {
    /* Falling back to free text would match the literal string "is:important",
       which matches nothing and looks like "no results" rather than "not supported". */
    const p = parseSearch("is:important");
    expect(p.text).toEqual([]);
  });

  it("keeps quoted phrases together", () => {
    const p = parseSearch('from:"testuser1 Rao" "renewal quote"');
    expect(p.from).toEqual(["testuser1 rao"]);
    expect(p.text).toEqual(["renewal quote"]);
  });

  it("treats a bare email address as free text, not an operator", () => {
    /* Pasting an address into the box is the commonest thing a rep does. The colon
       check has to survive it. */
    const p = parseSearch("user1@betaco.test");
    expect(p.text).toEqual(["user1@betaco.test"]);
    expect(p.unknown).toEqual([]);
  });

  it("ignores a half-typed operator rather than widening the search", () => {
    /* `from:` with no value must not mean "any sender" — the rep is mid-keystroke
       and thinks they are narrowing. */
    const p = parseSearch("from: renewal");
    expect(p.from).toEqual([]);
    expect(p.text).toEqual(["renewal"]);
  });

  it("an empty box asks for nothing", () => {
    expect(isEmptySearch(parseSearch(""))).toBe(true);
    expect(isEmptySearch(parseSearch("   "))).toBe(true);
    expect(isEmptySearch(parseSearch("is:unread"))).toBe(false);
  });
});

describe("matchesSearch", () => {
  it("is:unread matches only never-opened mail", () => {
    expect(matchesSearch(email({ read_at: null }), parseSearch("is:unread"))).toBe(true);
    expect(matchesSearch(email({ read_at: "2026-08-17T00:00:00Z" }), parseSearch("is:unread"))).toBe(false);
  });

  it("is:read is the exact complement", () => {
    expect(matchesSearch(email({ read_at: "2026-08-17T00:00:00Z" }), parseSearch("is:read"))).toBe(true);
    expect(matchesSearch(email({ read_at: null }), parseSearch("is:read"))).toBe(false);
  });

  it("from: matches the sender's name as well as the address", () => {
    /* A rep types the name they remember, not the address they do not. */
    expect(matchesSearch(email(), parseSearch("from:testuser1"))).toBe(true);
    expect(matchesSearch(email(), parseSearch('from:"testuser1 rao"'))).toBe(true);
    expect(matchesSearch(email(), parseSearch("from:deepak"))).toBe(false);
  });

  it("two from: terms mean EITHER sender", () => {
    const p = parseSearch("from:testuser1 from:deepak");
    expect(matchesSearch(email(), p)).toBe(true);
  });

  it("two free-text terms mean BOTH", () => {
    /* "renewal quote" must not match an email that only says "renewal". */
    expect(matchesSearch(email(), parseSearch("renewal seats"))).toBe(true);
    expect(matchesSearch(email(), parseSearch("renewal invoice"))).toBe(false);
  });

  it("operators combine with AND", () => {
    expect(matchesSearch(email({ read_at: null }), parseSearch("from:testuser1 is:unread"))).toBe(true);
    expect(matchesSearch(email({ read_at: "2026-08-17T00:00:00Z" }), parseSearch("from:testuser1 is:unread"))).toBe(false);
  });

  it("has:attachment needs an actual attachment", () => {
    expect(matchesSearch(email(), parseSearch("has:attachment"))).toBe(false);
    expect(matchesSearch(email({ attachment_name: "bill.pdf" }), parseSearch("has:attachment"))).toBe(true);
  });

  it("label: matches the route and does not pattern-match the body", () => {
    /* The body says "Google Workspace". label:google must NOT match it — otherwise
       the folder fills with mail that merely mentions a vendor. */
    expect(matchesSearch(email(), parseSearch("label:workspace"))).toBe(true);
    expect(matchesSearch(email(), parseSearch("label:google"))).toBe(false);
  });

  it("free text still searches the body", () => {
    expect(matchesSearch(email(), parseSearch("august"))).toBe(true);
  });

  it("an unknown operator filters nothing", () => {
    /* It has been handed to the caller to display; applying it here would drop
       every row and read as "no results". */
    expect(matchesSearch(email(), parseSearch("is:important"))).toBe(true);
  });

  it("survives a row with nothing in it", () => {
    const blank: SearchableEmail = {
      from_email: null, from_name: null, to_email: null, subject: null,
      body_text: null, route: null, read_at: null, starred: null, attachment_name: null,
    };
    expect(matchesSearch(blank, parseSearch("is:unread"))).toBe(true);
    expect(matchesSearch(blank, parseSearch("anything"))).toBe(false);
  });
});
