/**
 * R-1956: POST /api/quotes/:id/mark-sent — the path "Copy link instead" (refused-send toast),
 * "Copy customer link" on a draft and "Mark as sent" all use.
 *
 * Owner's path (coordinator's localhost check, 26 Oct 2026): customer messages OFF → Send via
 * email is refused → the quote stays a DRAFT → "Copy link instead" copied a link the accept
 * page answers with notFound(). Now: mark sent (approval gate respected) → the accept page's
 * own rule (publicQuoteVisible) opens that token.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { newFakeDb, fakeServerModule, signInAs, TENANT_A, TENANT_B, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
}));

import { POST } from "./route";
import { publicQuoteVisible } from "@/app/(public)/quote/[id]/accept/visibility";

const TOKEN = "tok-0123456789abcdef";
const call = () => POST(new Request("http://x/api/quotes/Q-1/mark-sent", { method: "POST" }), { params: Promise.resolve({ id: "Q-1" }) });

/** A plain quote: list price, a known vendor cost, 50% margin — needs nobody's sign-off. */
const okLines = [{ qty: 1, rate: 1000, list_rate: 1000, cost: 500, discount_pct: 0, description: "Workspace" }];
/** 20% under list — over the auto-approve line, so it waits for a manager. */
const discountedLines = [{ qty: 1, rate: 800, list_rate: 1000, cost: 500, discount_pct: 0, description: "Workspace" }];

function quoteRow(over: Record<string, unknown> = {}) {
  return {
    id: "Q-1", tenant_id: TENANT_A, status: "draft", public_token: TOKEN, lead_id: null,
    line_items: okLines, approval_status: null, approval_tier: null, approval_requested_by: null,
    approved_by: null, approved_discount_bps: null, approved_margin_bps: null, approval_rejection_reason: null,
    ...over,
  };
}

beforeEach(() => {
  h.db = newFakeDb();
});

describe("R-1956: refused send → Copy link instead → the link opens", () => {
  it("draft after a refused send: marked sent, and the accept page shows that token (was notFound)", async () => {
    signInAs(h.db, "owner");
    h.db.tables.quotes = [quoteRow()];
    // Before: what the coordinator saw — the copied link is dead.
    expect(publicQuoteVisible(h.db.tables.quotes[0] as never, TOKEN)).toBe(false);

    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quoteStatus: "sent", changed: true, leadMoved: false, leadReason: null });
    expect(h.db.tables.quotes[0].status).toBe("sent");
    // After: the accept page's own rule opens it for the right token, and still not for a wrong one.
    expect(publicQuoteVisible(h.db.tables.quotes[0] as never, TOKEN)).toBe(true);
    expect(publicQuoteVisible(h.db.tables.quotes[0] as never, "wrong")).toBe(false);
  });

  it("approval gate blocks: 409 with the gate's reason, the quote stays a draft, the link stays closed", async () => {
    signInAs(h.db, "sales");
    h.db.tables.quotes = [quoteRow({ line_items: discountedLines })];
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/^Needs approval first — /);
    expect(body.reason).toMatch(/Discount is 20/);
    expect(h.db.tables.quotes[0].status).toBe("draft");
    expect(h.db.writes.filter(([, t, op]) => t === "quotes" && op === "update")).toHaveLength(0);
    expect(publicQuoteVisible(h.db.tables.quotes[0] as never, TOKEN)).toBe(false);
  });

  it("moves the linked lead forward to Quote Sent and logs it, like every other sender", async () => {
    signInAs(h.db, "sales");
    h.db.tables.quotes = [quoteRow({ lead_id: "L-1" })];
    h.db.tables.leads = [{ id: "L-1", tenant_id: TENANT_A, stage: "contact" }];
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).leadMoved).toBe(true);
    expect(h.db.tables.leads[0].stage).toBe("quote");
    expect(h.db.rpcCalls[0][0]).toBe("log_lead_activity");
  });

  it("already sent: nothing written, link already works", async () => {
    signInAs(h.db, "owner");
    h.db.tables.quotes = [quoteRow({ status: "sent" })];
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(false);
    expect(h.db.writes).toHaveLength(0);
  });

  it("another tenant's quote → 404, nothing written", async () => {
    signInAs(h.db, "owner", TENANT_B);
    h.db.tables.quotes = [quoteRow()];
    expect((await call()).status).toBe(404);
    expect(h.db.writes).toHaveLength(0);
  });

  it("a role that does not open Quotes → 403; signed out → 401", async () => {
    signInAs(h.db, "accountant");
    h.db.tables.quotes = [quoteRow()];
    expect((await call()).status).toBe(403);
    h.db.user = null;
    expect((await call()).status).toBe(401);
    expect(h.db.tables.quotes[0].status).toBe("draft");
  });
});
