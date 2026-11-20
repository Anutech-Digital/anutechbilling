/**
 * R-2949 — the owner's "Left out by you" list for the FY sales import, in the database
 * (zoho_fy_left_out, migration 20261120080830): one row per rule, for ONE company. Server only —
 * the table is service_role only, like the Zoho scan it sits next to; the admin client bypasses
 * RLS, so EVERY read and write below is filtered by `tenantId` (CLAUDE.md §17c). The tenant comes
 * from the signed-in user's own row (resolveZohoCaller), never from the request.
 */
import { must, type FyImportDb } from "../fy-import/store";

type Res<T = unknown> = PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>;
const KIND = "invoices";
const TABLE = "zoho_fy_left_out";

/** The most rules one company keeps (the list is read on every preview and import part). */
export const LEFT_OUT_MAX = { doc: 500, prefix: 20 } as const;

export interface SavedLeftOut { docs: { zohoId: string; number: string }[]; prefixes: string[] }
export type LeftOutRule = { rule: "doc"; value: string; number: string } | { rule: "prefix"; value: string };

export async function readLeftOut(db: FyImportDb, tenantId: string): Promise<SavedLeftOut> {
  const r = await (db.from(TABLE).select("rule, value, number").eq("tenant_id", tenantId).eq("kind", KIND)
    .order("created_at", { ascending: true }).limit(LEFT_OUT_MAX.doc + LEFT_OUT_MAX.prefix) as Res<Array<{ rule: string; value: string; number: string | null }>>);
  const rows = must(r, "the invoices you left out");
  return {
    docs: rows.filter((x) => x.rule === "doc").map((x) => ({ zohoId: x.value, number: x.number ?? "" })),
    prefixes: rows.filter((x) => x.rule === "prefix").map((x) => x.value),
  };
}

/** Saving a rule that is already there changes nothing (a repeat click is safe). */
export async function addLeftOut(db: FyImportDb, tenantId: string, userId: string, rule: LeftOutRule): Promise<void> {
  const r = await (db.from(TABLE).upsert(
    { tenant_id: tenantId, kind: KIND, rule: rule.rule, value: rule.value, number: rule.rule === "doc" ? rule.number.slice(0, 60) : null, created_by: userId },
    { onConflict: "tenant_id,kind,rule,value" }) as Res);
  if (r.error) throw new Error("Could not save what you left out.");
}

/** Taking back a rule that is not there changes nothing. */
export async function removeLeftOut(db: FyImportDb, tenantId: string, rule: "doc" | "prefix", value: string): Promise<void> {
  const r = await (db.from(TABLE).delete().eq("tenant_id", tenantId).eq("kind", KIND).eq("rule", rule).eq("value", value) as Res);
  if (r.error) throw new Error("Could not take that back.");
}

/** The number of one invoice in THIS company's Zoho read, null when it is not there. */
export async function scannedInvoiceNumber(db: FyImportDb, tenantId: string, zohoId: string): Promise<string | null> {
  const r = await (db.from("zoho_fy_scan").select("number").eq("tenant_id", tenantId).eq("kind", KIND).eq("zoho_id", zohoId).limit(1) as Res<Array<{ number: string }>>);
  return must(r, "the Zoho read")[0]?.number ?? null;
}
