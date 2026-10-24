/**
 * R-1679: sales hears when a customer reaches an expired quote — opened, tried to accept, or asked
 * for a fresh one — once a day per event, through the same bell as "Quote accepted".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
const notify = vi.fn();
vi.mock("./notify.server", () => ({ notifyTenantOwners: (x: unknown) => notify(x) }));

import { expiredQuoteNotice, notifyQuoteExpired } from "./quote-expired.server";

function admin(recent: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "gte"]) chain[k] = () => chain;
  chain.limit = async () => ({ data: recent });
  return { from: () => chain } as never;
}

beforeEach(() => notify.mockReset());

describe("R-1679: expired quote → notification", () => {
  it("names the customer and the quote, and says what to do", () => {
    const n = expiredQuoteNotice("request", "Q-5F40-27-0096", "Sharma Traders");
    expect(n.title).toBe("Sharma Traders asked for a fresh quote — Q-5F40-27-0096 expired");
    expect(n.body).toMatch(/Revise or duplicate/);
    expect(expiredQuoteNotice("accept", "Q-1", "").title).toBe("The customer tried to accept expired quote Q-1");
  });

  it("goes to owner + manager as kind quote.expired, linking the quote", async () => {
    await notifyQuoteExpired({ admin: admin([]), tenantId: "t1", quoteId: "Q-1", customerName: "A", event: "opened" });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", kind: "quote.expired", href: "/quotes/Q-1", entityId: "Q-1" }));
  });

  it("not again within a day for the same event", async () => {
    await notifyQuoteExpired({ admin: admin([{ id: "n1" }]), tenantId: "t1", quoteId: "Q-1", customerName: "A", event: "opened" });
    expect(notify).not.toHaveBeenCalled();
  });
});
