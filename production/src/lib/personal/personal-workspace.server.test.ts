/**
 * R-2119 (GP-05): personal workspace creation — the rows, the rollback, never a second workspace,
 * and the PERSONAL_SIGNUP_ENABLED switch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  insertErr: {} as Record<string, { message: string }>,
  calls: [] as string[],
  rows: {} as Record<string, Record<string, unknown>>,
}));
vi.mock("@/lib/personal/identity-link.server", () => ({ linkPersonalIdentity: async () => ({ ok: true, status: "already_linked", customerId: null }) }));

import { createPersonalWorkspace, personalConsentChoices, personalName, personalTenantRow } from "./personal-workspace.server";
import { personalSignupEnabled } from "./signup-flag";

const admin = {
  from: (table: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: table === "users" ? st.existing : null, error: null });
    q.insert = (row: Record<string, unknown>) => { st.calls.push(`${table}.insert`); st.rows[table] = row; return Promise.resolve({ error: st.insertErr[table] ?? null }); };
    q.delete = () => { st.calls.push(`${table}.delete`); return q; };
    return q;
  },
} as never;

const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => { st.existing = null; st.insertErr = {}; st.calls = []; st.rows = {}; });

describe("createPersonalWorkspace", () => {
  it("writes a personal tenant (no GSTIN / state / business type) and a role-personal users row", async () => {
    const r = await createPersonalWorkspace(admin, { userId: UID, email: "meera@gmail.com", fullName: "Meera Iyer" });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(st.rows.tenants).toMatchObject({ name: "Meera Iyer", workspace_kind: "personal", gstin: null, business_type: null });
    expect(st.rows.tenants).not.toHaveProperty("state");
    expect(st.rows.tenants).not.toHaveProperty("state_code");
    expect(st.rows.users).toMatchObject({ id: UID, role: "personal", tenant_id: (r as { tenantId: string }).tenantId });
  });
  it("a failed users insert removes the tenant it just made", async () => {
    st.insertErr = { users: { message: "duplicate key users_pkey" } };
    const r = await createPersonalWorkspace(admin, { userId: UID, email: "m@gmail.com", fullName: "M" });
    expect(r).toMatchObject({ ok: false, code: "user_failed" });
    expect(st.calls).toEqual(["tenants.insert", "users.insert", "tenants.delete"]);
  });
  it("someone with a users row never gets a second workspace", async () => {
    st.existing = { tenant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "owner" };
    const r = await createPersonalWorkspace(admin, { userId: UID, email: "m@gmail.com", fullName: "M" });
    expect(r).toMatchObject({ ok: true, created: false, role: "owner" });
    expect(st.calls).toEqual([]);
  });
});

describe("helpers", () => {
  it("consent: the two required purposes granted, marketing as chosen", () => {
    expect(personalConsentChoices(false)).toEqual(["account_terms", "personal_finance_processing", { purpose: "marketing", granted: false }]);
    expect(personalConsentChoices(true)[2]).toEqual({ purpose: "marketing", granted: true });
  });
  it("name falls back to the mailbox part", () => {
    expect(personalName("  ", "meera.iyer@gmail.com")).toBe("meera.iyer");
    expect(personalName("Meera", "x@y.in")).toBe("Meera");
  });
  it("tenant row is pure", () => {
    expect(personalTenantRow({ tenantId: "t", fullName: "A", email: "a@b.in" }).workspace_kind).toBe("personal");
  });
  it("the switch is off unless PERSONAL_SIGNUP_ENABLED is 1 / true", () => {
    expect(personalSignupEnabled({})).toBe(false);
    expect(personalSignupEnabled({ PERSONAL_SIGNUP_ENABLED: "0" })).toBe(false);
    expect(personalSignupEnabled({ PERSONAL_SIGNUP_ENABLED: "yes" })).toBe(false);
    expect(personalSignupEnabled({ PERSONAL_SIGNUP_ENABLED: "1" })).toBe(true);
    expect(personalSignupEnabled({ PERSONAL_SIGNUP_ENABLED: " TRUE " })).toBe(true);
  });
});
