/**
 * R-726: the support bot matched the sender with `.ilike("contact_email", contact)` at
 * src/lib/ai/support-agent.server.ts:138 (manager-pardeep 514efbdb). A sender address of
 * "%@victimco.com" is a LIKE pattern there, so it matched a real customer and the bot told a
 * stranger that customer's domains, seats, renewal dates and MRR. A plainly spoofed From did
 * the same, because nothing asked whether the mail really came from that address.
 *
 * Now: the address is matched exactly (case-insensitive, LIKE wildcards escaped), and an email
 * sender is only looked up when the forwarder proved the From domain (sender-auth.ts).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/bare", () => ({ createBareClient: () => null }));
vi.mock("./gemini", () => ({ resolveGeminiConfig: vi.fn(), geminiJson: vi.fn() }));

import { loadSupportCustomerFacts, escapeLikePattern } from "./support-agent.server";

type Call = { table: string; method: string; args: unknown[] };

/** A fake admin client: records every filter, answers the customers read with `customer`. */
function fakeAdmin(customer: Record<string, unknown> | null) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    const chain = (method: string) => (...args: unknown[]) => {
      calls.push({ table, method, args });
      return b;
    };
    for (const m of ["select", "eq", "ilike", "or", "limit", "neq", "order"]) b[m] = chain(m);
    b.maybeSingle = async () => ({ data: table === "customers" ? customer : null, error: null });
    b.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
    return b;
  };
  return { admin: { from } as never, calls };
}

const VICTIM = { id: "cust-1", name: "Victim Co", display_name: null, contact_email: "ceo@victimco.com" };
const base = { tenantId: "t1", channel: "email" as const, fallbackName: "", ticketId: null, tier: null };

describe("R-726: support bot identifies the sender exactly", () => {
  it("escapes LIKE wildcards so '%@victimco.com' can only match that literal text", () => {
    expect(escapeLikePattern("%@victimco.com")).toBe("\\%@victimco.com");
    expect(escapeLikePattern("a_b@x.in")).toBe("a\\_b@x.in");
    expect(escapeLikePattern("a\\b@x.in")).toBe("a\\\\b@x.in");
  });

  it("never sends a raw wildcard to the customers lookup (support-agent.server.ts:138)", async () => {
    const { admin, calls } = fakeAdmin(null);
    /* `_` is legal in a mailbox name but is a one-character LIKE wildcard: it must go escaped. */
    await loadSupportCustomerFacts({ ...base, admin, customerContact: "a_b@victimco.com", senderVerified: true });
    const lookup = calls.find((c) => c.table === "customers" && c.method === "ilike");
    expect(lookup?.args).toEqual(["contact_email", "a\\_b@victimco.com"]);
  });

  it.each(["%@victimco.com", "*@victimco.com", "ceo@victim_o.com", "a@x.in,b@y.in"])(
    "refuses a pattern-looking sender %s outright — no lookup, no customer facts",
    async (sender) => {
      /* `*` too: our PostgREST gateway turns `*` into `%` (server/postgrest/build.ts:70). */
      const { admin, calls } = fakeAdmin(VICTIM); // even if the DB answered, the sender is not an address
      const facts = await loadSupportCustomerFacts({ ...base, admin, customerContact: sender, senderVerified: true });
      expect(facts.customerId).toBeNull();
      expect(facts.subscriptions).toEqual([]);
      expect(calls.filter((c) => c.table === "customers")).toEqual([]);
    },
  );

  it("an unverified email sender (spoofed From) gets no account facts and no lookup", async () => {
    const { admin, calls } = fakeAdmin(VICTIM);
    const facts = await loadSupportCustomerFacts({ ...base, admin, customerContact: "ceo@victimco.com", senderVerified: false });
    expect(facts.customerId).toBeNull();
    expect(calls.filter((c) => c.table === "customers")).toEqual([]);
  });

  it("a verified sender with the exact address (any case) is still recognised", async () => {
    const { admin, calls } = fakeAdmin(VICTIM);
    const facts = await loadSupportCustomerFacts({ ...base, admin, customerContact: "CEO@VictimCo.com", senderVerified: true });
    expect(facts.customerId).toBe("cust-1");
    expect(calls.find((c) => c.method === "ilike")?.args).toEqual(["contact_email", "ceo@victimco.com"]);
  });

  it("WhatsApp senders (Meta-signed webhook) are still matched by phone", async () => {
    const { admin } = fakeAdmin(VICTIM);
    const facts = await loadSupportCustomerFacts({
      ...base, channel: "whatsapp", admin, customerContact: "+919812345678", senderVerified: true,
    });
    expect(facts.customerId).toBe("cust-1");
  });
});
