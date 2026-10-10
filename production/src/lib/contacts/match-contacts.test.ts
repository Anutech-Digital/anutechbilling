import { describe, it, expect } from "vitest";
import { matchContacts } from "./match-contacts";

const pool = [
  { id: "1", full_name: "Gautam Sharma", email: "gautam@acme.in" },
  { id: "2", full_name: "Rohit Verma", email: "rohit@beta.in" },
  { id: "3", full_name: "Anil Gautam", email: "anil@gamma.in" },
  { id: "4", full_name: "Gautam", email: "g@delta.in" },
  { id: "5", full_name: null, email: "nobody@acme.in" },
];
const ids = (r: { id: string }[]) => r.map((p) => p.id);

describe("matchContacts (R-825)", () => {
  it("does not suggest Gautam Sharma for 'Utkarsh Sharma' (shared surname only)", () => {
    expect(ids(matchContacts(pool, "Utkarsh Sharma", ""))).toEqual([]);
  });

  it("'Gautam' returns Gautam Sharma", () => {
    expect(ids(matchContacts(pool, "Gautam", ""))).toContain("1");
  });

  it("'gau sha' (word prefixes) returns Gautam Sharma only", () => {
    expect(ids(matchContacts(pool, "gau sha", ""))).toEqual(["1"]);
  });

  it("an existing email returns its owner, even with an unrelated name typed", () => {
    expect(ids(matchContacts(pool, "Utkarsh Sharma", "gautam@acme.in"))).toEqual(["1"]);
    expect(ids(matchContacts(pool, "", "ROHIT@beta.in"))).toEqual(["2"]);
  });

  it("an email prefix of 3+ chars matches; shorter does not", () => {
    expect(ids(matchContacts(pool, "", "nob"))).toEqual(["5"]);
    expect(ids(matchContacts(pool, "", "no"))).toEqual([]);
  });

  it("an email typed into the name box still finds its owner", () => {
    expect(ids(matchContacts(pool, "rohit@beta.in", ""))).toEqual(["2"]);
  });

  it("ranks exact name > starts with > all words match > email", () => {
    const rankPool = [
      { id: "email", full_name: "Zed Person", email: "gautam.x@acme.in" },
      { id: "words", full_name: "Anil Gautam", email: null },
      { id: "starts", full_name: "Gautam Sharma", email: null },
      { id: "exact", full_name: "Gautam", email: null },
    ];
    expect(ids(matchContacts(rankPool, "gautam", "gautam"))).toEqual([
      "exact", "starts", "words", "email",
    ]);
  });

  it("returns at most 6", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), full_name: `Amit ${i}`, email: null }));
    expect(matchContacts(many, "amit", "")).toHaveLength(6);
  });

  it("returns nothing for a one-letter query", () => {
    expect(matchContacts(pool, "g", "")).toEqual([]);
  });
});
