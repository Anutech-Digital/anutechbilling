#!/usr/bin/env node
/**
 * seed-e2e-catalog.mjs — products + vendors for "E2E Test Co" in the LOCAL DB (R-878).
 *
 *   node scripts/dev/seed-e2e-catalog.mjs          (from production/, local stack running)
 *
 * The AI tester's first run (R-860) found the onboard / add-subscription dialog empty for the
 * E2E company: its catalogue (public.items) had no rows, so no vendor or plan could be picked.
 * This adds a small, fixed catalogue across google / microsoft / zoho and two supplier rows
 * (public.vendors). Prices are ₹/seat/month, as items.msrp is.
 *
 * Idempotent: rows are found again by their fixed id (items) or name (vendors); existing rows
 * are left as they are, nothing is ever deleted. Run it as often as you like.
 *
 * REFUSES (exit 1) when the Supabase URL is not local (localhost / 127.0.0.1 / Docker host) —
 * hard-coded, no override — or when "E2E Test Co" does not exist yet (run
 * E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs first). Prints names and counts only.
 */
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { localSupabase } from "./local-guard.mjs";
import { E2E_TENANT_EMAIL, E2E_TENANT_NAME } from "../../e2e/fixtures/e2e-roles.mjs";

/** The fixed catalogue. ids are global primary keys, hence the E2E- prefix. */
const E2E_CATALOG = [
  { id: "E2E-GW-STR", vendor: "google", name: "E2E Google Workspace Business Starter", msrp: 136, wholesale: 110 },
  { id: "E2E-GW-STD", vendor: "google", name: "E2E Google Workspace Business Standard", msrp: 736, wholesale: 620 },
  { id: "E2E-M365-BAS", vendor: "microsoft", name: "E2E Microsoft 365 Business Basic", msrp: 145, wholesale: 125 },
  { id: "E2E-M365-STD", vendor: "microsoft", name: "E2E Microsoft 365 Business Standard", msrp: 880, wholesale: 750 },
  { id: "E2E-ZOHO-MAIL", vendor: "zoho", name: "E2E Zoho Mail Lite", msrp: 59, wholesale: 45 },
];

const E2E_SUPPLIERS = [
  { name: "E2E Google Distributor Pvt Ltd", contact_email: "e2e-google-dist@example.test", state: "Maharashtra" },
  { name: "E2E Microsoft Distributor Pvt Ltd", contact_email: "e2e-ms-dist@example.test", state: "Maharashtra" },
];

function die(msg) {
  console.error(`seed-e2e-catalog: ${msg}`);
  process.exit(1);
}

const productionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sb = localSupabase(productionDir);
if ("reason" in sb) die(sb.reason);
const admin = createClient(sb.url, sb.service, { auth: { autoRefreshToken: false, persistSession: false } });

try {
  const { data: tenants, error: tErr } = await admin.from("tenants").select("id").eq("email", E2E_TENANT_EMAIL);
  if (tErr) throw new Error(`tenants select: ${tErr.message}`);
  if (!tenants?.length) die(`"${E2E_TENANT_NAME}" not found — run E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs first.`);
  if (tenants.length > 1) die(`${tenants.length} tenants carry ${E2E_TENANT_EMAIL}; fix by hand first.`);
  const tenantId = tenants[0].id;

  let itemsAdded = 0;
  for (const p of E2E_CATALOG) {
    const { data: hit, error } = await admin.from("items").select("id, tenant_id").eq("id", p.id).maybeSingle();
    if (error) throw new Error(`items select: ${error.message}`);
    if (hit) {
      if (hit.tenant_id !== tenantId) die(`item ${p.id} exists in another company — not touching it.`);
      continue;
    }
    const { error: insErr } = await admin.from("items").insert({
      ...p, tenant_id: tenantId, kind: "main", item_type: "subscription", is_active: true, prices: {},
    });
    if (insErr) throw new Error(`items insert ${p.id}: ${insErr.message}`);
    itemsAdded++;
  }

  let suppliersAdded = 0;
  for (const v of E2E_SUPPLIERS) {
    const { data: rows, error } = await admin.from("vendors").select("id").eq("tenant_id", tenantId).eq("name", v.name);
    if (error) throw new Error(`vendors select: ${error.message}`);
    if (rows?.length) continue;
    const { error: insErr } = await admin.from("vendors").insert({ ...v, tenant_id: tenantId });
    if (insErr) throw new Error(`vendors insert ${v.name}: ${insErr.message}`);
    suppliersAdded++;
  }

  console.log(`"${E2E_TENANT_NAME}": products ${itemsAdded} added / ${E2E_CATALOG.length - itemsAdded} already there; `
    + `suppliers ${suppliersAdded} added / ${E2E_SUPPLIERS.length - suppliersAdded} already there.`);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
