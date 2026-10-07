/**
 * R-391: choosing your own password clears the owner-set must_change_password flag, in the
 * same admin write — and an ordinary change does not touch app_metadata at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const st = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  pwOk: true,
  updates: [] as Array<{ id: string; attrs: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user } }) } }),
  createAdminClient: () => ({
    auth: {
      admin: {
        updateUserById: async (id: string, attrs: Record<string, unknown>) => {
          st.updates.push({ id, attrs });
          return { data: { user: { id } }, error: null };
        },
      },
    },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { signInWithPassword: async () => ({ error: st.pwOk ? null : { message: "bad" } }) },
  }),
}));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("https://x.test/api/settings/change-password", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

beforeEach(() => {
  st.updates = []; st.pwOk = true;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
});

describe("POST /api/settings/change-password — R-391 flag", () => {
  it("clears must_change_password when it was set", async () => {
    st.user = { id: "u1", email: "m@t.test", app_metadata: { must_change_password: true } };
    const r = await call({ currentPassword: "Temp-pass-1234", newPassword: "Kites-river-42" });
    expect(r.status).toBe(200);
    expect(st.updates[0]).toEqual({ id: "u1", attrs: { password: "Kites-river-42", app_metadata: { must_change_password: null } } });
  });

  it("leaves app_metadata alone on an ordinary change", async () => {
    st.user = { id: "u1", email: "m@t.test", app_metadata: {} };
    await call({ currentPassword: "Old-pass-1234", newPassword: "Kites-river-42" });
    expect(st.updates[0].attrs).toEqual({ password: "Kites-river-42" });
  });

  it("keeps the flag when the temporary password is wrong", async () => {
    st.user = { id: "u1", email: "m@t.test", app_metadata: { must_change_password: true } };
    st.pwOk = false;
    expect((await call({ currentPassword: "nope-nope-nope", newPassword: "Kites-river-42" })).status).toBe(403);
    expect(st.updates).toHaveLength(0);
  });
});
