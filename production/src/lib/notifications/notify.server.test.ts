/**
 * R-2941 — notifyPeople answers how many notices it wrote, and still never throws.
 * (Remind puts its stamp back when the answer is 0 — lib/tasks/remind-notice.server.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
let users: Row[] = [];
let inserted: Row[] = [];
let insertError: { message: string } | null = null;
let crash = false;

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    if (crash) throw new Error("no service key");
    return {
      from(table: string) {
        let rows = table === "users" ? users.slice() : [];
        const q = {
          select: () => q,
          eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return q; },
          in: (k: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[k])); return q; },
          insert: async (added: Row[]) => {
            if (insertError) return { error: insertError };
            inserted.push(...added);
            return { error: null };
          },
          then: (ok: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok),
        };
        return q;
      },
    };
  },
}));

import { notifyPeople } from "./notify.server";

const input = { tenantId: "t-1", kind: "task.reminder" as const, title: "Reminder from Pardeep: Call Acme" };

beforeEach(() => {
  inserted = []; insertError = null; crash = false;
  users = [
    { id: "u-1", tenant_id: "t-1", is_active: true, role: "sales" },
    { id: "u-2", tenant_id: "t-1", is_active: false, role: "sales" },
    { id: "u-3", tenant_id: "t-other", is_active: true, role: "sales" },
  ];
});

describe("R-2941 notifyPeople says how many notices were written", () => {
  it("one active person of this company → 1, and the row is theirs", async () => {
    expect(await notifyPeople(input, { userIds: ["u-1"] })).toBe(1);
    expect(inserted).toEqual([expect.objectContaining({ tenant_id: "t-1", user_id: "u-1", kind: "task.reminder" })]);
  });

  it("nobody to tell (inactive, another company, empty list) → 0, nothing written", async () => {
    expect(await notifyPeople(input, { userIds: ["u-2", "u-3"] })).toBe(0);
    expect(await notifyPeople(input, {})).toBe(0);
    expect(inserted).toEqual([]);
  });

  it("the write fails or the client crashes → 0, logged, never thrown", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    insertError = { message: "insert refused" };
    expect(await notifyPeople(input, { userIds: ["u-1"] })).toBe(0);
    crash = true;
    expect(await notifyPeople(input, { userIds: ["u-1"] })).toBe(0);
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});
