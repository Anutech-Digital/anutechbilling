/**
 * R-222 — Parent accounts pages must not read the whole customer book (~29 s on staging).
 * The request count must not grow with the number of groups (no N+1), and neither page may
 * fall back to useCustomers() / useSubscriptions() (select * of everything).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { fetchGroupMemberCounts, fetchGroupMembers, fetchMembersMrr } from "./group-queries";

/** Fake PostgREST: records every request (one per `from`) and its calls; answers by table. */
function fakeClient(answers: Record<string, unknown[]>) {
  const requests: { table: string; calls: [string, ...unknown[]][] }[] = [];
  const client = {
    from(table: string) {
      const req = { table, calls: [] as [string, ...unknown[]][] };
      requests.push(req);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "in", "order", "range"]) {
        b[m] = (...args: unknown[]) => { req.calls.push([m, ...args]); return b; };
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: answers[table] ?? [], error: null }).then(res);
      return b;
    },
  };
  return { client: client as never, requests };
}

const grouped = (groups: number, perGroup: number) =>
  Array.from({ length: groups * perGroup }, (_, i) => ({ group_id: `g${i % groups}` }));

describe("fetchGroupMemberCounts — list page", () => {
  it("one request whether there are 3 groups or 300 (no per-group query)", async () => {
    const few = fakeClient({ customers: grouped(3, 4) });
    const many = fakeClient({ customers: grouped(300, 2) });
    const a = await fetchGroupMemberCounts(few.client);
    const b = await fetchGroupMemberCounts(many.client);
    expect(few.requests).toHaveLength(1);
    expect(many.requests).toHaveLength(1);
    expect(a.get("g0")).toBe(4);
    expect(b.size).toBe(300);
  });

  it("reads only group_id, only for grouped customers", async () => {
    const { client, requests } = fakeClient({ customers: [{ group_id: "g1" }, { group_id: "g1" }, { group_id: "g2" }] });
    const counts = await fetchGroupMemberCounts(client);
    expect(requests[0].calls).toContainEqual(["select", "group_id"]);
    expect(requests[0].calls).toContainEqual(["not", "group_id", "is", null]);
    expect([...counts]).toEqual([["g1", 2], ["g2", 1]]);
  });
});

describe("detail page reads", () => {
  it("members: only this group's customers", async () => {
    const { client, requests } = fakeClient({ customers: [{ id: "c1" }] });
    await fetchGroupMembers(client, "g9");
    expect(requests[0].calls).toContainEqual(["eq", "group_id", "g9"]);
  });

  it("MRR: active subscriptions of the members only, summed per customer (whole ₹)", async () => {
    const { client, requests } = fakeClient({
      subscriptions: [
        { customer_id: "c1", mrr: 999 }, { customer_id: "c1", mrr: 1500 }, { customer_id: "c2", mrr: 0 },
      ],
    });
    const mrr = await fetchMembersMrr(client, ["c2", "c1", "c1"]);
    expect(mrr.get("c1")).toBe(2499);
    expect(mrr.get("c2")).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].calls).toContainEqual(["eq", "status", "active"]);
    expect(requests[0].calls).toContainEqual(["in", "customer_id", ["c2", "c1"]]);
    expect(requests[0].calls).toContainEqual(["select", "customer_id, mrr"]);
  });

  it("a group with no members asks nothing", async () => {
    const { client, requests } = fakeClient({});
    expect((await fetchMembersMrr(client, [])).size).toBe(0);
    expect(requests).toHaveLength(0);
  });
});

describe("page wiring", () => {
  const read = (p: string) =>
    readFileSync(path.join(__dirname, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("list page counts members from the slim read, not the full customer list", () => {
    const src = read("page.tsx");
    expect(src).not.toMatch(/useCustomers\(/);
    expect(src).toMatch(/useGroupMemberCounts\(\)/);
  });

  it("detail page reads this group's members and their MRR, not every customer + subscription", () => {
    const src = read("[id]/page.tsx");
    expect(src).not.toMatch(/useCustomers\(/);
    expect(src).not.toMatch(/useSubscriptions\(/);
    expect(src).toMatch(/useGroupMembers\(id\)/);
    expect(src).toMatch(/useMembersMrr\(/);
  });
});
