import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* R-2616 (8 Nov 2026): setup-cloud-scheduler.sh had fixed job names (resellersos-*), so a
   staging run would have created a LIVE-named job pointed at staging. --env staging must name
   only resellersos-staging-* jobs aimed at the staging URL; --env live (the default) must be
   exactly the old plan. Only --dry-run is exercised here: a fake `gcloud` first on PATH records
   any call, and the test fails if the dry run made one. */

const SCRIPT = join(process.cwd(), "scripts", "setup-cloud-scheduler.sh");
const STAGING_URL = "https://resellersos-staging-njvk4nxhdq-as.a.run.app";

const BASH =
  process.platform === "win32"
    ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find((p) => existsSync(p)) ?? null
    : spawnSync("bash", ["--version"]).status === 0
      ? "bash"
      : null;

/** C:\a\b -> /c/a/b for Git bash; unchanged elsewhere. */
const bashPath = (p: string) =>
  process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, "/") : p;

let fakeBin: string;
let marker: string;

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), "r2616-gcloud-"));
  marker = join(fakeBin, "called");
  const fake = join(fakeBin, "gcloud");
  writeFileSync(fake, `#!/usr/bin/env bash\necho "$@" >> "${bashPath(marker)}"\nexit 99\n`);
  chmodSync(fake, 0o755);
});
afterAll(() => rmSync(fakeBin, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  const quoted = args.map((a) => `'${a}'`).join(" ");
  const r = spawnSync(BASH!, ["-c", `PATH="${bashPath(fakeBin)}:$PATH" bash "${bashPath(SCRIPT)}" ${quoted}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      CRON_SECRET: "",
      ONLY: "",
      SERVICE_NAME: "",
      SERVICE_URL: "",
      STAGING_CRON_SECRET: "",
      SCHEDULER_ENV: "",
      DRY_RUN: "",
      UPDATE_EXISTING: "",
      ...env,
    },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const plans = (out: string) =>
  [...out.matchAll(/^==> plan:\s+(\S+)\s+\((.+?)\)\s+(\S+)$/gm)].map((m) => ({ name: m[1], uri: m[3] }));

const jobRows = () =>
  [...readFileSync(SCRIPT, "utf8").matchAll(/^\s+"(resellersos-[a-z0-9-]+)\|([^|]+)\|(\/api\/cron\/[a-z0-9-]+)\|/gm)].map(
    (m) => ({ name: m[1], path: m[3] }),
  );

describe.skipIf(!BASH)("setup-cloud-scheduler.sh --env (R-2616)", () => {
  it("staging dry run plans only resellersos-staging-zoho-fy-read on the staging URL, no gcloud call", () => {
    const r = run(["--env", "staging", "--dry-run"]);
    expect(r.code, r.err).toBe(0);
    expect(plans(r.out)).toEqual([
      { name: "resellersos-staging-zoho-fy-read", uri: `${STAGING_URL}/api/cron/zoho-fy-read` },
    ]);
    expect(r.out).toContain("Authorization=Bearer <redacted>");
    expect(existsSync(marker)).toBe(false);
  });

  it("staging ONLY=all: every job, every name resellersos-staging-*, every URI on staging", () => {
    const r = run(["--env=staging", "--dry-run"], { ONLY: "all" });
    expect(r.code, r.err).toBe(0);
    const p = plans(r.out);
    expect(p.length).toBe(jobRows().length);
    for (const j of p) {
      expect(j.name.startsWith("resellersos-staging-")).toBe(true);
      expect(j.uri.startsWith(`${STAGING_URL}/api/cron/`)).toBe(true);
    }
    // No plan line names a live job.
    expect(r.out).not.toMatch(/jobs create http resellersos-(?!staging-)/);
    expect(existsSync(marker)).toBe(false);
  });

  it("staging ONLY accepts short, live and staging spellings", () => {
    const r = run(["--env", "staging", "--dry-run"], {
      ONLY: "renewals,resellersos-backup,resellersos-staging-gmail-inbox",
    });
    expect(plans(r.out).map((p) => p.name).sort()).toEqual([
      "resellersos-staging-backup",
      "resellersos-staging-gmail-inbox",
      "resellersos-staging-renewals",
    ]);
  });

  it("staging refuses another service, a non-staging URL and a look-alike host", () => {
    expect(run(["--env", "staging", "--dry-run"], { SERVICE_NAME: "resellersos" }).code).toBe(65);
    expect(run(["--env", "staging", "--dry-run"], { SERVICE_URL: "https://reselleros.anutech.in" }).code).toBe(65);
    expect(
      run(["--env", "staging", "--dry-run"], { SERVICE_URL: "https://resellersos-staging-x.example.com" }).code,
    ).toBe(65);
  });

  it("staging dry run with UPDATE_EXISTING=1 says existing jobs are overwritten", () => {
    const r = run(["--env", "staging", "--dry-run"], { UPDATE_EXISTING: "1" });
    expect(r.out).toContain("OVERWRITTEN");
  });

  it("live (default) dry run is the old plan: every job under its live name", () => {
    const r = run(["--dry-run"], { SERVICE_URL: "https://live.example" });
    expect(r.code, r.err).toBe(0);
    expect(plans(r.out)).toEqual(jobRows().map((j) => ({ name: j.name, uri: `https://live.example${j.path}` })));
    expect(r.out).not.toContain("resellersos-staging");
    expect(existsSync(marker)).toBe(false);
  });

  it("live refuses a staging service, a staging URL and a staging job name in ONLY", () => {
    expect(run(["--dry-run"], { SERVICE_NAME: "resellersos-staging" }).code).toBe(65);
    expect(run(["--dry-run"], { SERVICE_URL: STAGING_URL }).code).toBe(65);
    expect(run(["--dry-run"], { SERVICE_URL: "https://x", ONLY: "resellersos-staging-zoho-fy-read" }).code).toBe(65);
  });

  it("DRY_RUN=true is a dry run too; an unknown DRY_RUN value or --env is refused", () => {
    expect(run(["--env", "staging"], { DRY_RUN: "true" }).code).toBe(0);
    expect(run(["--env", "staging"], { DRY_RUN: "maybe" }).code).toBe(64);
    expect(run(["--env", "prod", "--dry-run"]).code).toBe(64);
    expect(existsSync(marker)).toBe(false);
  });

  it("staging URL matches live-env-map.json envs.staging.appUrl", () => {
    const map = JSON.parse(readFileSync(join(process.cwd(), "scripts", "ops", "live-env-map.json"), "utf8"));
    expect(map.envs.staging.appUrl).toBe(STAGING_URL);
    expect(readFileSync(SCRIPT, "utf8")).toContain(`STAGING_URL_DEFAULT="${STAGING_URL}"`);
  });
});
