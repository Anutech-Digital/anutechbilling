/**
 * /api/feedback/auto-send (R-357): the "Auto-send new reports to AI" switch.
 * Pinned: default ON before the migration, owner-only save, and an honest 409 when the column
 * does not exist yet.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// R-051: who createAdminClientFor() was opened for (the audit log actor).
const actors = vi.hoisted(() => [] as string[]);

const db = vi.hoisted(() => ({
  user: { id: "u1" } as null | { id: string },
  me: { tenant_id: "t1", role: "owner" } as null | Record<string, unknown>,
  tenant: { id: "t1" } as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  updateError: null as null | { code?: string; message: string },
}));

vi.mock("@/lib/supabase/server", () => {
  const builder = (table: string) => {
    const q = {
      select() { return q; },
      eq() {
        return table === "tenants" && db.updates.length && pendingUpdate
          ? (pendingUpdate = false, Promise.resolve({ error: db.updateError }))
          : q;
      },
      update(v: Record<string, unknown>) { db.updates.push(v); pendingUpdate = true; return q; },
      maybeSingle() {
        return Promise.resolve({ data: table === "users" ? db.me : db.tenant, error: null });
      },
    };
    return q;
  };
  let pendingUpdate = false;
  return {
    createClient: () => ({ auth: { getUser: async () => ({ data: { user: db.user } }) }, from: builder }),
    createAdminClientFor: (actor: string) => (actors.push(actor), { from: builder }),
  };
});

import { GET, POST } from "./route";
import type { NextRequest } from "next/server";

const post = (body: unknown) =>
  POST(new Request("https://example.invalid/api/feedback/auto-send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest);

beforeEach(() => {
  actors.length = 0;
  db.user = { id: "u1" };
  db.me = { tenant_id: "t1", role: "owner" };
  db.tenant = { id: "t1" };
  db.updates = [];
  db.updateError = null;
});

describe("/api/feedback/auto-send", () => {
  it("reads ON (not ready) before the migration, and the stored value after", async () => {
    expect(await (await GET()).json()).toEqual({ on: true, canEdit: true, ready: false });
    db.tenant = { id: "t1", feedback_auto_send: false };
    expect(await (await GET()).json()).toEqual({ on: false, canEdit: true, ready: true });
  });

  it("refuses a signed-out caller and a non-owner save", async () => {
    db.user = null;
    expect((await GET()).status).toBe(401);
    db.user = { id: "u1" };
    db.me = { tenant_id: "t1", role: "sales" };
    expect((await post({ on: false })).status).toBe(403);
    expect(db.updates).toHaveLength(0);
  });

  it("owner saves only the switch", async () => {
    const r = await post({ on: false });
    expect(r.status).toBe(200);
    expect(actors).toContain("u1"); // R-051: audit log names the signed-in owner
    expect(Object.keys(db.updates[0]).sort()).toEqual(["feedback_auto_send", "updated_at"]);
    expect(db.updates[0].feedback_auto_send).toBe(false);
  });

  it("rejects a bad body", async () => {
    expect((await post({ on: "yes" })).status).toBe(400);
  });

  it("says the migration is missing instead of pretending to save", async () => {
    db.updateError = { code: "PGRST204", message: "Could not find the 'feedback_auto_send' column" };
    const r = await post({ on: false });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/20261007110000_feedback_agent_claim/);
  });
});
