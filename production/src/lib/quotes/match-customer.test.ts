import { describe, it, expect } from "vitest";
import { matchLeadToCustomer, matchNote, type MatchableCustomer } from "./match-customer";

/** ANUTECH's four real customers. */
const BOOK: MatchableCustomer[] = [
  { id: "c-betaco", name: "BETA CO PROJECTS PRIVATE LIMITED", contact_email: "accounts@betaco.test" },
  { id: "c-democo",   name: "Demo Co",  contact_email: "pardeep@example.test" },
  { id: "c-jijo",    name: "Jijo corprotion",     contact_email: "jijo@example.in" },
  { id: "c-ab",      name: "AB corprotion",       contact_email: null },
];

/**
 * ─── THE REPORTED BUG, AND WHY IT WAS TWO BUGS ──────────────────────────────
 * "Send Quote" on a lead opened the builder on the Existing customer tab with an empty
 * dropdown. Two different faults, one symptom: a lead that IS a customer was not looked
 * up, and a lead that is NOT one had nothing to select — the form sat on a tab that could
 * never be satisfied.
 */
describe("a lead that is already a customer", () => {
  it("is found by email, which is the near-identifier", () => {
    const m = matchLeadToCustomer(
      { company: "Demo Co", contactEmail: "pardeep@example.test" }, BOOK);
    expect(m).toEqual({ kind: "email", customerId: "c-democo" });
  });

  it("is found by email even when the company name was typed differently", () => {
    /* The whole point of preferring email: names drift, addresses do not. */
    const m = matchLeadToCustomer(
      { company: "DEMO CO PVT LTD", contactEmail: "pardeep@example.test" }, BOOK);
    expect(m.kind).toBe("email");
  });

  it("ignores case and stray spacing in the address", () => {
    expect(matchLeadToCustomer(
      { contactEmail: "  Pardeep@example.test " }, BOOK).kind).toBe("email");
  });

  it("falls back to an EXACT name match when there is no email", () => {
    const m = matchLeadToCustomer({ company: "AB corprotion" }, BOOK);
    expect(m).toEqual({ kind: "name", customerId: "c-ab" });
  });

  it("normalises punctuation and case on the name", () => {
    expect(matchLeadToCustomer({ company: "  ab   CORPROTION " }, BOOK).kind).toBe("name");
  });
});

/**
 * ─── WHAT IT REFUSES TO MATCH ───────────────────────────────────────────────
 * Selecting the wrong customer silently addresses a quote — and later an invoice — to
 * somebody else. That is worse than making the operator pick.
 */
describe("what it will not guess", () => {
  it("returns none for a lead nobody in the book is", () => {
    /* "Demo1 Company" — the live case. Stage `contact`, and none of the four customers is
       it. The caller must open the New prospect tab, not an empty dropdown. */
    const m = matchLeadToCustomer(
      { company: "Demo1 Company", contactEmail: "hb1@example.test" }, BOOK);
    expect(m.kind).toBe("none");
  });

  it("does NOT match on a shared email DOMAIN", () => {
    /* hb1@example.test and pardeep@example.test are the same company and
       different people — and on this tenant, a domain-based guess is exactly the mistake
       that produced a duplicate workspace (CLAUDE.md §4a). */
    const m = matchLeadToCustomer({ contactEmail: "hb1@example.test" }, BOOK);
    expect(m.kind).toBe("none");
  });

  it("is NOT fuzzy on names", () => {
    for (const near of ["Demo Cos", "Demo Co Ltd", "Demo"]) {
      expect(matchLeadToCustomer({ company: near }, BOOK).kind).toBe("none");
    }
  });

  it("refuses when TWO customers normalise to the same name", () => {
    /* Ambiguity is precisely where a machine must not choose. */
    const twins = [...BOOK,
      { id: "c-ab2", name: "AB Corprotion", contact_email: null }];
    expect(matchLeadToCustomer({ company: "AB corprotion" }, twins).kind).toBe("none");
  });

  it("handles an empty book, and a lead with nothing on it", () => {
    expect(matchLeadToCustomer({ company: "Anything" }, []).kind).toBe("none");
    expect(matchLeadToCustomer({}, BOOK).kind).toBe("none");
    expect(matchLeadToCustomer({ company: "  ", contactEmail: "" }, BOOK).kind).toBe("none");
  });

  it("does not match a customer whose own email is null against a blank lead email", () => {
    /* "" === "" would otherwise pair every emailless lead with AB corprotion. */
    expect(matchLeadToCustomer({ company: "Nobody", contactEmail: "" }, BOOK).kind).toBe("none");
  });
});

describe("the note explaining a preselection", () => {
  it("says how the match was made, because an unexplained one must be re-checked", () => {
    expect(matchNote({ kind: "email", customerId: "x" })).toMatch(/by email/);
    expect(matchNote({ kind: "name", customerId: "x" }, "AB corprotion")).toMatch(/AB corprotion/);
  });

  it("asks the operator to confirm a NAME match, which is the weaker one", () => {
    expect(matchNote({ kind: "name", customerId: "x" }, "AB corprotion"))
      .toMatch(/check it is the same business/);
  });

  it("says nothing when nothing was matched", () => {
    expect(matchNote({ kind: "none" })).toBeNull();
  });
});
