#!/usr/bin/env node
/**
 * seed-e2e-tenant.mjs — creates the ONE logged-in E2E test company (R-053).
 *
 *   E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs      (from production/)
 *
 * Creates, idempotently (re-run any time; nothing is duplicated, nothing is deleted):
 *   - tenant "E2E Test Co" (found again by its marker email e2e-company@example.test)
 *   - four users in it: owner, manager, sales, accountant
 *     (+ R-2318: a second owner "owner2", only when E2E_OWNER2_PASSWORD is set — local only)
 *       email    = E2E_<ROLE>_EMAIL    (default e2e-<role>@example.test)
 *       password = E2E_<ROLE>_PASSWORD (REQUIRED — no default, never printed)
 *     An existing auth user gets its password reset to the env value, so the specs and
 *     the seed can never disagree.
 *   - one customer "E2E Customer Pvt Ltd" (same state → CGST+SGST invoices)
 *   - one bank account "E2E Bank Current A/c" (payroll "Pay from")
 *   - one vendor "E2E Vendor Pvt Ltd" with a synthetic GSTIN (expense → input GST)
 *
 * Everything else (invoices, credit notes, subscriptions, employees …) is created by the
 * specs themselves, through the app, with "E2E …" names.
 *
 * Needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY, from the
 * environment or production/.env.test. Local:  `npx supabase status -o env` has both.
 *
 * REFUSES TO RUN:
 *   - without E2E_ALLOW_SEED=1;
 *   - when the Supabase URL, PLAYWRIGHT_BASE_URL or NEXT_PUBLIC_APP_URL is a production
 *     host (hard-coded deny list in e2e-roles.mjs — there is no override);
 *   - when an E2E email already belongs to a user of ANOTHER company (it would otherwise
 *     reset a real person's password).
 *
 * Output names variables and ids only — never a key or a password.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import {
  E2E_ROLES, E2E_LOCAL_EXTRA_ROLES, E2E_TENANT_NAME, E2E_TENANT_EMAIL, E2E_CUSTOMER_NAME,
  E2E_BANK_NAME, E2E_VENDOR_NAME, E2E_VENDOR_GSTIN,
  roleCreds, roleEnvNames, roleDbRole, productionHostReason,
} from "./e2e-roles.mjs";

function die(msg) {
  console.error(`seed-e2e-tenant: ${msg}`);
  process.exit(1);
}

/* Same loader as playwright.config.ts: .env.test only, existing env wins. */
if (fs.existsSync(".env.test")) {
  for (const line of fs.readFileSync(".env.test", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

if (process.env.E2E_ALLOW_SEED !== "1") {
  die("refusing to run without E2E_ALLOW_SEED=1 (this creates users and resets their passwords).");
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  die("needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in env or .env.test.");
}
for (const [name, value] of [
  ["SUPABASE_URL", SUPABASE_URL],
  ["PLAYWRIGHT_BASE_URL", process.env.PLAYWRIGHT_BASE_URL],
  ["NEXT_PUBLIC_APP_URL", process.env.NEXT_PUBLIC_APP_URL],
]) {
  const why = productionHostReason(value);
  if (why) die(`${name} points at production (${why}). The E2E seed never runs there.`);
}

const missing = E2E_ROLES.map((r) => roleEnvNames(r).password).filter((n) => !process.env[n]);
if (missing.length) die(`missing password env vars: ${missing.join(", ")}`);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findAuthUser(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
}

async function ensureTenant() {
  const { data: rows, error } = await admin
    .from("tenants").select("id, name").eq("email", E2E_TENANT_EMAIL);
  if (error) throw new Error(`tenants select: ${error.message}`);
  if (rows.length > 1) throw new Error(`${rows.length} tenants carry ${E2E_TENANT_EMAIL}; fix by hand first.`);
  if (rows.length === 1) {
    if (rows[0].name !== E2E_TENANT_NAME) {
      const { error: e } = await admin.from("tenants").update({ name: E2E_TENANT_NAME }).eq("id", rows[0].id);
      if (e) throw new Error(`tenants rename: ${e.message}`);
    }
    return { id: rows[0].id, created: false };
  }
  const { data, error: insErr } = await admin.from("tenants").insert({
    name: E2E_TENANT_NAME,
    email: E2E_TENANT_EMAIL,
    gstin: "27AAACE2053E1Z5", // format-valid, synthetic
    state: "Maharashtra",
    state_code: "27",
    address: "E2E Test Street, Mumbai",
  }).select("id").single();
  if (insErr) throw new Error(`tenants insert: ${insErr.message}`);
  return { id: data.id, created: true };
}

/** "E2E Owner", … ; R-2318: "owner2" → "E2E Owner 2". */
function roleFullName(role) {
  const m = /^([a-z]+)(\d*)$/.exec(role);
  const base = m ? m[1] : role;
  return `E2E ${base[0].toUpperCase()}${base.slice(1)}${m && m[2] ? ` ${m[2]}` : ""}`;
}

async function ensureUser(tenantId, role) {
  const { email, password } = roleCreds(role);
  const fullName = roleFullName(role);
  let authUser = await findAuthUser(email);

  if (authUser) {
    // Guard: never take over somebody who works in a real company.
    const { data: pub, error } = await admin
      .from("users").select("tenant_id").eq("id", authUser.id).maybeSingle();
    if (error) throw new Error(`users select (${role}): ${error.message}`);
    if (pub && pub.tenant_id !== tenantId) {
      throw new Error(
        `${roleEnvNames(role).email} = ${email} already belongs to a user of another company. ` +
        "Pick a dedicated test address; the seed will not reset that account.",
      );
    }
    const { error: upErr } = await admin.auth.admin.updateUserById(authUser.id, {
      password, email_confirm: true, user_metadata: { full_name: fullName, e2e: true },
    });
    if (upErr) throw new Error(`auth update (${role}): ${upErr.message}`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName, e2e: true },
    });
    if (error) throw new Error(`auth create (${role}): ${error.message}`);
    authUser = data.user;
  }

  const initials = `E${(/\d$/.exec(role)?.[0]) ?? role[0].toUpperCase()}`;
  const { error: upsertErr } = await admin.from("users").upsert({
    id: authUser.id,
    tenant_id: tenantId,
    email,
    full_name: fullName,
    initials,
    role: roleDbRole(role),
    is_active: true,
    can_view_deals: true,
  }, { onConflict: "id" });
  if (upsertErr) throw new Error(`users upsert (${role}): ${upsertErr.message}`);
  return { role, email, id: authUser.id };
}

async function ensureCustomer(tenantId) {
  const { data: rows, error } = await admin
    .from("customers").select("id").eq("tenant_id", tenantId).eq("name", E2E_CUSTOMER_NAME);
  if (error) throw new Error(`customers select: ${error.message}`);
  if (rows.length) return { id: rows[0].id, created: false };
  const { data, error: insErr } = await admin.from("customers").insert({
    tenant_id: tenantId,
    name: E2E_CUSTOMER_NAME,
    state: "Maharashtra",
    state_code: "27",
    country: "India",
    customer_type: "business",
    contact_name: "E2E Contact",
    contact_email: "e2e-customer@example.test",
  }).select("id").single();
  if (insErr) throw new Error(`customers insert: ${insErr.message}`);
  return { id: data.id, created: true };
}

/** Find-or-insert by (tenant, name). Used for the small reference rows below. */
async function ensureNamed(table, tenantId, name, row) {
  const { data: rows, error } = await admin
    .from(table).select("id").eq("tenant_id", tenantId).eq("name", name);
  if (error) throw new Error(`${table} select: ${error.message}`);
  if (rows.length) return { id: rows[0].id, created: false };
  const { data, error: insErr } = await admin
    .from(table).insert({ tenant_id: tenantId, name, ...row }).select("id").single();
  if (insErr) throw new Error(`${table} insert: ${insErr.message}`);
  return { id: data.id, created: true };
}

try {
  const host = new URL(SUPABASE_URL).host;
  const tenant = await ensureTenant();
  console.log(`tenant  "${E2E_TENANT_NAME}"  ${tenant.id}  ${tenant.created ? "created" : "exists"}  (supabase: ${host})`);
  for (const role of E2E_ROLES) {
    const u = await ensureUser(tenant.id, role);
    console.log(`user    ${u.role.padEnd(10)} ${u.email}  ${u.id}`);
  }
  // R-2318: local-only extra logins (a second owner) — seeded only when their password is set.
  for (const role of E2E_LOCAL_EXTRA_ROLES) {
    if (!process.env[roleEnvNames(role).password]) {
      console.log(`user    ${role.padEnd(10)} skipped — ${roleEnvNames(role).password} not set (local-only login)`);
      continue;
    }
    const u = await ensureUser(tenant.id, role);
    console.log(`user    ${u.role.padEnd(10)} ${u.email}  ${u.id}`);
  }
  const cust = await ensureCustomer(tenant.id);
  console.log(`customer "${E2E_CUSTOMER_NAME}"  ${cust.id}  ${cust.created ? "created" : "exists"}`);
  // W13 payroll: "Pay from" needs an active bank account.
  const bank = await ensureNamed("bank_accounts", tenant.id, E2E_BANK_NAME, {
    bank_name: "E2E Test Bank", account_type: "current", opening_balance: 0,
  });
  console.log(`bank    "${E2E_BANK_NAME}"  ${bank.id}  ${bank.created ? "created" : "exists"}`);
  // W10: an expense only counts as input GST when its vendor has a valid GSTIN.
  const vendor = await ensureNamed("vendors", tenant.id, E2E_VENDOR_NAME, { gstin: E2E_VENDOR_GSTIN });
  console.log(`vendor  "${E2E_VENDOR_NAME}"  ${vendor.id}  ${vendor.created ? "created" : "exists"}`);
  console.log("done — passwords were taken from env and are not printed.");
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
