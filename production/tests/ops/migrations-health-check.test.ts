import { describe, it, expect, vi } from "vitest";
import {
  sameBuild, verdict, readToken, waitForBuild, checkMigrations, TOKEN_ENV,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../../scripts/ops/migrations-health-check.mjs";

/* R-1721 (21 Oct 2026): after the staging push the train waits for the new build, then asks the
   app whether every migration it was built with is on its DB. 21 Oct it compared 8 characters
   of the pushed sha with the 7 the app returns (Cloud Build $SHORT_SHA) → TIMEOUT. */

const PUSHED = "ab12cd34ef567890ab12cd34ef567890ab12cd34";

describe("sameBuild — 7 characters, whatever the caller has", () => {
  it("app's 7-char sha matches the full pushed sha, and an 8-char prefix", () => {
    expect(sameBuild("ab12cd3", PUSHED)).toBe(true);
    expect(sameBuild("ab12cd3", PUSHED.slice(0, 8))).toBe(true);
    expect(sameBuild("AB12CD3", PUSHED)).toBe(true);
  });
  it("an older build, 'dev', or a too-short sha never matches", () => {
    expect(sameBuild("ab12cd9", PUSHED)).toBe(false);
    expect(sameBuild("dev", PUSHED)).toBe(false);
    expect(sameBuild("ab12", PUSHED)).toBe(false);
    expect(sameBuild(undefined, PUSHED)).toBe(false);
  });
});

describe("verdict", () => {
  it("ok → green, exit 0", () => {
    const v = verdict({ kind: "result", status: 200, body: { sha: "ab12cd3", ok: true, missing: [] } });
    expect(v).toMatchObject({ level: "ok", exitCode: 0 });
    expect(v.message).toContain("Sab migrations DB par");
  });
  it("missing keys → red 'DB step chhoot gaya: <keys>', non-zero exit", () => {
    const v = verdict({ kind: "result", status: 200, body: { sha: "ab12cd3", ok: false, missing: ["r1707quoteopenbalances", "undep"] } });
    expect(v.level).toBe("missing");
    expect(v.exitCode).not.toBe(0);
    expect(v.message).toContain("DB step chhoot gaya: r1707quoteopenbalances, undep");
  });
  it("no token here → yellow 'migration jaanch nahi ho saki — <why>', not silent", () => {
    const v = verdict({ kind: "no-token" });
    expect(v.level).toBe("unchecked");
    expect(v.message).toMatch(/migration jaanch nahi ho saki — .*MIGRATIONS_HEALTH_TOKEN/);
  });
  it("401 / 503 / build never came → yellow with the reason, non-zero", () => {
    for (const r of [{ kind: "result", status: 401, body: {} }, { kind: "result", status: 503, body: {} }, { kind: "timeout", lastSha: "0000000" }, { kind: "network", error: "ECONNRESET" }]) {
      const v = verdict(r);
      expect(v.level).toBe("unchecked");
      expect(v.message).toMatch(/^migration jaanch nahi ho saki — /);
      expect(v.exitCode).not.toBe(0);
    }
  });
});

describe("readToken", () => {
  it("env first, then the file; never anything else", () => {
    expect(TOKEN_ENV).toBe("MIGRATIONS_HEALTH_TOKEN");
    expect(readToken({ MIGRATIONS_HEALTH_TOKEN: " abc " }, () => "file")).toBe("abc");
    expect(readToken({}, () => "fromfile\n")).toBe("fromfile");
    expect(readToken({}, () => null)).toBeNull();
  });
});

describe("waitForBuild + checkMigrations (fetch mocked — no network)", () => {
  it("polls /api/version until the 7-char sha matches", async () => {
    const shas = ["old1234", "old1234", "ab12cd3"];
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sha: shas.shift() }) }));
    const r = await waitForBuild({ base: "https://s", sha: PUSHED.slice(0, 8), fetchFn, sleep: async () => {}, timeoutMs: 1e9, intervalMs: 1 });
    expect(r).toEqual({ arrived: true, lastSha: "ab12cd3" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(String((fetchFn.mock.calls as unknown as [string][])[0][0])).toBe("https://s/api/version");
  });
  it("gives up after the timeout and says which sha was still there", async () => {
    let t = 0;
    const r = await waitForBuild({ base: "https://s", sha: PUSHED, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ sha: "old1234" }) }), sleep: async () => { t += 10; }, now: () => t, timeoutMs: 25, intervalMs: 10 });
    expect(r).toEqual({ arrived: false, lastSha: "old1234" });
  });
  it("sends the token as a Bearer header and returns status + body", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sha: "x", ok: true, missing: [] }) }));
    const r = await checkMigrations({ base: "https://s/", token: "tok", fetchFn });
    expect(r).toEqual({ kind: "result", status: 200, body: { sha: "x", ok: true, missing: [] } });
    const calls = fetchFn.mock.calls as unknown as [string, { headers: Record<string, string> }][];
    expect(calls[0][0]).toBe("https://s/api/health/migrations");
    expect(calls[0][1].headers.authorization).toBe("Bearer tok");
  });
});

describe("staging-train --push runs the check after its push", () => {
  it("captures the merge commit before the push and checks it after", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../scripts/ops/staging-train.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ runCheck, colour, STAGING_URL \} from "\.\/migrations-health-check\.mjs"/);
    expect(src.indexOf('pushedSha = git(["rev-parse", "HEAD"]')).toBeLessThan(src.indexOf('execFileSync("git", PUSH_ARGS'));
    expect(src).toMatch(/runCheck\(\{ base: [^}]*sha: pushedSha \}\)/);
  });
});
