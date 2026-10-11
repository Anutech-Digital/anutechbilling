import { describe, it, expect } from "vitest";
import { suiteHealthVerdict, authSignalVars } from "../e2e/fixtures/suite-health-verdict.mjs";

// R-855: e2e-smoke (ci.yml) went red on every push because suite-health demanded auth
// secrets the repo has never had. Zero secrets in CI = labelled SKIP; partial secrets in
// CI or an incomplete dev machine must stay RED.
const FULL = {
  NEXT_PUBLIC_SUPABASE_URL: "https://staging-data.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "x",
  SUPABASE_SERVICE_ROLE_KEY: "x",
  E2E_OWNER_PASSWORD: "x",
  E2E_MANAGER_PASSWORD: "x",
  E2E_SALES_PASSWORD: "x",
  E2E_ACCOUNTANT_PASSWORD: "x",
};

describe("suiteHealthVerdict()", () => {
  it("CI with zero auth secrets → skip, reason says SKIPPED and names the variables", () => {
    const v = suiteHealthVerdict({ env: {}, hasEnvFile: false, isCI: true });
    expect(v.status).toBe("skip");
    expect(v.reason).toMatch(/^SKIPPED/);
    for (const n of authSignalVars()) expect(v.reason).toContain(n);
    expect(v.missing.length).toBeGreaterThan(0);
  });

  it("CI with ONE secret present but the rest missing → fail (silent-skip trap)", () => {
    for (const name of authSignalVars()) {
      const v = suiteHealthVerdict({ env: { [name]: "x" }, hasEnvFile: false, isCI: true });
      expect(v.status, name).toBe("fail");
    }
  });

  it("CI with everything but one role password → fail and names it", () => {
    const { E2E_SALES_PASSWORD: _drop, ...env } = FULL;
    const v = suiteHealthVerdict({ env, hasEnvFile: false, isCI: true });
    expect(v.status).toBe("fail");
    expect(v.missing.join(" ")).toContain("E2E_SALES_PASSWORD");
  });

  it("CI with every secret (no .env.test file — secrets come as env) → pass", () => {
    const v = suiteHealthVerdict({ env: FULL, hasEnvFile: false, isCI: true });
    expect(v.status).toBe("pass");
    expect(v.missing).toEqual([]);
  });

  it("dev machine without .env.test → fail, never skip", () => {
    const v = suiteHealthVerdict({ env: {}, hasEnvFile: false, isCI: false });
    expect(v.status).toBe("fail");
    expect(v.missing[0]).toContain(".env.test");
  });

  it("dev machine with .env.test loaded and complete → pass", () => {
    expect(suiteHealthVerdict({ env: FULL, hasEnvFile: true, isCI: false }).status).toBe("pass");
  });

  it("CI where a .env.test file exists but is empty → fail, not skip", () => {
    expect(suiteHealthVerdict({ env: {}, hasEnvFile: true, isCI: true }).status).toBe("fail");
  });
});
