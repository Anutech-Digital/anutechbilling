/**
 * R-2118 (GP-16a): the server wrapper around link_personal_identity. The rules themselves
 * (confirmed email, individual/consumer customer, outboxes, idempotency, company-email gate)
 * are proved on the database by supabase/tests/gp16a_personal_identity_link.test.sql.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    throw new Error("tests pass their own db");
  },
}));

import { linkPersonalIdentity } from "./identity-link.server";

const USER = "21180000-0000-4000-8000-0000000000e1";
const TENANT = "21180000-0000-4000-8000-0000000000b1";
const SELLER = "21180000-0000-4000-8000-0000000000a1";
const env = { BUY_PAGE_TENANT_ID: SELLER, NODE_ENV: "test" };

function fakeDb(answer: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async () => answer);
  return { db: { rpc }, rpc };
}

describe("linkPersonalIdentity", () => {
  it("calls the RPC with the user, the personal workspace and the website company", async () => {
    const { db, rpc } = fakeDb({
      data: { status: "linked", customer_id: "c1", customer_created: true, panel_queued: true, support_queued: true },
      error: null,
    });
    const r = await linkPersonalIdentity(USER, TENANT, { db, env });
    expect(rpc).toHaveBeenCalledWith("link_personal_identity", { p_user: USER, p_tenant: TENANT, p_seller_tenant: SELLER });
    expect(r).toEqual({ ok: true, status: "linked", customerId: "c1", customerCreated: true, panelQueued: true, supportQueued: true });
  });

  it("refuses without a website company outside production — never the live tenant", async () => {
    const { db, rpc } = fakeDb({ data: null, error: null });
    const r = await linkPersonalIdentity(USER, TENANT, { db, env: { NODE_ENV: "development" } });
    expect(r).toMatchObject({ ok: false, code: "WEBSITE_TENANT_MISSING" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps an unconfirmed email to EMAIL_NOT_CONFIRMED", async () => {
    const { db } = fakeDb({ data: null, error: { message: "link_personal_identity: the email is not confirmed yet — nothing is linked until it is" } });
    const r = await linkPersonalIdentity(USER, TENANT, { db, env });
    expect(r).toMatchObject({ ok: false, code: "EMAIL_NOT_CONFIRMED" });
  });

  it("maps a business workspace to NOT_PERSONAL", async () => {
    const { db } = fakeDb({ data: null, error: { message: "link_personal_identity: workspace x is not a personal workspace" } });
    const r = await linkPersonalIdentity(USER, TENANT, { db, env });
    expect(r).toMatchObject({ ok: false, code: "NOT_PERSONAL" });
  });

  it("passes through already_linked and the gated company-email case", async () => {
    let { db } = fakeDb({ data: { status: "already_linked", customer_id: "c1" }, error: null });
    expect(await linkPersonalIdentity(USER, TENANT, { db, env })).toEqual({ ok: true, status: "already_linked", customerId: "c1" });
    ({ db } = fakeDb({ data: { status: "needs_decision", customer_id: null, reason: "company_customer_email" }, error: null }));
    expect(await linkPersonalIdentity(USER, TENANT, { db, env })).toEqual({ ok: true, status: "needs_decision", reason: "company_customer_email" });
  });

  it("treats an unknown answer as a failure, not a success", async () => {
    const { db } = fakeDb({ data: { status: "weird" }, error: null });
    expect(await linkPersonalIdentity(USER, TENANT, { db, env })).toMatchObject({ ok: false, code: "FAILED" });
  });
});
