/* R-2719 (12 Nov 2026) — 09:32 IST the staging deploy-db script failed with HTTP 409: the daily Cloud SQL
   backup was running. The train now waits (a line every 30 s, at most 30 min) before the DB step while it
   is 09:25–10:05 IST or an operation on the staging instance is not DONE. */
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  inBackupWindow, istClock, parseRunningOps, busyReasons, waitForDbClear, listRunningOps,
  STAGING_SQL_PROJECT, STAGING_SQL_INSTANCE, POLL_MS, MAX_WAIT_MS,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../../scripts/ops/staging-db-window.mjs";

const ist = (hhmm: string, day = "2026-11-12") => Date.parse(`${day}T${hhmm}:00+05:30`);
const op = (status: string, operationType = "BACKUP_VOLUME") => ({ status, operationType, startTime: "2026-11-12T04:00:10Z" });

/** A fake clock + sleeper: sleep(ms) moves the clock; logs are collected. */
function fake(startMs: number, opsAt: (t: number) => { ok: boolean; ops: unknown[]; error: string }) {
  let t = startMs;
  const logs: string[] = [];
  const sleeps: number[] = [];
  return {
    logs, sleeps, time: () => t,
    opts: {
      now: () => t,
      sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
      log: (l: string) => { logs.push(l); },
      listOps: () => opsAt(t),
    },
  };
}
const noOps = () => ({ ok: true, ops: [], error: "" });

describe("staging DB step — backup window (R-2719)", () => {
  it("09:25–10:05 IST is the window; 09:24 and 10:05 are outside", () => {
    expect(inBackupWindow(ist("09:24"))).toBe(false);
    expect(inBackupWindow(ist("09:25"))).toBe(true);
    expect(inBackupWindow(ist("09:32"))).toBe(true); // the 12 Nov failure
    expect(inBackupWindow(ist("10:04"))).toBe(true);
    expect(inBackupWindow(ist("10:05"))).toBe(false);
    expect(inBackupWindow(ist("21:30"))).toBe(false);
    expect(istClock(ist("09:32"))).toBe("09:32");
  });

  it("reads gcloud's JSON: only operations that are not DONE count", () => {
    const text = JSON.stringify([op("RUNNING"), op("DONE", "IMPORT"), op("PENDING", "IMPORT"), op("done")]);
    expect(parseRunningOps(text)).toEqual([
      { type: "BACKUP_VOLUME", status: "RUNNING", startTime: "2026-11-12T04:00:10Z" },
      { type: "IMPORT", status: "PENDING", startTime: "2026-11-12T04:00:10Z" },
    ]);
    expect(parseRunningOps("")).toEqual([]);
    expect(parseRunningOps("[]")).toEqual([]);
    expect(() => parseRunningOps("ERROR: not logged in")).toThrow();
    expect(() => parseRunningOps('{"error":1}')).toThrow(/JSON array/);
  });

  it("says why it is busy — the clock and each running operation", () => {
    expect(busyReasons(ist("14:00"), [])).toEqual([]);
    expect(busyReasons(ist("09:32"), []).join()).toMatch(/09:32 IST.*09:25–10:05 IST/);
    const r = busyReasons(ist("14:00"), parseRunningOps(JSON.stringify([op("RUNNING")])));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/BACKUP_VOLUME \(RUNNING/);
  });

  it("the instance it reads is the one the staging deploy-db script writes to", () => {
    const dir = path.resolve(__dirname, "../../supabase/cloudsql/staging");
    const newest = readdirSync(dir).filter((n) => /^deploy-db-\d{4}-\d{2}-\d{2}\.sh$/.test(n)).sort().pop()!;
    const src = readFileSync(path.join(dir, newest), "utf8");
    expect(src).toMatch(new RegExp(`^P=${STAGING_SQL_PROJECT}$`, "m"));
    expect(src).toMatch(new RegExp(`^I=${STAGING_SQL_INSTANCE}$`, "m"));
    expect(STAGING_SQL_INSTANCE).toMatch(/staging/);
  });
});

