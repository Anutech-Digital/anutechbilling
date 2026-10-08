import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buyNowSchema } from "@/app/(public)/buy/workspace/buy-now-schema";

/* R-173 (6 Oct 2026). The Google Workspace "Buy now" path never collected the buyer's state and
   never wrote one to the lead, so record_payment created a customer with no state_code and
   generate_invoice refused its GST invoice ("no state on record"). These pin both halves: the
   page asks for it, the route refuses before saving or charging, and the lead carries it. */
const route = readFileSync(join(process.cwd(), "src/app/api/public/checkout/workspace/route.ts"), "utf8");
const page = readFileSync(join(process.cwd(), "src/app/(public)/buy/workspace/buy-workspace-client.tsx"), "utf8");
/* R-280: R-226 moved the form rules out of the client into buy-now-schema.ts. */
const schemaSrc = readFileSync(join(process.cwd(), "src/app/(public)/buy/workspace/buy-now-schema.ts"), "utf8");

const base = {
  fullName: "Asha Rao", email: "asha@acme.in", phone: "9876543210", seats: 5,
  domain: "acme.in", tierId: "business-starter", agreeTerms: true,
};
const stateIssue = (v: Record<string, unknown>) => {
  const r = buyNowSchema.safeParse(v);
  return r.success ? undefined : r.error.issues.find((i) => i.path[0] === "stateCode");
};

describe("Workspace Buy now — buyer state (R-173)", () => {
  it("the route resolves the state like the cart checkout and refuses without one", () => {
    expect(route).toMatch(/resolveStateCode\(\{ stateCode: stateCodeFromName\(parsed\.data\.stateCode\), gstin: validGstin \}\)/);
    expect(route).toMatch(/if \(!buyerStateCode\) \{[\s\S]{0,400}needState: true/);
  });

  it("the refusal comes before the lead is saved (nothing half-created, nothing charged)", () => {
    expect(route.indexOf("needState: true")).toBeGreaterThan(-1);
    expect(route.indexOf("needState: true")).toBeLessThan(route.indexOf('from("leads").insert'));
  });

  it("the lead carries state_code, state and only a valid GSTIN — record_payment copies them", () => {
    expect(route).toMatch(/state_code:\s+buyerStateCode,/);
    expect(route).toMatch(/state:\s+buyerState,/);
    expect(route).toMatch(/gstin:\s+validGstin,/);
  });

  it("the Buy now form has a required state select unless a valid GSTIN gives it", () => {
    expect(page).toMatch(/htmlFor="buy-state"/);
    expect(page).toMatch(/zodResolver\(buyNowSchema\)/);
    expect(schemaSrc).toMatch(/if \(!v\.stateCode && !stateCodeFromGstin\(v\.gstin\)\)/);
  });

  it("the schema refuses a buyer with no state and no GSTIN, accepts a picked state", () => {
    expect(stateIssue(base)?.message).toMatch(/state/i);
    expect(stateIssue({ ...base, stateCode: "29" })).toBeUndefined();
  });
});
