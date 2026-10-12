/**
 * Delete tenants by EXPLICIT id, keeping one named survivor.
 *
 * ─── WHY THE IDS ARE LISTED, NOT DERIVED ────────────────────────────────────
 * The obvious form is `delete from tenants where id <> keeper`. Do not use it: a
 * single mistyped character in `keeper` deletes EVERY tenant including the one
 * you meant to save, and the statement looks correct while doing it. Listing the
 * victims explicitly inverts the failure — a typo then spares a tenant, which is
 * a phone call, not a catastrophe.
 *
 * ─── GUARDS ─────────────────────────────────────────────────────────────────
 *   · the keeper must exist, and must NOT appear in the delete list
 *   · every id in the list must exist (a stale id means the list is out of date)
 *   · dry-run by default, printing exactly what each tenant holds
 *   · refuses if an off-database backup directory is not named
 *
 * The in-app snapshots do NOT protect this operation: backup.snapshots.tenant_id
 * cascades (0211), so a tenant's snapshots die with it. The only undo is the file
 * dump from scripts/backup-tenant-data.mjs.
 *
 *   node scripts/delete-tenants.mjs --backup "<dir>"            # dry run
 *   node scripts/delete-tenants.mjs --backup "<dir>" --apply
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const KEEPER = "fbb976f1-9090-4f10-9726-0901bd144e42";       // ANUTECH DIGITAL PVT LTD
const DELETE_IDS = [
  "4eeab895-6f4e-42ea-aaf2-efe4cfbc2129",  // Democo
  "606a7ae7-9805-4a10-8163-7da6e42968e9",  // Gamma Co
  "13a364c7-d057-4725-876f-32376c8dd3c9",  // Demo Co
  "f2fb0254-68d9-4e57-9be3-4b77c113d33a",  // Anutech
];

const APPLY = process.argv.includes("--apply");
const bIdx = process.argv.indexOf("--backup");
const BACKUP_DIR = bIdx > -1 ? process.argv[bIdx + 1] : null;

if (!BACKUP_DIR) {
  console.error("Refusing: pass --backup \"<dir>\" naming the off-database dump that protects this.");
  process.exit(2);
}
if (!existsSync(join(BACKUP_DIR, "manifest.json"))) {
  console.error(`Refusing: no manifest.json in ${BACKUP_DIR}. That is not a completed backup.`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(BACKUP_DIR, "manifest.json"), "utf8"));
const failedTables = Object.entries(manifest.tables ?? {}).filter(([, v]) => v.error);
if (failedTables.length) {
  console.error(`Refusing: the backup has ${failedTables.length} failed table(s). Fix it before deleting.`);
  process.exit(2);
}

if (DELETE_IDS.includes(KEEPER)) {
  console.error("Refusing: the keeper is in the delete list. This script would destroy the survivor.");
  process.exit(2);
}
if (new Set(DELETE_IDS).size !== DELETE_IDS.length) {
  console.error("Refusing: duplicate ids in the delete list.");
  process.exit(2);
}

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: all, error } = await sb.from("tenants").select("id, name, email").order("created_at");
if (error) { console.error("read failed:", error.message); process.exit(1); }

const keeper = all.find((t) => t.id === KEEPER);
if (!keeper) { console.error(`Refusing: keeper ${KEEPER} not found.`); process.exit(2); }

const missing = DELETE_IDS.filter((id) => !all.some((t) => t.id === id));
if (missing.length) {
  console.error(`Refusing: these ids are not in the database — the list is stale:\n  ${missing.join("\n  ")}`);
  process.exit(2);
}

console.log(`backup   : ${BACKUP_DIR}  (${manifest.tables ? Object.keys(manifest.tables).length : "?"} tables, taken ${manifest.takenAt})`);
console.log(`KEEPING  : ${keeper.name}  (${keeper.id})\n`);

// What each doomed tenant holds, so the number is on screen before the decision.
const COUNTED = ["users", "customers", "quotes", "invoices", "payments", "subscriptions", "leads"];
for (const id of DELETE_IDS) {
  const t = all.find((x) => x.id === id);
  const parts = [];
  for (const table of COUNTED) {
    const { count } = await sb.from(table).select("*", { count: "exact", head: true }).eq("tenant_id", id);
    if (count) parts.push(`${table}=${count}`);
  }
  console.log(`DELETE   : ${t.name.padEnd(24)} ${parts.join("  ") || "(empty)"}`);
}

if (!APPLY) {
  console.log("\nDry run. Nothing was deleted. Re-run with --apply to execute.");
  process.exit(0);
}

console.log("\nDeleting…");
const { error: delErr } = await sb.from("tenants").delete().in("id", DELETE_IDS);
if (delErr) { console.error("DELETE FAILED:", delErr.message); process.exit(1); }

const { data: after } = await sb.from("tenants").select("id, name").order("created_at");
console.log(`\nAFTER — ${after.length} tenant(s):`);
for (const t of after) console.log(`  ${t.name}  (${t.id})`);

if (after.length !== 1 || after[0].id !== KEEPER) {
  console.error("\n! Unexpected final state. Check against the backup before doing anything else.");
  process.exit(1);
}
console.log("\nDone. Only the keeper remains.");
