/**
 * McpDb over a recording supabase-js stand-in: the tenant filter is on every read and update,
 * insert stamps the tenant, column allowlists and credential columns are enforced, search text
 * cannot inject PostgREST syntax, and only allowlisted tables / RPCs are reachable.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { mcpDbFromClient, McpDbRefused, searchText } from "@/lib/mcp/db";

function recorder() {
  const log: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  const methods = ["select", "eq", "neq", "in", "is", "not", "gte", "lte", "lt", "gt", "or", "order", "range", "insert", "update", "single", "maybeSingle"];
  for (const m of methods) chain[m] = (...a: unknown[]) => { log.push([m, ...a]); return chain; };
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok);
  const client = {
    from: (t: string) => { log.push(["from", t]); return chain; },
    rpc: (f: string, a: unknown) => { log.push(["rpc", f, a]); return Promise.resolve({ data: null, error: null }); },
  };
  return { client: client as unknown as SupabaseClient, log };
}

const T = "aaaaaaaa-0000-4000-8000-000000000001";

describe("McpDb", () => {
  it("adds tenant_id = caller's tenant to every select", async () => {
    const { client, log } = recorder();
    await mcpDbFromClient(client, T).select("leads", ["id", "company"]).eq("stage", "new");
    expect(log).toContainEqual(["eq", "tenant_id", T]);
    expect(log[1]).toEqual(["select", "id,company", undefined]);
  });

  it("stamps the tenant on insert (a caller-supplied tenant_id is overwritten) and scopes updates", async () => {
    const { client, log } = recorder();
    const db = mcpDbFromClient(client, T);
    await db.insert("tasks", { title: "x", tenant_id: "bbbbbbbb-0000-4000-8000-000000000002" }, ["id"]);
    expect(log.find((l) => l[0] === "insert")?.[1]).toMatchObject({ tenant_id: T });
    await db.updateById("tasks", "id-1", { status: "done" }, ["id"]);
    expect(log).toContainEqual(["eq", "tenant_id", T]);
    await expect(db.updateById("tasks", "id-1", { tenant_id: "x" }, ["id"])).rejects.toBeInstanceOf(McpDbRefused);
  });

  it("refuses unknown columns, secret columns and unlisted tables / RPCs", () => {
    const { client } = recorder();
    const db = mcpDbFromClient(client, T);
    expect(() => db.select("leads", ["id", "gstin_secret"])).toThrow(McpDbRefused);
    expect(() => db.select("employees", ["id", "pin_hash"])).toThrow(McpDbRefused);
    expect(() => db.select("leads", ["*"])).toThrow(McpDbRefused);
    expect(() => db.select("leads", [])).toThrow(McpDbRefused);
    expect(() => db.select("vault_passwords" as never, ["id"])).toThrow(McpDbRefused);
    expect(() => db.select("leads", ["id"]).eq("utm_source", "x")).toThrow(McpDbRefused);
    expect(db.insert("invoices" as never, {}, ["id"])).rejects.toBeInstanceOf(McpDbRefused);
    expect(db.rpc("record_payment" as never)).rejects.toBeInstanceOf(McpDbRefused);
    expect(() => mcpDbFromClient(client, "")).toThrow(McpDbRefused);
  });

  it("never writes to a billing table", () => {
    const { client } = recorder();
    const db = mcpDbFromClient(client, T);
    for (const t of ["invoices", "quotes", "payments", "subscriptions", "customers"]) {
      expect(db.insert(t as never, {}, ["id"])).rejects.toBeInstanceOf(McpDbRefused);
      expect(db.updateById(t as never, "x", {}, ["id"])).rejects.toBeInstanceOf(McpDbRefused);
    }
  });

  it("search text cannot carry PostgREST operators", async () => {
    expect(searchText("acme),stage.eq.won,(x")).toBe("acme stage.eq.won x");
    expect(searchText("a%_*b")).toBe("a b");
    const { client, log } = recorder();
    await mcpDbFromClient(client, T).select("leads", ["id"]).search(["company", "contact_name"], "acme),id.eq.1");
    expect(log.find((l) => l[0] === "or")?.[1]).toBe("company.ilike.%acme id.eq.1%,contact_name.ilike.%acme id.eq.1%");
  });

  it("caps a page at 200 rows", async () => {
    const { client, log } = recorder();
    await mcpDbFromClient(client, T).select("leads", ["id"]).page(10, 10_000);
    expect(log).toContainEqual(["range", 10, 209]);
  });
});