describe("staging DB step — the wait (R-2719)", () => {
  it("free time, nothing running → goes at once: one 'go' line, no sleep", async () => {
    const f = fake(ist("14:00"), noOps);
    expect(await waitForDbClear(f.opts)).toEqual({ clear: true, waitedMs: 0, reasons: [], opsRead: true });
    expect(f.sleeps).toEqual([]);
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toMatch(/Cloud SQL khaali.*DB step chala sakte ho/);
  });

  it("12 Nov case, 09:58 IST: waits with a clear line every 30 s until 10:05, then says go", async () => {
    const f = fake(ist("09:58"), noOps);
    const r = await waitForDbClear(f.opts);
    expect(r.clear).toBe(true);
    expect(r.waitedMs).toBe(7 * 60_000);
    expect(f.sleeps).toHaveLength(14);
    expect(new Set(f.sleeps)).toEqual(new Set([POLL_MS]));
    expect(POLL_MS).toBe(30_000);
    expect(f.logs[0]).toMatch(/DB step ruka hai.*09:58 IST.*backup.*30 s me dobara/);
    expect(f.logs.at(-1)).toMatch(/Cloud SQL khaali \(7 min ruke\)/);
  });

  it("a RUNNING operation outside the window also waits, until it is DONE", async () => {
    const start = ist("15:00");
    const f = fake(start, (t) => ({ ok: true, ops: t - start < 90_000 ? parseRunningOps(JSON.stringify([op("RUNNING", "IMPORT")])) : [], error: "" }));
    const r = await waitForDbClear(f.opts);
    expect(r).toMatchObject({ clear: true, waitedMs: 90_000 });
    expect(f.logs[0]).toMatch(/IMPORT \(RUNNING/);
  });

  it("gives up after 30 min — clear:false, says do NOT run the DB step, never waits longer", async () => {
    const f = fake(ist("09:25"), noOps); // window lasts 40 min
    const r = await waitForDbClear(f.opts);
    expect(MAX_WAIT_MS).toBe(30 * 60_000);
    expect(r.clear).toBe(false);
    expect(r.waitedMs).toBe(MAX_WAIT_MS);
    expect(r.reasons.join()).toMatch(/09:55 IST/);
    expect(f.sleeps.reduce((a, b) => a + b, 0)).toBe(MAX_WAIT_MS);
    expect(f.logs.join("\n")).toMatch(/30 min ruke.*ABHI MAT chalao.*409[\s\S]*--db-wait/);
  });

  it("gcloud cannot be read → one warning, the clock is still obeyed, and it never blocks outside the window", async () => {
    const broken = () => ({ ok: false, ops: [], error: "not logged in" });
    const free = fake(ist("16:00"), broken);
    expect((await waitForDbClear(free.opts)).clear).toBe(true);
    expect(free.logs).toHaveLength(2);
    expect(free.logs[0]).toMatch(/padh nahi paaye \(not logged in\)/);
    // it never says "Cloud SQL is free" about operations it could not read
    expect(free.logs[1]).toMatch(/operations padhe nahi gaye.*409/);
    expect(free.logs.join()).not.toMatch(/Cloud SQL khaali/);

    const inWindow = fake(ist("10:03"), broken);
    const r = await waitForDbClear(inWindow.opts);
    expect(r).toMatchObject({ clear: true, waitedMs: 2 * 60_000, opsRead: false });
    expect(inWindow.logs.filter((l) => /padh nahi paaye/.test(l))).toHaveLength(1);
  });

  it("listRunningOps only READS: `gcloud sql operations list` on the staging instance, and reports failures as ok:false", () => {
    const calls: string[][] = [];
    const run = (_bin: string, args: string[]) => { calls.push(args); return { status: 0, stdout: JSON.stringify([op("RUNNING"), op("DONE")]), stderr: "" }; };
    const r = listRunningOps({ run });
    expect(r.ok).toBe(true);
    expect(r.ops).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual(["sql", "operations", "list"]);
    expect(calls[0]).toContain(`--instance=${STAGING_SQL_INSTANCE}`);
    expect(calls[0]).toContain(`--project=${STAGING_SQL_PROJECT}`);
    expect(listRunningOps({ run: () => ({ status: 1, stdout: "", stderr: "ERROR: (gcloud) You do not currently have an active account\nmore" }) }))
      .toEqual({ ok: false, ops: [], error: "ERROR: (gcloud) You do not currently have an active account" });
    expect(listRunningOps({ run: () => ({ error: new Error("ENOENT gcloud") }) })).toMatchObject({ ok: false, error: "ENOENT gcloud" });
    expect(listRunningOps({ run: () => ({ status: 0, stdout: "not json", stderr: "" }) }).ok).toBe(false);
  });
});
