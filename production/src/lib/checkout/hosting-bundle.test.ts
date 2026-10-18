/**
 * R-1595: what a yearly hosting plan brings free — the domain it is set up on (a common TLD
 * only) and one mailbox, per yearly plan (Pardeep, 18 Oct 2026).
 */
import { describe, it, expect } from "vitest";
import { bundleAllowance, freeDomainEligible, FREE_DOMAIN_TLDS, FREE_DOMAIN_TLDS_LABEL } from "./hosting-bundle";

const yearly = (domain: string | null) => ({ yearly: true, domain });
const monthly = (domain: string | null) => ({ yearly: false, domain });
const free = (r: ReturnType<typeof bundleAllowance>) => [...r.freeDomains].sort();

describe("FREE_DOMAIN_TLDS", () => {
  it("is Pardeep's list, in one place", () => {
    expect([...FREE_DOMAIN_TLDS]).toEqual(["com", "in", "net", "org", "co.in"]);
    expect(FREE_DOMAIN_TLDS_LABEL).toBe(".com / .in / .net / .org / .co.in");
  });

  it("common TLDs qualify, costly ones do not", () => {
    for (const d of ["a.com", "a.in", "a.net", "a.org", "a.co.in", ".in", "co.in", "A.COM"]) expect(freeDomainEligible(d), d).toBe(true);
    for (const d of ["a.ai", "a.io", "a.co", "a.xyz", ".ai", "a.comx", "a.in.ai"]) expect(freeDomainEligible(d), d).toBe(false);
  });
});

describe("bundleAllowance", () => {
  it("no hosting: nothing free", () => {
    expect(free(bundleAllowance([], ["a.in", "b.in"], 5))).toEqual([]);
    expect(bundleAllowance([], ["a.in"], 5).freeMailboxes).toBe(0);
  });

  it("monthly hosting: nothing free", () => {
    const r = bundleAllowance([monthly("a.in")], ["a.in"], 1);
    expect(free(r)).toEqual([]);
    expect(r.freeMailboxes).toBe(0);
  });

  it("one yearly plan frees its own domain, wherever it sits in the cart", () => {
    expect(free(bundleAllowance([yearly("c.in")], ["a.in", "b.in", "c.in"], 0))).toEqual([2]);
  });

  it("a plan on a domain not in the cart frees nothing", () => {
    expect(free(bundleAllowance([yearly("mine.in")], ["a.in", "b.in"], 0))).toEqual([]);
    expect(free(bundleAllowance([yearly(null)], ["a.in", "b.in"], 0))).toEqual([]);
  });

  it("a plan on a costly TLD frees nothing, but still brings its mailbox", () => {
    const r = bundleAllowance([yearly("a.ai")], ["a.ai"], 3);
    expect(free(r)).toEqual([]);
    expect(r.freeMailboxes).toBe(1);
  });

  it("one mailbox per yearly plan, never more than are in the cart", () => {
    expect(bundleAllowance([yearly("a.in")], [], 50).freeMailboxes).toBe(1);
    expect(bundleAllowance([yearly("a.in"), yearly("b.in")], [], 50).freeMailboxes).toBe(2);
    expect(bundleAllowance([yearly("a.in"), yearly("b.in")], [], 1).freeMailboxes).toBe(1);
    expect(bundleAllowance([yearly("a.in")], [], 0).freeMailboxes).toBe(0);
    expect(bundleAllowance([monthly("a.in"), yearly("b.in")], [], 5).freeMailboxes).toBe(1);
  });

  it("two yearly plans: each frees only its own domain", () => {
    expect(free(bundleAllowance([yearly("b.in"), yearly("a.in")], ["a.in", "b.in", "c.in"], 0))).toEqual([0, 1]);
    expect(free(bundleAllowance([yearly("mine.in"), yearly("b.in")], ["a.in", "b.in", "c.in"], 0))).toEqual([1]);
  });
});
