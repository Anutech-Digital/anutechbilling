import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/* R-1775 (23 Oct 2026): staging wipe of ONE company's data. The script must refuse before it ever
   calls gcloud when CONFIRM is missing/different or the instance is not staging, and the SQL test
   must exercise the very same CORE the script ships. */

const ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(ROOT, "supabase/cloudsql/staging/wipe-tenant-transactions.sh");
const SQL = path.join(ROOT, "supabase/cloudsql/staging/wipe-tenant-transactions.sql");
const TEST_SQL = path.join(ROOT, "supabase/tests/wipe_tenant_transactions_r1775.test.sql");
const ID = "0b2c3d4e-1111-4222-8333-944455556666";

const BASH =
  process.platform === "win32"
    ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find((p) => existsSync(p)) ?? null
    : spawnSync("bash", ["--version"]).status === 0
      ? "bash"
      : null;

/** C:\a\b -> /c/a/b for Git bash; unchanged elsewhere. */
const bashPath = (p: string) =>
  process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, "/") : p;

function core(file: string) {
  const s = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const a = s.indexOf("-- >>> R-1775 CORE (begin)");
  const end = "-- <<< R-1775 CORE (end)";
  const b = s.indexOf(end);
  expect(a, `${file} has the CORE begin marker`).toBeGreaterThanOrEqual(0);
  expect(b, `${file} has the CORE end marker`).toBeGreaterThan(a);
  return s.slice(a, b + end.length);
}

describe("R-1775 wipe — SQL", () => {
  it("the SQL test runs byte-for-byte the CORE the staging script ships", () => {
    expect(core(TEST_SQL)).toBe(core(SQL));
  });

  it("keep-list is logins, settings, secrets/keys, numbering and the bug reports only (Pardeep, 23 Oct)", () => {
    const s = readFileSync(SQL, "utf8");
    const m = s.match(/function pg_temp\.r1775_keep\(\)[\s\S]*?\$f\$([\s\S]*?)\$f\$/);
    expect(m).not.toBeNull();
    const keep = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(keep).toEqual(
      [
        "users", "user_google_tokens", "push_subscriptions", "api_keys", "team_invites", "join_requests",
        "personal_vault_pin", "attendance_settings", "whatsapp_reminder_settings", "ai_autonomy", "demo_tenants",
        "tenant_domains", "document_series", "customer_number_seq", "tenant_secrets", "ad_accounts",
        "gbp_locations", "indiamart_sync_state", "feedback", "feedback_screenshots", "feedback_votes",
      ].sort(),
    );
  });

  it("the SQL test rolls back and never commits", () => {
    const s = readFileSync(TEST_SQL, "utf8");
    expect(s).toMatch(/^\s*rollback\s*;/im);
    expect(s).not.toMatch(/^\s*commit\s*;/im);
  });
});

describe.skipIf(!BASH)("R-1775 wipe — script guards (fake gcloud on PATH)", () => {
  let dir = "";
  let log = "";

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "r1775-"));
    log = path.join(dir, "gcloud.log");
    // A fake gcloud: records every call and plays a staging that answers a dry run.
    const fake = `#!/usr/bin/env bash
echo "$*" >> "${bashPath(log)}"
case "$*" in
  *"config get-value account"*) echo "pardeep@example.test" ;;
  *"instances describe"*) echo "resellersos-staging-db" ;;
  *"backups list"*"value(status)"*) echo "SUCCESSFUL" ;;
  *"backups list"*"value(id)"*) echo "1761190000000" ;;
  *"sql import"*) exit 1 ;;
  *"operations list"*"--format=json"*) printf '[{"error":{"errors":[{"message":"ERROR:  WIPEDRY company: Anutech Digital | ${ID} | 07AAAAA0000A1Z5 || DELETE{total=3 customers=3} || tables with 0 rows: 170 || KEEP{users=4} || rehearsal ok\\\\nCONTEXT: x"}]}}]\\n' ;;
esac
exit 0
`;
    const gcloud = path.join(dir, "gcloud");
    writeFileSync(gcloud, fake.replace(/\r\n/g, "\n"));
    chmodSync(gcloud, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(env: Record<string, string>) {
    rmSync(log, { force: true });
    const assigns = Object.entries(env).map(([k, v]) => `${k}='${v}'`).join(" ");
    const r = spawnSync(BASH!, ["-c", `PATH="${bashPath(dir)}:$PATH" ${assigns} "${bashPath(SCRIPT)}"`], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, APPLY: "", TENANTS: "", CONFIRM: "", INSTANCE: "", ANUTECH_MATCH: "" },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
  }

  it("APPLY=1 without CONFIRM is refused before any gcloud call", () => {
    const r = run({ APPLY: "1", TENANTS: ID });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/REFUSED: APPLY=1 needs CONFIRM/);
    expect(r.calls).toBe("");
  });

  it("CONFIRM different from TENANTS is refused before any gcloud call", () => {
    const r = run({ APPLY: "1", TENANTS: ID, CONFIRM: ID.replace("6666", "6667") });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/CONFIRM .* is not the same as TENANTS/);
    expect(r.calls).toBe("");
  });

  it("the live instance (or any non-staging one) is refused before any gcloud call", () => {
    for (const inst of ["resellersos-db", "resellersos-staging-db-copy"]) {
      const r = run({ INSTANCE: inst });
      expect(r.status).toBe(2);
      expect(r.out).toMatch(/REFUSED: instance '.*' is not resellersos-staging-db/);
      expect(r.calls).toBe("");
    }
  });

  it("E2E Test Co's id and SKIP_BACKUP with APPLY are refused", () => {
    const e2e = "f588b89d-6ba2-4abe-b8b3-e4821a65e7b4";
    expect(run({ APPLY: "1", TENANTS: e2e, CONFIRM: e2e }).out).toMatch(/E2E Test Co/);
    const r = run({ APPLY: "1", TENANTS: ID, CONFIRM: ID, SKIP_BACKUP: "1" });
    expect(r.out).toMatch(/SKIP_BACKUP is not allowed/);
    expect(r.calls).toBe("");
  });

  it("default is a dry run: backup first, never an apply import, prints the apply command with the id", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Anutech Digital \| 0b2c3d4e/);
    expect(r.out).toMatch(/DRY RUN DONE - nothing changed/);
    expect(r.out).toContain(`$env:TENANTS="${ID}"; $env:CONFIRM="${ID}"`);
    const calls = r.calls.split("\n");
    const backup = calls.findIndex((c) => c.includes("backups create"));
    const imp = calls.findIndex((c) => c.includes("sql import"));
    expect(backup).toBeGreaterThanOrEqual(0);
    expect(imp).toBeGreaterThan(backup);
    expect(r.calls).toContain("--instance=resellersos-staging-db");
    expect(r.calls).toContain("r1775-wipe-dry.sql");
    expect(r.calls).not.toContain("r1775-wipe-apply.sql");
  });
});
