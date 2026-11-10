import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { ciAllReport, LOCK_STATES, CI_EXIT, lockAfterCi } from "../../scripts/ops/worker-lock.mjs";

/* R-2552 (7 Nov 2026): a worker used to sit 30–40 min in `worker-lock ci <CARD>` after its push
   (WORKER-STEPS 5b). Now it hands back right after the push and the manager runs `ci-all` once:
   every ci-wait lock's CI verdict, green ones freed — the same thing `ci <CARD>` green does. */
type Lock = { card: string; areas: string[]; state?: string; pushedSha?: string };
const lk = (card: string, state?: string, pushedSha?: string): Lock => ({ card, areas: ["src/lib/x"], ...(state ? { state } : {}), ...(pushedSha ? { pushedSha } : {}) });

describe("worker-lock ci-all (R-2552)", () => {
  it("the settle codes do what ci <CARD> does: green frees the lock, red keeps the files as ci-red", () => {
    const l = { ...lk("R-1", LOCK_STATES.ciWait, "aaaaaaaaaaaa"), files: ["src/lib/x/a.ts"] };
    expect(lockAfterCi(l, CI_EXIT.green, { at: "2026-11-07T10:00:00Z" })).toBeNull();
    expect(lockAfterCi(l, CI_EXIT.red, { at: "2026-11-07T10:00:00Z" })?.state).toBe(LOCK_STATES.ciRed);
  });

  it("looks at ci-wait and ci-red locks (R-2612); green is freed, red → ci-red, pending / unknown stay", () => {
    const locks = [
      lk("R-1", LOCK_STATES.ciWait, "aaaaaaaaaaaa"),
      lk("R-2", LOCK_STATES.ciWait, "bbbbbbbbbbbb"),
      lk("R-3", LOCK_STATES.ciWait, "cccccccccccc"),
      lk("R-4", LOCK_STATES.ciWait, "dddddddddddd"),
      lk("R-5"), // building — not asked
      lk("R-6", LOCK_STATES.ciRed, "eeeeeeeeeeee"), // already red, still red — left as it is (R-2612: asked again)
    ];
    const verdicts: Record<string, string | null> = { "R-1": "green", "R-2": "red", "R-3": "pending", "R-4": null, "R-6": "red" };
    const asked: string[] = [], settled: [string, number][] = [];
    const r = ciAllReport(locks, {
      verdict: (l: Lock) => { asked.push(l.card); return verdicts[l.card]; },
      settle: (c: string, code: number) => settled.push([c, code]),
      at: "2026-11-07T10:00:00Z",
    });
    expect(asked).toEqual(["R-1", "R-2", "R-3", "R-4", "R-6"]);
    // green → lock removed (exit 0), red → ci-red (exit 7) — exactly what `ci <CARD>` does.
    expect(settled).toEqual([["R-1", CI_EXIT.green], ["R-2", CI_EXIT.red]]);
    expect(r.results).toEqual([
      { card: "R-1", sha: "aaaaaaaaaaaa", ci: "green", at: "2026-11-07T10:00:00Z" },
      { card: "R-2", sha: "bbbbbbbbbbbb", ci: "red", at: "2026-11-07T10:00:00Z" },
      { card: "R-3", sha: "cccccccccccc", ci: "pending", at: "2026-11-07T10:00:00Z" },
      { card: "R-4", sha: "dddddddddddd", ci: "unknown", at: "2026-11-07T10:00:00Z" },
      { card: "R-6", sha: "eeeeeeeeeeee", ci: "red", at: "2026-11-07T10:00:00Z" },
    ]);
    expect(r.lines.join("\n")).toContain("R-2  bbbbbbbbb  CI LAAL");
  });

  it("no ci-wait lock → one plain line, nothing asked", () => {
    const r = ciAllReport([lk("R-5")], { verdict: () => { throw new Error("not asked"); }, settle: () => {} });
    expect(r.results).toEqual([]);
    expect(r.lines).toEqual(["Koi card CI ke intezaar (ci-wait) mein nahi."]);
  });

  /* Review finding: with the worker cleaning up right after its push, readLocks() used to delete a
     ci-wait lock because its worktree folder was gone — files free before CI said anything. */
  it("a pushed card's lock survives its worktree cleanup; a building lock without a folder does not", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-ci-all-"));
    const now = new Date().toISOString();
    const gone = path.join(dir, "no-such-worktree");
    const write = (card: string, extra: object) => fs.writeFileSync(path.join(dir, card + ".json"), JSON.stringify({ card, worktree: gone, areas: ["src/lib/x"], files: [], claimedAt: now, heartbeatAt: now, ...extra }));
    write("R-901", { state: LOCK_STATES.ciWait, pushedSha: "a".repeat(40), pushedAt: now });
    write("R-902", { state: "working" });
    const script = path.resolve(__dirname, "../../scripts/ops/worker-lock.mjs");
    const r = spawnSync(process.execPath, [script, "list"], { encoding: "utf8", env: { ...process.env, WORKER_LOCK_DIR: dir } });
    expect(r.stdout).toContain("stale lock R-902 removed");
    expect(r.stdout).toMatch(/R-901\s+ci-wait/);
    expect(fs.existsSync(path.join(dir, "R-901.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "R-902.json"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
