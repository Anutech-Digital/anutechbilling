import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mayDo, forbiddenMessage, ACTION_ROLES } from "./action-roles";
import { MONEY_RECORD_ROLES } from "./roles";

describe("mayDo (S19)", () => {
  it("seats: owner, manager, billing — not sales, support, delivery, accountant", () => {
    for (const r of ["owner", "manager", "billing"]) expect(mayDo(r, "seats.change")).toBe(true);
    for (const r of ["sales", "sales_senior", "support", "delivery", "accountant", "partner_agent"]) expect(mayDo(r, "seats.change")).toBe(false);
  });
  it("campaigns and imports: owner and manager only", () => {
    expect(mayDo("manager", "campaign.send")).toBe(true);
    expect(mayDo("sales", "campaign.send")).toBe(false);
    expect(mayDo("support", "contacts.import")).toBe(false);
  });
  it("no role → no", () => {
    expect(mayDo(null, "seats.change")).toBe(false);
    expect(mayDo("nonsense", "integration.company")).toBe(false);
  });
  it("the message names who can", () => {
    expect(forbiddenMessage("seats.change")).toBe("Only Owner, Manager, Billing can change seats or subscription terms. Ask one of them to do it.");
  });
});

/* Every guarded route actually calls the guard — a route that forgets it is the bug S19 fixed. */
const ROUTES: [string, keyof typeof ACTION_ROLES][] = [
  ["app/api/subscriptions/[id]/add-seats/route.ts", "seats.change"],
  ["app/api/subscriptions/[id]/extend/route.ts", "seats.change"],
  ["app/api/seat-requests/[id]/decide/route.ts", "seats.change"],
  ["app/api/campaigns/send/route.ts", "campaign.send"],
  ["app/api/contacts/import/route.ts", "contacts.import"],
  ["app/api/integrations/google-ads/connect/route.ts", "integration.company"],
  ["app/api/integrations/google-business/connect/route.ts", "integration.company"],
  ["app/api/integrations/meta-ads/connect/route.ts", "integration.company"],
  /* R-880 */
  ["app/api/quotes/[id]/raise-instalments/route.ts", "money.record"],
  ["app/api/payments/[id]/receipt/route.ts", "money.record"],
  ["app/api/quotes/[id]/mark-accepted/route.ts", "quote.accept"],
  ["app/api/documents/route.ts", "vault.upload"],
  ["app/api/support/tickets/route.ts", "support.update"],
];

describe("R-880 money.record is R-718's table", () => {
  it("same roles as MONEY_RECORD_ROLES — one list, never two that drift", () => {
    expect([...ACTION_ROLES["money.record"]].sort()).toEqual([...MONEY_RECORD_ROLES].sort());
  });
  it("multi-word roles read as words in the 403", () => {
    expect(forbiddenMessage("quote.accept")).toBe("Only Owner, Manager, Sales senior, Sales, Billing can mark a quote accepted. Ask one of them to do it.");
  });
});
describe("guarded routes call mayDo", () => {
  for (const [file, action] of ROUTES) {
    it(`${file} → ${action}`, () => {
      const src = readFileSync(join(process.cwd(), "src", file), "utf8");
      /* R-217: a route on withRoute() passes the same list as `roles: ACTION_ROLES["x"]`. */
      const viaWithRoute = src.includes(`roles: ACTION_ROLES["${action}"]`) && /export const POST = withRoute\(/.test(src);
      expect(viaWithRoute || src.includes(`mayDo(`)).toBe(true);
      expect(src).toContain(`"${action}"`);
    });
  }
});
