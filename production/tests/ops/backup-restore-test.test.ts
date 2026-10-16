import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { main, parseArgs, phraseFor, sanitySql, parseSanity, compare, CLONE_PREFIX, LIVE_INSTANCE } from "../../scripts/ops/backup-restore-test.mjs";

/* R-887 (16 Oct 2026): a Cloud SQL backup had never been restored. The script restores the latest
   backup into a temporary clone, counts rows read-only, and always deletes the clone. These tests
   mock gcloud/psql — nothing here touches the cloud. */

const SRC = "resellersos-staging-db";
const NOW = new Date("2026-10-16T09:30:00Z");

type Fake = { psqlStatus?: number; psqlOut?: string; deleteStatus?: number; backups?: string };

/** Mocked gcloud + psql. Records every call so a test can assert what ran (or did not). */
function deps(f: Fake = {}, typed = "") {
  const calls: string[][] = [];
  const logs: string[] = [];
  const exec = (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    if (bin === "gcloud" && args[2] === "describe" && args[3] === SRC) return { status: 0, stdout: "POSTGRES_17 db-f1-micro asia-southeast1 10 ENTERPRISE" };
    if (bin === "gcloud" && args[1] === "backups" && args[2] === "list") return { status: 0, stdout: f.backups ?? "1760000000000 2026-10-16T03:00:00Z" };
    if (bin === "gcloud" && args[2] === "describe") return { status: 0, stdout: "203.0.113.9" };
    if (bin === "gcloud" && args[2] === "delete") return { status: f.deleteStatus ?? 0, stdout: "" };
    if (bin === "psql") return { status: f.psqlStatus ?? 0, stdout: f.psqlOut ?? okOut };
    return { status: 0, stdout: "" };
  };
  return { calls, logs, exec, ask: async () => typed, log: (l: string) => logs.push(l), now: NOW };
}

const okOut = ["count|tenants|3", "count|users|7", "count|customers|12", "count|invoices|40", "count|payments|30", "count|subscriptions|5",
  "count|employees|2", "count|activity_log|100", "ledger|supabase_migrations|20261015120000", "ledger|prisma_migrations|"].join("\n");

const RUN = [`--instance=${SRC}`, "--run", "--client-ip=198.51.100.7"];
const created = (d: ReturnType<typeof deps>) => d.calls.filter((c) => c[0] === "gcloud" && c[3] === "create");
const deleted = (d: ReturnType<typeof deps>) => d.calls.filter((c) => c[0] === "gcloud" && c[3] === "delete");

describe("R-887 backup-restore-test — dry run is the default", () => {
  it("runs nothing, prints every command it would run and the cost note", async () => {
    const d = deps();
    expect(await main([`--instance=${SRC}`], d)).toBe(0);
    expect(d.calls).toEqual([]);
    const out = d.logs.join("\n");
    expect(out).toContain("DRY RUN");
    expect(out).toContain("COST:");
    for (const step of ["sql instances describe", "sql backups list", "sql instances create", "sql backups restore", "sql users set-password", "psql", "sql instances delete"]) {
      expect(out).toContain(step);
    }
    expect(out).not.toContain("--password=\"");
    expect(out).toContain("[dry-run]");
  });
});

describe("R-887 backup-restore-test — refusals", () => {
  it("--run without the typed phrase is refused; nothing created", async () => {
    const d = deps({}, "yes");
    expect(await main(RUN, d)).toBe(1);
    expect(d.logs.join("\n")).toContain("REFUSED: confirmation phrase");
    expect(d.calls).toEqual([]);
  });

  it("--run with a wrong --confirm is refused; a right one proceeds", async () => {
    const bad = deps();
    expect(await main([...RUN, "--confirm=RESTORE TEST resellersos-db"], bad)).toBe(1);
    expect(bad.calls).toEqual([]);
    const good = deps();
    expect(await main([...RUN, `--confirm=${phraseFor(SRC)}`], good)).toBe(0);
    expect(created(good)).toHaveLength(1);
  });

  it("--run without --client-ip is refused", async () => {
    const d = deps({}, phraseFor(SRC));
    expect(await main([`--instance=${SRC}`, "--run"], d)).toBe(1);
    expect(d.calls).toEqual([]);
  });

  it("the live instance is refused without --allow-live-source, even in dry run", async () => {
    const d = deps();
    expect(await main([`--instance=${LIVE_INSTANCE}`], d)).toBe(1);
    expect(d.logs.join("\n")).toContain("REFUSED");
    expect(d.calls).toEqual([]);
    const ok = deps();
    expect(await main([`--instance=${LIVE_INSTANCE}`, "--allow-live-source"], ok)).toBe(0);
    expect(ok.calls).toEqual([]); // still a dry run
  });

  it("no SUCCESSFUL backup → fails before creating anything", async () => {
    const d = deps({ backups: "" }, phraseFor(SRC));
    expect(await main(RUN, d)).toBe(1);
    expect(created(d)).toHaveLength(0);
    expect(deleted(d)).toHaveLength(0);
  });
});

