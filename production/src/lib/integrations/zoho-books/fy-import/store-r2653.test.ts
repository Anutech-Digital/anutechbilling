/**
 * R-2653 — supabaseScanStore's Read again: refresh keeps the scan rows (only the run is reset, with
 * list_started_at + the deposit-account filter), addListed writes each verdict's own shape (a kept
 * payload is never nulled; an "other account" row only gets listed_at), requeueUnlisted re-checks only
 * this company + list + FY's rows not listed since (never a blind delete), saveRun moves only the same
 * read on, saveDetail records the facts version. Every query is filtered by tenant + kind (§17c).
 * The Supabase client is a recording fake; names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import { supabaseScanStore, type FyImportDb } from "./store";
import { parseOnlyAccount, SCAN_FACTS_VERSION } from "./scan";

interface Call { table: string; op: string; arg?: unknown; filters: Array<[string, string, unknown]> }

function fakeDb(selectRows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const db: FyImportDb = {
    from(table: string) {
      const c: Call = { table, op: "", filters: [] };
      calls.push(c);
      const q: Record<string, unknown> = {};
      const chain = (name: string) => (...a: unknown[]) => { c.filters.push([name, String(a[0]), a[1]]); return q; };
      for (const f of ["eq", "in", "lt", "is", "not", "order", "limit", "or"]) q[f] = chain(f);
      q.select = (...a: unknown[]) => { if (!c.op) c.op = "select"; c.filters.push(["select", String(a[0]), undefined]); return q; };
      for (const op of ["upsert", "update", "delete"]) q[op] = (arg?: unknown) => { c.op = op; c.arg = arg; return q; };
      q.then = (res: (v: unknown) => unknown) => res({ data: c.op === "select" ? selectRows : [{ zoho_id: "gone" }], error: null });
      return q;
    },
  };
  return { db, calls };
}
const has = (c: Call, col: string, v: unknown) => c.filters.some(([k, f, val]) => k === "eq" && f === col && val === v);

describe("R-2653 supabaseScanStore — Read again", () => {
  it("refresh resets only the run (page 1, list_started_at, filter) — no scan row is deleted", async () => {
    const { db, calls } = fakeDb();
    await supabaseScanStore(db, "t1", "customerpayments").refresh("2025-26", { onlyAccount: "ZA-RZP", nowIso: "2026-11-10T06:00:00.000Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: "zoho_fy_scan_runs", op: "upsert" });
    expect(calls[0].arg).toMatchObject({ tenant_id: "t1", kind: "customerpayments", fy: "2025-26", next_page: 1, list_done: false, list_started_at: "2026-11-10T06:00:00.000Z", only_account_id: "ZA-RZP" });
  });

  it("addListed: changed → payload nulled; unchanged → payload untouched; other account → only listed_at; new other account → not stored", async () => {
    /* R-2694: INR facts that carry their currency (complete) — an old one without it is re-read (reread-r2694.test.ts). */
    const known = [
      { zoho_id: "p-same", zoho_status: "paid", fy: "2025-26", zoho_modified: "T1", detailed_at: "2026-11-01T00:00:00Z", deposit_account_id: "ZA-RZP", facts_version: null, payload: { currency: "INR" } },
      { zoho_id: "p-edit", zoho_status: "paid", fy: "2025-26", zoho_modified: "T1", detailed_at: "2026-11-01T00:00:00Z", deposit_account_id: "ZA-RZP", facts_version: null, payload: { currency: "INR" } },
      { zoho_id: "p-hdfc", zoho_status: "paid", fy: "2025-26", zoho_modified: "T1", detailed_at: "2026-11-01T00:00:00Z", deposit_account_id: "ZA-HDFC", facts_version: null, payload: { currency: "INR" } },
      /* read while it was in Razorpay Clearing, now moved to HDFC in Zoho → its facts must be read again */
      { zoho_id: "p-moved", zoho_status: "paid", fy: "2025-26", zoho_modified: "T1", detailed_at: "2026-11-01T00:00:00Z", deposit_account_id: "ZA-RZP", facts_version: null, payload: { currency: "INR" } },
    ];
    const { db, calls } = fakeDb(known);
    const row = (id: string, modified: string, accountId: string) => ({ zohoId: id, number: id, date: "2025-06-01", status: "paid", modified, accountId });
    await supabaseScanStore(db, "t1", "customerpayments").addListed("2025-26", [
      row("p-same", "T1", "ZA-RZP"), row("p-edit", "T2", "ZA-RZP"), row("p-new", "T2", "ZA-RZP"),
      row("p-hdfc", "T2", "ZA-HDFC"), row("p-new-hdfc", "T2", "ZA-HDFC"), row("p-moved", "T1", "ZA-HDFC"),
    ], { onlyAccount: "ZA-RZP", listStartedAt: "2099-01-01T00:00:00.000Z" });
    const sel = calls[0];
    expect(sel.op).toBe("select");
    expect(has(sel, "tenant_id", "t1") && has(sel, "kind", "customerpayments")).toBe(true);
    const ups = calls.filter((c) => c.op === "upsert");
    expect(ups).toHaveLength(2);
    const fresh = ups[0].arg as Array<Record<string, unknown>>;
    const kept = ups[1].arg as Array<Record<string, unknown>>;
    expect(fresh.map((r) => r.zoho_id).sort()).toEqual(["p-edit", "p-moved", "p-new"]);
    expect(fresh.every((r) => r.payload === null && r.detailed_at === null)).toBe(true);
    expect(fresh.find((r) => r.zoho_id === "p-edit")).toMatchObject({ zoho_modified: "T2", deposit_account_id: "ZA-RZP" });
    expect(fresh.find((r) => r.zoho_id === "p-moved")).toMatchObject({ deposit_account_id: "ZA-HDFC" });
    /* never stamped before the read's start (another server's clock may be behind) */
    expect([...fresh, ...(ups[1].arg as Array<Record<string, unknown>>)].every((r) => r.listed_at === "2099-01-01T00:00:00.000Z")).toBe(true);
    expect(kept.map((r) => r.zoho_id)).toEqual(["p-same"]);
    expect("payload" in kept[0]).toBe(false);
    const upd = calls.find((c) => c.op === "update")!;
    expect(Object.keys(upd.arg as object)).toEqual(["listed_at"]);
    expect(upd.filters).toContainEqual(["in", "zoho_id", ["p-hdfc"]]);
    expect(has(upd, "tenant_id", "t1") && has(upd, "kind", "customerpayments")).toBe(true);
    expect(JSON.stringify(calls.filter((c) => c.op !== "select"))).not.toContain("p-new-hdfc");
  });

  it("requeueUnlisted re-checks (never deletes) only this company + list + FY's rows listed before the Read again began", async () => {
    const { db, calls } = fakeDb();
    const n = await supabaseScanStore(db, "t1", "bills").requeueUnlisted("2025-26", "2026-11-10T06:00:00.000Z");
    expect(n).toBe(1);
    const d = calls[0];
    expect(d).toMatchObject({ table: "zoho_fy_scan", op: "update", arg: { payload: null, detailed_at: null } });
    expect(has(d, "tenant_id", "t1") && has(d, "kind", "bills") && has(d, "fy", "2025-26")).toBe(true);
    expect(d.filters).toContainEqual(["lt", "listed_at", "2026-11-10T06:00:00.000Z"]);
  });

  it("readRun / saveRun carry list_started_at + the filter through every save of the read", async () => {
    const { db, calls } = fakeDb([{ next_page: 4, list_done: false, list_started_at: "2026-11-10T06:00:00Z", only_account_id: "ZA-RZP" }]);
    const s = supabaseScanStore(db, "t1", "customerpayments");
    const run = await s.readRun("2025-26");
    expect(run).toEqual({ nextPage: 4, listDone: false, listStartedAt: "2026-11-10T06:00:00Z", onlyAccount: "ZA-RZP" });
    await s.saveRun("2025-26", { ...run!, nextPage: 5 });
    /* only the SAME read moves the run on: a Read again since then (new list_started_at) wins */
    expect(calls[1]).toMatchObject({ table: "zoho_fy_scan_runs", op: "update" });
    expect(calls[1].arg).toMatchObject({ next_page: 5 });
    expect(calls[1].arg).not.toHaveProperty("list_started_at");
    expect(calls[1].filters).toContainEqual(["eq", "list_started_at", "2026-11-10T06:00:00Z"]);
    expect(has(calls[1], "tenant_id", "t1") && has(calls[1], "kind", "customerpayments") && has(calls[1], "fy", "2025-26")).toBe(true);
    await s.saveRun("2025-26", { nextPage: 2, listDone: false, listStartedAt: null, onlyAccount: null });
    expect(calls[2].filters).toContainEqual(["is", "list_started_at", null]);
    await s.saveRun("2025-26", { nextPage: 2, listDone: false });     // no run stored yet → created
    expect(calls[3]).toMatchObject({ op: "upsert", arg: { tenant_id: "t1", kind: "customerpayments", fy: "2025-26", next_page: 2 } });
  });

  it("facts version: a kind whose normaliser version went up reads older details again; saveDetail records the version", async () => {
    SCAN_FACTS_VERSION.invoices = 1;
    const { db, calls } = fakeDb([{ zoho_id: "i-1", zoho_status: "sent", fy: "2025-26", zoho_modified: "T1", detailed_at: "2026-11-01T00:00:00Z", deposit_account_id: null, facts_version: null }]);
    const s = supabaseScanStore(db, "t1", "invoices");
    await s.addListed("2025-26", [{ zohoId: "i-1", number: "INV-1", date: "2025-06-01", status: "sent", modified: "T1", accountId: "" }]);
    expect((calls[1].arg as Array<Record<string, unknown>>)[0]).toMatchObject({ zoho_id: "i-1", payload: null });
    await s.saveDetail("2025-26", "i-1", { number: "INV-1", date: "2025-06-01", status: "sent" });
    expect(calls[2].arg).toMatchObject({ facts_version: 1 });
    delete SCAN_FACTS_VERSION.invoices;
  });
});

describe("R-2653 parseOnlyAccount — the Read-again account the dialog sends", () => {
  it("empty → all accounts; a Zoho id → that id; anything else → refused", () => {
    expect(parseOnlyAccount(undefined)).toBeNull();
    expect(parseOnlyAccount("")).toBeNull();
    expect(parseOnlyAccount(null)).toBeNull();
    expect(parseOnlyAccount("460000000012345")).toBe("460000000012345");
    expect(parseOnlyAccount("x'); drop")).toBeUndefined();
    expect(parseOnlyAccount(42)).toBeUndefined();
    expect(parseOnlyAccount("a".repeat(61))).toBeUndefined();
  });
});
