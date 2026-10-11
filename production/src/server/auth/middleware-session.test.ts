/** R-722: the Auth.js middleware session says `deactivated` when the users row is switched off. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const st = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  row: null as Record<string, unknown> | null,
  selected: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("./authjs", () => ({ auth: async () => st.session }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = (cols: string) => { st.selected.push(`${table}:${cols}`); return q; };
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: table === "users" ? st.row : null, error: null });
      return q;
    },
  }),
}));

import { authjsMiddlewareSession } from "./middleware-session";

const req = () => new NextRequest("https://app.test/leads");

beforeEach(() => {
  st.session = { user: { id: "u1", email: "m@x.test" }, aal: "aal1", mfaEnrolled: false };
  st.row = { role: "sales", can_view_deals: false, is_active: true };
  st.selected = [];
});

describe("authjsMiddlewareSession — is_active (R-722)", () => {
  it("reads is_active with the role", async () => {
    await authjsMiddlewareSession(req());
    expect(st.selected[0]).toMatch(/is_active/);
  });

  it("active member: not deactivated", async () => {
    const s = await authjsMiddlewareSession(req());
    expect(s.user?.id).toBe("u1");
    expect(s.deactivated).toBe(false);
  });

  it("deactivated member: deactivated = true (middleware signs them out)", async () => {
    st.row = { role: "sales", can_view_deals: false, is_active: false };
    const s = await authjsMiddlewareSession(req());
    expect(s.deactivated).toBe(true);
  });

  it("no users row (new signup) is not 'deactivated'", async () => {
    st.row = null;
    expect((await authjsMiddlewareSession(req())).deactivated).toBe(false);
  });

  it("signed out: not deactivated", async () => {
    st.session = null;
    const s = await authjsMiddlewareSession(req());
    expect(s.user).toBeNull();
    expect(s.deactivated).toBe(false);
  });
});
