import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostingLimitProblem, hostingLimitWarning } from "./hosting-limit";
import { isSingleUnit } from "@/site/lib/money";

describe("one hosting account per hosting line", () => {
  it("allows one plan, and any number of non-hosting lines", () => {
    expect(hostingLimitProblem([{ sku: "hosting:starter", qty: 1 }, { sku: "domain:in", qty: 1 }, { sku: "domain:com", qty: 1 }])).toBeNull();
    expect(hostingLimitProblem([{ sku: "domain:in", qty: 1 }])).toBeNull();
    expect(hostingLimitProblem([])).toBeNull();
  });
  it("several plans are one order (R-032, 1 Oct 2026)", () => {
    expect(hostingLimitProblem([{ sku: "hosting:starter", qty: 1 }, { sku: "hosting:plus", qty: 1 }, { sku: "hosting:starter", qty: 1 }])).toBeNull();
    expect(hostingLimitWarning([{ sku: "hosting:starter", qty: 1 }, { sku: "hosting:plus", qty: 1 }])).toBeNull();
  });
  it("refuses one plan with quantity above 1, saying what to do and that nothing was charged", () => {
    const m = hostingLimitProblem([{ sku: "hosting:standard", qty: 3 }]);
    expect(m).toMatch(/quantity 3/);
    expect(m).toMatch(/add the plan once for each website/);
    expect(m).toMatch(/Nothing was charged/);
    expect(hostingLimitWarning([{ sku: "hosting:standard", qty: 2 }])).toMatch(/quantity 2.*once for each website/);
  });
  it("no longer says an order can set up only one hosting account (removed 9 Oct 2026)", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/checkout/hosting-limit.ts"), "utf8");
    expect(src).not.toMatch(/only one hosting account for now|separate order for the next one/);
    expect(src).not.toMatch(/SEVERAL_HOSTING_PLANS_READY\s*=/);
  });
  it("is not fooled by a trial line (a trial checks out on its own and is not hosting:)", () => {
    expect(hostingLimitProblem([{ sku: "hosting-trial:starter", qty: 1 }, { sku: "hosting:starter", qty: 1 }])).toBeNull();
  });
});

describe("the cart shows no quantity stepper on a hosting plan", () => {
  it("hosting, trial and domain lines are single-unit; other lines are not", () => {
    expect(isSingleUnit({ sku: "hosting:starter" })).toBe(true);
    expect(isSingleUnit({ sku: "hosting-trial:starter" })).toBe(true);
    expect(isSingleUnit({ sku: "domain:in" })).toBe(true);
    expect(isSingleUnit({ sku: "mailbox:anutech" })).toBe(false);
  });
});

describe("wiring", () => {
  it("checkout refuses before pricing, so nothing is saved or charged", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/checkout/cart-checkout.ts"), "utf8");
    const guard = src.indexOf("hostingLimitProblem(lines)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("await priceDomainLines(lines)"));
  });
});
