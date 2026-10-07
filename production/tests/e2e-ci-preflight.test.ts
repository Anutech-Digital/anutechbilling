import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error — plain .mjs CI script, no types
import { decide, REQUIRED_SECRETS, STAGING_BASE_URL } from "../e2e/fixtures/ci-preflight.mjs";
import { productionHostReason } from "../e2e/fixtures/e2e-roles.mjs";

// R-058 (7 Oct 2026): the "E2E (logged-in)" workflow went red on EVERY push because no secret
// was set (and staging was refused as production). Unconfigured must be a labelled skip,
// half-configured and production must stay red.
type Decision = { outcome: string; baseUrl: string; missing: string[]; message: string };
const run = (env: Record<string, string | undefined>): Decision => decide(env);

const FULL = {
  NEXT_PUBLIC_SUPABASE_URL: "https://staging-data.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "x",
  SUPABASE_SERVICE_ROLE_KEY: "x",
  E2E_OWNER_PASSWORD: "x",
  E2E_MANAGER_PASSWORD: "x",
  E2E_SALES_PASSWORD: "x",
  E2E_ACCOUNTANT_PASSWORD: "x",
};

describe("ci-preflight decide()", () => {
  it("nothing configured → skip, names every secret, defaults to staging", () => {
    const d = run({});
    expect(d.outcome).toBe("skip");
    expect(d.baseUrl).toBe(STAGING_BASE_URL);
    expect(d.missing).toEqual(REQUIRED_SECRETS);
    for (const s of REQUIRED_SECRETS) expect(d.message).toContain(s);
  });

  it("all configured → ok against staging", () => {
    const d = run(FULL);
    expect(d.outcome).toBe("ok");
    expect(d.baseUrl).toBe(STAGING_BASE_URL);
  });

  it("half configured → fail (red), lists only what is missing", () => {
    const d = run({ ...FULL, E2E_SALES_PASSWORD: "" });
    expect(d.outcome).toBe("fail");
    expect(d.missing).toEqual(["secrets.E2E_SALES_PASSWORD"]);
  });

  it("production base URL → refuse, even when nothing else is configured", () => {
    expect(run({ E2E_BASE_URL: "https://reselleros.anutech.in" }).outcome).toBe("refuse");
    expect(run({ ...FULL, E2E_BASE_URL: "https://resellersos-njvk4nxhdq-el.a.run.app" }).outcome).toBe("refuse");
    expect(run({ ...FULL, NEXT_PUBLIC_SUPABASE_URL: "https://ontpnqjoysjgrlsukecm.supabase.co" }).outcome).toBe("refuse");
  });

  it("never prints a secret value", () => {
    const d = run({ ...FULL, E2E_OWNER_PASSWORD: "", SUPABASE_SERVICE_ROLE_KEY: "s3cr3t-value" });
    expect(d.message).not.toContain("s3cr3t-value");
  });
});

describe("productionHostReason — staging vs production", () => {
  it("allows the staging service", () => {
    expect(productionHostReason(STAGING_BASE_URL)).toBeNull();
  });
  it("still refuses every production host", () => {
    for (const h of [
      "https://reselleros.anutech.in",
      "https://resellersos-njvk4nxhdq-el.a.run.app",
      "https://resellersos-njvk4nxhdq-as.a.run.app",
      "https://resellersos-490252291080.asia-south1.run.app",
      "https://ontpnqjoysjgrlsukecm.supabase.co",
    ]) expect(productionHostReason(h), h).not.toBeNull();
  });
});

describe("ci-preflight CLI (what the workflow step sees)", () => {
  const script = path.resolve(__dirname, "..", "e2e", "fixtures", "ci-preflight.mjs");
  function cli(env: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-preflight-"));
    const out = path.join(dir, "out"), sum = path.join(dir, "sum");
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !/^(E2E_|NEXT_PUBLIC_SUPABASE_|SUPABASE_)/.test(k)));
    const r = spawnSync(process.execPath, [script], {
      env: { ...clean, ...env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum } as unknown as NodeJS.ProcessEnv, encoding: "utf8",
    });
    return { code: r.status, stdout: r.stdout, output: fs.readFileSync(out, "utf8"), summary: fs.readFileSync(sum, "utf8") };
  }

  it("unconfigured: exit 0, configured=false, notice + summary", () => {
    const r = cli({});
    expect(r.code).toBe(0);
    expect(r.output).toContain("configured=false");
    expect(r.output).toContain(`base_url=${STAGING_BASE_URL}`);
    expect(r.stdout).toContain("::notice title=E2E (logged-in) skipped::");
    expect(r.summary).toContain("SKIP");
  });

  it("production: exit 1 with ::error::", () => {
    const r = cli({ E2E_BASE_URL: "https://reselleros.anutech.in" });
    expect(r.code).toBe(1);
    expect(r.output).toContain("configured=false");
    expect(r.stdout).toContain("::error title=E2E (logged-in) refuse::");
  });

  it("configured: exit 0, configured=true", () => {
    const r = cli(FULL);
    expect(r.code).toBe(0);
    expect(r.output).toContain("configured=true");
  });
});

describe("workflow wiring", () => {
  const yml = fs.readFileSync(path.resolve(__dirname, "..", "..", ".github", "workflows", "e2e-logged-in.yml"), "utf8");
  it("runs the preflight script and gates every later step on it", () => {
    expect(yml).toContain("run: node e2e/fixtures/ci-preflight.mjs");
    const steps = yml.split(/\r?\n      - /).slice(1);
    const pre = steps.findIndex((s) => s.includes("id: preflight"));
    expect(pre).toBeGreaterThan(-1);
    for (const s of steps.slice(pre + 1)) expect(s, s.split("\n")[0]).toMatch(/if: .*steps\.preflight\.outputs\.configured == 'true'/);
  });
  it("targets the preflight base_url and runs on push + nightly", () => {
    expect(yml).toContain("PLAYWRIGHT_BASE_URL: ${{ steps.preflight.outputs.base_url }}");
    expect(yml).toMatch(/schedule:\s*\r?\n(\s*#.*\r?\n)*\s*- cron:/);
    expect(yml).toMatch(/push:\s*\r?\n\s*branches: \[[^\]]*manager-pardeep/);
  });
});
