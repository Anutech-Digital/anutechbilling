import { describe, it, expect } from "vitest";
import { buildBulkLine, dedupeDomains, splitMrr, normDomain, bulkDomainProblems } from "./bulk";

describe("dedupeDomains", () => {
  it("lowercases, trims, drops blanks", () => {
    const out = dedupeDomains([
      { domain: " Acme.COM ", seats: 5 },
      { domain: "", seats: 9 },
      { domain: "https://www.foo.in/path", seats: 2 },
    ]);
    expect(out).toEqual([
      { domain: "acme.com", seats: 5 },
      { domain: "foo.in", seats: 2 },
    ]);
  });

  it("merges duplicate domains by summing seats (prevents index collision)", () => {
    const out = dedupeDomains([
      { domain: "acme.com", seats: 5 },
      { domain: "ACME.com", seats: 3 },
    ]);
    expect(out).toEqual([{ domain: "acme.com", seats: 8 }]);
  });
});

describe("buildBulkLine", () => {
  const plan = { id: "line-1", item_id: "itm-gws", name: "Google Workspace Business Starter", cost: 2000 };

  it("sets qty = sum of seats and marks bulk", () => {
    const line = buildBulkLine(plan, 3240, [
      { domain: "a.com", seats: 5 },
      { domain: "b.in", seats: 3 },
      { domain: "c.io", seats: 2 },
    ]);
    expect(line.bulk).toBe(true);
    expect(line.qty).toBe(10);
    expect(line.rate).toBe(3240);
    expect(line.cost).toBe(2000);
    expect(line.commitment).toBe("annual_yearly");
    expect(line.domains).toHaveLength(3);
  });

  it("dedupes domains inside the line", () => {
    const line = buildBulkLine(plan, 3240, [
      { domain: "a.com", seats: 5 },
      { domain: "a.com", seats: 5 },
    ]);
    expect(line.domains).toEqual([{ domain: "a.com", seats: 10 }]);
    expect(line.qty).toBe(10);
  });

  it("normDomain handles protocol + www + path", () => {
    expect(normDomain("HTTPS://WWW.Foo.com/x/y")).toBe("foo.com");
  });
});

describe("splitMrr — money-correctness (sum must equal pool exactly)", () => {
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

  it("sums to pool for an indivisible pool", () => {
    const domains = [
      { domain: "a", seats: 5 },
      { domain: "b", seats: 3 },
      { domain: "c", seats: 2 },
    ];
    const pool = 100000; // ₹/mo in paise-like integer
    const shares = splitMrr(pool, domains);
    expect(sum(shares)).toBe(pool);
    expect(shares.every((s) => s >= 0)).toBe(true);
  });

  it("sums to pool for 1000 domains × 1 seat with a prime-ish pool", () => {
    const domains = Array.from({ length: 1000 }, (_, i) => ({ domain: `d${i}.com`, seats: 1 }));
    const pool = 999983; // prime → forces remainder onto the last domain
    const shares = splitMrr(pool, domains);
    expect(shares).toHaveLength(1000);
    expect(sum(shares)).toBe(pool);
    expect(shares.every((s) => s >= 0)).toBe(true);
  });

  it("uneven seats still sum exactly", () => {
    const domains = [
      { domain: "a", seats: 7 },
      { domain: "b", seats: 11 },
      { domain: "c", seats: 13 },
      { domain: "d", seats: 1 },
    ];
    const pool = 123457;
    expect(sum(splitMrr(pool, domains))).toBe(pool);
  });

  it("single domain gets the whole pool", () => {
    expect(splitMrr(54321, [{ domain: "a", seats: 9 }])).toEqual([54321]);
  });

  it("pool 0 or empty domains yields zeros / empty", () => {
    expect(splitMrr(0, [{ domain: "a", seats: 5 }])).toEqual([0]);
    expect(splitMrr(1000, [])).toEqual([]);
    // zero total seats → no divide-by-zero, all zeros
    expect(splitMrr(1000, [{ domain: "a", seats: 0 }])).toEqual([0]);
  });
});

describe("bulkDomainProblems (R-469 (3))", () => {
  it("refuses a name that is not a domain", () => {
    expect(bulkDomainProblems([{ domain: "kapoor global" }, { domain: "kapoor.com" }]).invalid).toEqual(["kapoor global"]);
  });
  it("flags the same domain typed twice", () => {
    expect(bulkDomainProblems([{ domain: "kapoor.com" }, { domain: "https://www.Kapoor.com/" }]).duplicates).toEqual(["kapoor.com"]);
  });
  it("passes clean rows and ignores empty ones", () => {
    expect(bulkDomainProblems([{ domain: "a.in" }, { domain: "b.co.in" }, { domain: " " }])).toEqual({ invalid: [], duplicates: [] });
  });
});
