/**
 * R-1445 — a domain line paid for several years (Pratik, staging 16 Oct: "client paid for 3
 * years, the picker offers nothing above 1 year"). Picking 3 years makes the line's price the
 * price for all 3 years (price x years), and a catalogue domain item gets the picker even when
 * its name does not say "domain".
 */
import { describe, it, expect } from "vitest";
import { lineForYears, isTermLine } from "./domain-term";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

const base: QuoteLineItem = { id: "l1", item_id: "dom-in", name: ".in", qty: 1, rate: 800, list_rate: 900, cost: 650 };

describe("R-1445 lineForYears: price x years", () => {
  it("1 -> 3 years triples rate, list rate and cost", () => {
    const l = lineForYears(base, 3);
    expect(l).toMatchObject({ years: 3, rate: 2400, list_rate: 2700, cost: 1950 });
  });
  it("3 -> 2 years goes back through the yearly price (whole rupees)", () => {
    const l = lineForYears(lineForYears({ ...base, rate: 999 }, 3), 2);
    expect(l.years).toBe(2);
    expect(l.rate).toBe(1998);
  });
  it("back to 1 year drops the field and restores the yearly price", () => {
    const l = lineForYears(lineForYears(base, 5), 1);
    expect(l.years).toBeUndefined();
    expect(l.rate).toBe(800);
    expect(l.cost).toBe(650);
  });
  it("out-of-range years are clamped to 1..10", () => {
    expect(lineForYears(base, 12).years).toBe(10);
    expect(lineForYears(base, 0).years).toBeUndefined();
  });
  it("a line without list_rate does not grow one", () => {
    const { list_rate: _drop, ...noList } = base;
    void _drop;
    expect(lineForYears(noList, 2).list_rate).toBeUndefined();
  });
});

describe("R-1445 isTermLine: who gets the 'Register for' picker", () => {
  const domainIds = new Set(["dom-in"]);
  it("a catalogue item from the Domain vendor, whatever its name", () => {
    expect(isTermLine(base, domainIds)).toBe(true);
  });
  it("a line named 'Domain registration' (existing rule)", () => {
    expect(isTermLine({ ...base, item_id: undefined, name: "Domain registration acme.in" }, new Set())).toBe(true);
  });
  it("a Workspace line is not", () => {
    expect(isTermLine({ ...base, item_id: "gw", name: "Google Workspace Starter", domain: "acme.in" }, domainIds)).toBe(false);
  });
  it("a bulk line is not", () => {
    expect(isTermLine({ ...base, bulk: true }, domainIds)).toBe(false);
  });
});
