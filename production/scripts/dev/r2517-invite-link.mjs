#!/usr/bin/env node
/**
 * R-2517 local test data — an invite from ANOTHER company to the Sales test login, with an emailed
 * link. Locally invite emails are only stubbed (no inbox), so this prints the link the email would
 * carry.
 *
 *   node scripts/dev/r2517-invite-link.mjs           (re)load it; prints ONE line: the accept link
 *   node scripts/dev/r2517-invite-link.mjs --clear   remove it
 *
 * Company "CT R2517 Invite Co" (owner ct-r2517-owner@example.test — no password, never signs in)
 * invites e2e-sales@example.test (Local test login → Sales, works in E2E Test Co) as Support. Only
 * the token's sha256 goes into membership_invites.token_hash, like the app. A reload makes a NEW
 * token (the older link stops working) and re-opens the invite. Used by e2e/cards/R-2517.spec.ts.
 *
 * LOCAL docker DB only — refuses (exit 1) like scenario.mjs when the app does not read the local DB.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioTargetReason } from "./local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../../e2e/fixtures/e2e-roles.mjs";

const PROD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const R2517 = {
  tenant: "c2517000-0000-4000-8000-000000000001",
  owner: "c2517000-0000-4000-8000-000000000002",
  ownerEmail: "ct-r2517-owner@example.test",
  name: "CT R2517 Invite Co",
  invitee: "e2e-sales@example.test",
  role: "support",
};

function container() {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const c = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
  const env = {};
  const f = path.join(PROD, ".env.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL", "DIRECT_URL"];
  const why = scenarioTargetReason({ nodeEnv: process.env.NODE_ENV, container: c, urls: keys.flatMap((k) => [process.env[k], env[k]]) });
  if (why || !c) throw new Error(`r2517-invite-link refuses to write test data: ${why ?? "no local DB container"}`);
  return c;
}

function psql(c, sql) {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function clearSql(e2eTenant) {
  const { tenant, owner, invitee } = R2517;
  return `
    -- the Sales login back in E2E Test Co if it was switched into the test company
    select public.r2477_select_membership(u.id, '${e2eTenant}')
      from public.users u where lower(u.email) = '${invitee}' and u.tenant_id = '${tenant}';
    delete from public.membership_invites where tenant_id = '${tenant}';
    delete from public.activity_log where tenant_id = '${tenant}';
    delete from public.tenant_memberships where tenant_id = '${tenant}';
    delete from public.users where id = '${owner}';
    delete from auth.users where id = '${owner}';
    delete from public.tenants where id = '${tenant}';`;
}

export function loadR2517({ clear = false } = {}) {
  const c = container();
  const t = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (t.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${t.length}`);
  const e2eTenant = t[0];
  if (psql(c, `select count(*) from public.users where lower(email) = '${R2517.invitee}';`)[0] !== "1") {
    throw new Error(`${R2517.invitee} has no login in the local DB — run the E2E seed first`);
  }
  if (clear) {
    psql(c, `begin; ${clearSql(e2eTenant)} commit;`);
    return null;
  }
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const { tenant, owner, ownerEmail, name, invitee, role } = R2517;
  psql(c, `begin;
    ${clearSql(e2eTenant)}
    insert into auth.users (id, email, last_sign_in_at) values ('${owner}', '${ownerEmail}', now());
    insert into public.tenants (id, name, email, state_code, doc_code) values ('${tenant}', '${name}', 'ct-r2517-co@example.test', '07', 'CT17');
    insert into public.users (id, tenant_id, email, full_name, role, is_active)
      values ('${owner}', '${tenant}', '${ownerEmail}', 'CT R2517 Owner', 'owner', true);
    insert into public.membership_invites (tenant_id, user_id, email, role, invited_by, token_hash)
      select '${tenant}', u.id, '${invitee}', '${role}', '${owner}', '${hash}'
        from public.users u where lower(u.email) = '${invitee}';
    commit;`);
  return token;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const clear = process.argv.includes("--clear");
    const token = loadR2517({ clear });
    const port = process.env.PORT || "3001";
    console.log(clear ? "R-2517 test invite removed." : `http://localhost:${port}/invites/accept#token=${token}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
