/**
 * A guard against the E2E suite passing while testing almost nothing.
 *
 * ─── THE TRAP THIS CLOSES ───────────────────────────────────────────────────
 * 70 of the 78 auth-gated tests in this suite call `test.skip(!hasEnv, …)`. Without
 * `.env.test` they skip, and Playwright reports the run as green — "8 passed, 70
 * skipped" reads as a pass in a terminal and looks like a tick in CI.
 *
 * That is the same failure the rest of this codebase keeps finding: an absence
 * rendered as a success. A suite that silently tests nothing is worse than no suite,
 * because it is trusted.
 *
 * This test FAILS when the environment needed to exercise the real spine is missing,
 * so the run cannot be mistaken for coverage. It is the only test here that is
 * supposed to go red on a fresh machine — and the message says exactly what to do.
 *
 *
 * R-855: the ONE exception is a CI with no auth secret at all — there it SKIPS with
 * the reason printed in the log, because a permanently red non-blocking job taught
 * everyone to ignore it (and got mistaken for the real CI blocker). Partial secrets in
 * CI still FAIL, and so does a dev machine without a complete .env.test.
 * ─── IT DOES NOT ASK ANYONE TO PASTE A SERVICE-ROLE KEY ANYWHERE PUBLIC ─────
 * Lighting up the suite needs SUPABASE_SERVICE_ROLE_KEY in `.env.test`, which is
 * gitignored. That key must never reach a commit, a screenshot, or a chat message —
 * the message below points at the file and at e2e/README.md rather than reproducing
 * any instruction that would encourage pasting it somewhere it can be read.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { suiteHealthVerdict } from "./fixtures/suite-health-verdict.mjs";

const ENV_FILE = path.join(process.cwd(), ".env.test");

test.describe("suite health", () => {
  test("the auth-gated specs are actually able to run", () => {
    // R-855: the decision lives in fixtures/suite-health-verdict.mjs (unit-tested in
    // src/test/suite-health-verdict.test.ts).
    const verdict = suiteHealthVerdict({
      env: process.env,
      hasEnvFile: fs.existsSync(ENV_FILE),
      isCI: Boolean(process.env.CI),
    });

    console.log(`[suite-health] ${verdict.status.toUpperCase()}: ${verdict.reason}`);
    if (verdict.status === "skip") {
      test.info().annotations.push({ type: "suite-health", description: verdict.reason });
      test.skip(true, verdict.reason);
      return;
    }

    expect(
      verdict.missing,
      [
        "",
        "The E2E suite is running with its auth-gated specs disabled, so a green run",
        `here proves almost nothing. ${verdict.reason} Missing:`,
        ...verdict.missing.map((m) => `  · ${m}`),
        "",
        "Fix: create production/.env.test (gitignored) with the keys and the E2E_*_PASSWORD",
        "vars (in CI: the same names as repo secrets), then seed (e2e/README.md,",
        '"Logged-in E2E"). Until then the only specs that really execute are the no-auth',
        "ones: smoke, and the public buy page.",
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});