describe("R-887 backup-restore-test — real run (mocked)", () => {
  it("creates the clone, restores the backup INTO it, counts, deletes; PASS", async () => {
    const d = deps({}, phraseFor(SRC));
    expect(await main(RUN, d)).toBe(0);
    const c = created(d)[0];
    expect(c[4]).toMatch(new RegExp(`^${CLONE_PREFIX}\\d{12}$`));
    expect(c).toContain("--authorized-networks=198.51.100.7/32");
    expect(c).toContain("--no-deletion-protection");
    const restore = d.calls.find((x) => x[2] === "backups" && x[3] === "restore")!;
    expect(restore).toContain(`--restore-instance=${c[4]}`);
    expect(restore).toContain(`--backup-instance=${SRC}`);
    const psql = d.calls.find((x) => x[0] === "psql")!;
    expect(psql[1]).toContain("host=203.0.113.9");
    expect(deleted(d)).toEqual([["gcloud", "sql", "instances", "delete", c[4], "--project=resellsubsos-prod", "--quiet"]]);
    expect(d.logs.join("\n")).toContain("RESULT: PASS");
    // the source instance is never written
    expect(d.calls.filter((x) => x[0] === "gcloud" && x.includes(SRC) && !["describe", "list", "restore"].includes(x[3]))).toEqual([]);
  });

  it("clone is deleted even when the sanity query fails", async () => {
    const d = deps({ psqlStatus: 2 }, phraseFor(SRC));
    expect(await main(RUN, d)).toBe(1);
    expect(deleted(d)).toHaveLength(1);
    expect(d.logs.join("\n")).toContain("FAILED: sanity queries failed");
    expect(d.logs.join("\n")).toContain("deleted.");
  });

  it("counts below the minimum → FAIL, clone still deleted", async () => {
    const d = deps({ psqlOut: okOut.replace("count|tenants|3", "count|tenants|0") }, phraseFor(SRC));
    expect(await main(RUN, d)).toBe(1);
    expect(d.logs.join("\n")).toContain("tenants: 0 rows, expected at least 1");
    expect(deleted(d)).toHaveLength(1);
  });

  it("prints the delete command loudly when the delete itself fails", async () => {
    const d = deps({ deleteStatus: 1 }, phraseFor(SRC));
    await main(RUN, d);
    const out = d.logs.join("\n");
    expect(out).toContain("CLONE NOT DELETED");
    expect(out).toMatch(/gcloud sql instances delete r887-restore-test-\d{12} --project=resellsubsos-prod --quiet/);
  });
});

describe("R-887 helpers", () => {
  it("parseArgs: --min overrides, bad args throw", () => {
    const o = parseArgs([`--instance=${SRC}`, "--min=customers=10"]);
    expect(o.mins.customers).toBe(10);
    expect(o.mins.tenants).toBe(1);
    expect(() => parseArgs([])).toThrow(/--instance/);
    expect(() => parseArgs([`--instance=${SRC}`, "--min=customers=x"])).toThrow(/table=N/);
    expect(() => parseArgs(["--instance=Bad_Name"])).toThrow(/bad instance/);
    expect(() => parseArgs([`--instance=${SRC}`, "--client-ip=nope"])).toThrow(/IPv4/);
    expect(() => parseArgs([`--instance=${SRC}`, "--delete-everything"])).toThrow(/unknown argument/);
  });

  it("sanitySql is a single read-only SELECT over the key tables + ledger", () => {
    const sql = sanitySql();
    expect(sql).toContain("public.invoices");
    expect(sql).toContain("supabase_migrations.schema_migrations");
    expect(sql).not.toMatch(/\b(insert|update|delete|drop|alter|truncate)\b/i);
  });

  it("parseSanity + compare: missing table and empty ledger are failures", () => {
    const r = parseSanity("count|tenants|2\ncount|users|-1\nledger|supabase_migrations|\nledger|prisma_migrations|");
    expect(r.counts).toEqual({ tenants: 2, users: -1 });
    const fails = compare(r, { tenants: 1, users: 1, customers: 0 });
    expect(fails).toContain("users: table missing in the restore");
    expect(fails).toContain("customers: no count returned");
    expect(fails.some((f: string) => f.startsWith("migration ledger"))).toBe(true);
  });
});
