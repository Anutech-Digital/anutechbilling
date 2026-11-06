/**
 * R-2477: what the Team page offers for memberships, and that the server's words come back.
 */
import { describe, it, expect } from "vitest";
import { canRemoveMember, cleanPatch, removeMember, updateMembership } from "./team-membership";
import { describeMergeOutcome } from "./merge-outcome";

describe("canRemoveMember", () => {
  const owner = { id: "o1", role: "owner", is_active: true };
  it("never on your own row", () => {
    expect(canRemoveMember({ id: "me", role: "sales", is_active: true }, "me", 2)).toBe(false);
  });
  it("never on the only active owner", () => {
    expect(canRemoveMember(owner, "me", 1)).toBe(false);
  });
  it("another owner when there are two; any other member", () => {
    expect(canRemoveMember(owner, "me", 2)).toBe(true);
    expect(canRemoveMember({ id: "s1", role: "sales", is_active: false }, "me", 1)).toBe(true);
  });
  it("nothing before the current user is known", () => {
    expect(canRemoveMember({ id: "s1", role: "sales", is_active: true }, undefined, 2)).toBe(false);
  });
});

describe("cleanPatch / updateMembership", () => {
  it("sends only the four fields the server accepts", () => {
    expect(cleanPatch({ role: "sales", tenant_id: "x", is_active: true } as never)).toEqual({ role: "sales" });
  });
  it("calls update_company_member and throws the server's own words", async () => {
    const calls: unknown[] = [];
    const ok = { rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return { error: null }; } };
    await updateMembership(ok as never, "u1", { manager_id: null });
    expect(calls).toEqual([["update_company_member", { p_user_id: "u1", p_patch: { manager_id: null } }]]);
    const bad = { rpc: async () => ({ error: { message: "This is the last active owner of this company. Make someone else an owner first." } }) };
    await expect(updateMembership(bad as never, "u1", { role: "sales" })).rejects.toThrow(/Make someone else an owner first/);
  });
});

describe("removeMember", () => {
  it("DELETEs the member route and passes a refusal through", async () => {
    const seen: string[] = [];
    const ok = (async (url: string, init: RequestInit) => { seen.push(`${init.method} ${url}`); return new Response("{}", { status: 200 }); }) as never;
    await removeMember("u 1", ok);
    expect(seen).toEqual(["DELETE /api/team/members/u%201"]);
    const no = (async () => new Response(JSON.stringify({ error: "You cannot remove yourself. Ask another owner of this company to do it." }), { status: 403 })) as never;
    await expect(removeMember("u1", no)).rejects.toThrow(/Ask another owner/);
    const broken = (async () => new Response("<html>", { status: 502 })) as never;
    await expect(removeMember("u1", broken)).rejects.toThrow(/Refresh the Team page/);
  });
});

describe("Claim outcome for memberships (R-2477)", () => {
  const base = { email: "ravi@beta.test", role: "sales", old_tenant_name: null, old_tenant_deleted: false };
  it("added says they keep their other company, without naming it", () => {
    const t = describeMergeOutcome({ ...base, action: "added" });
    expect(t).toMatch(/also in your company as sales/);
    expect(t).toMatch(/keep the other company/);
    expect(t).not.toMatch(/null|moved|removed/);
  });
  it("rejoined says they are back", () => {
    expect(describeMergeOutcome({ ...base, action: "rejoined" })).toBe("ravi@beta.test is back in your company as sales.");
  });
});
