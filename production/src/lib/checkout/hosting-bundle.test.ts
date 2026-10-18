/** R-1595: what a yearly hosting plan brings free — one domain, one mailbox, per yearly plan. */
import { describe, it, expect } from "vitest";
import { bundleAllowance } from "./hosting-bundle";

const yearly = (domain: string | null) => ({ yearly: true, domain });
const monthly = (domain: string | null) => ({ yearly: false, domain });
const free = (r: ReturnType<typeof bundleAllowance>) => [...r.freeDomains].sort();

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

  it("one yearly plan on a domain not in the cart frees the first cart domain only", () => {
    expect(free(bundleAllowance([yearly("mine.in")], ["a.in", "b.in"], 0))).toEqual([0]);
    expect(free(bundleAllowance([yearly(null)], ["a.in", "b.in"], 0))).toEqual([0]);
  });

  it("one mailbox per yearly plan, never more than are in the cart", () => {
    expect(bundleAllowance([yearly("a.in")], [], 50).freeMailboxes).toBe(1);
    expect(bundleAllowance([yearly("a.in"), yearly("b.in")], [], 50).freeMailboxes).toBe(2);
    expect(bundleAllowance([yearly("a.in"), yearly("b.in")], [], 1).freeMailboxes).toBe(1);
    expect(bundleAllowance([yearly("a.in")], [], 0).freeMailboxes).toBe(0);
  });

  it("two yearly plans: each its own domain; a plan off-cart takes the first one left", () => {
    expect(free(bundleAllowance([yearly("b.in"), yearly("a.in")], ["a.in", "b.in", "c.in"], 0))).toEqual([0, 1]);
    expect(free(bundleAllowance([yearly("mine.in"), yearly("b.in")], ["a.in", "b.in", "c.in"], 0))).toEqual([0, 1]);
  });

  it("a plan's own domain is never taken by another plan first", () => {
    // The off-cart plan comes first in cart order but must not grab b.in from the plan on b.in.
    expect(free(bundleAllowance([yearly("mine.in"), yearly("b.in")], ["b.in"], 0))).toEqual([0]);
  });
});
