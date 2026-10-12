// R-1430: secret / client-data scan. Every fake value below is BUILT AT RUNTIME (prefix + random
// chars) so this file never matches the scanner's own rules — the repo is public.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs ops script, no types
import { scanText, fileNameRule, parseDiff, loadAllowlist, isAllowed, formatHits, fingerprint, loadDenyTerms, run } from "../scripts/ops/secret-scan.mjs";

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const rnd = (n: number, set = ALNUM) => Array.from(crypto.randomBytes(n), (b) => set[b % set.length]).join("");
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const rules = (text: string, p = "src/x.ts", opts = {}) => scanText(p, text, opts).map((h: { rule: string }) => h.rule);

// hit + near miss per rule
const CASES: Array<[string, () => string, () => string]> = [
  ["private-key", () => `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}`, () => `${"-".repeat(5)}BEGIN PUBLIC KEY${"-".repeat(5)}`],
  ["gcp-service-account", () => `  "private_key": "${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}\\n${rnd(40)}"`, () => `  "private_key_id": "${rnd(8)}"`],
  ["google-api-key", () => `key = "AI${"za"}${rnd(35)}"`, () => `key = "AI${"za"}${rnd(20)}"`],
  ["oauth-client-secret", () => `secret: "GOC${"SPX"}-${rnd(28)}"`, () => `secret: "GOC${"SPX"}-${"x".repeat(28)}"`],
  ["github-token", () => `t=gh${"p"}_${rnd(36)}`, () => `t=gh${"p"}_short${rnd(5)}`],
  ["aws-access-key", () => `id=AK${"IA"}${rnd(16, UP)}`, () => `id=AK${"IA"}IOSFODNN7EXAMPLE`],
  ["razorpay-live-key", () => `k=rzp${"_live_"}${rnd(14)}`, () => `k=rzp${"_test_"}${rnd(14)}`],
  ["resend-key", () => `RESEND=r${"e_"}${rnd(8)}_${rnd(24)}`, () => `const r${"e_"}render_component_name = 1`],
  ["sk-key", () => `OPENAI=s${"k-"}proj-${rnd(40)}`, () => `class="s${"k-"}skeleton-loader-placeholder-wide"`],
  ["jwt", () => `t="ey${"J"}${rnd(20)}.ey${"J"}${rnd(30)}.${rnd(43)}"`, () => `t="ey${"J"}hbGci"`],
  ["db-url-password", () => `DATABASE_URL=postgres${"ql"}://app:${rnd(20)}@10.0.0.5:5432/db`, () => `DATABASE_URL=postgres${"ql"}://app:\${DB_PASSWORD}@10.0.0.5:5432/db`],
  ["generic-secret", () => `const API_${"KEY"} = "${rnd(32)}9";`, () => `const AUTH_${"SECRET"}_NAME = "live-auth-secret-name";`],
  ["personal-email", () => `contact: "rk.${rnd(6).toLowerCase()}@gm${"ail"}.com"`, () => `contact: "someone@gm${"ail"}.com"`],
  ["phone", () => `call +91 9${"8"}${String(crypto.randomInt(13572468, 13579999))}`.replace(/(\d{5})(\d{5})$/, "$1 $2"), () => `call +91 98${"7"}6543210`],
];

describe("secret-scan rules (R-1430)", () => {
  for (const [rule, hit, miss] of CASES) {
    it(`${rule}: hit and near miss`, () => {
      expect(rules(hit())).toContain(rule);
      expect(rules(miss())).not.toContain(rule);
    });
  }

  it("env var NAMES and secret names never trigger", () => {
    const src = [
      `const s = process.env.NEXTAUTH_${"SECRET"};`,
      `GOOGLE_CLIENT_${"SECRET"}=`,
      `AUTH_${"SECRET"}="\${AUTH_${"SECRET"}}"`,
      `secretName: "live-auth-${"secret"}"`,
      `RAZORPAY_KEY_${"SECRET"}: "RAZORPAY_KEY_${"SECRET"}_LIVE"`,
      `PASSWORD = "<your-password-here>"`,
    ].join("\n");
    expect(scanText(".env.example", src)).toEqual([]);
  });

  it("PII rules are off in fixture/test paths, secret rules stay on", () => {
    const pii = `x: "rk.${rnd(6).toLowerCase()}@gm${"ail"}.com"`;
    expect(rules(pii, "production/e2e/fixtures/people.ts")).toEqual([]);
    const key = `k=rzp${"_live_"}${rnd(14)}`;
    expect(rules(key, "production/src/a.test.ts")).toContain("razorpay-live-key");
  });

  it("deny terms come from env, matched case-insensitively, reported without the term", () => {
    const term = `acme${rnd(6).toLowerCase()}`;
    const terms = loadDenyTerms({ SECRET_SCAN_DENY_TERMS: `${term}, other-term`, SECRET_SCAN_DENY_FILE: "/nonexistent" });
    const hits = scanText("docs/a.md", `Client: ${term.toUpperCase()} Pvt`, { denyTerms: terms });
    expect(hits.map((h: { rule: string }) => h.rule)).toEqual(["deny-term"]);
    expect(formatHits(hits).join("\n")).not.toContain(term);
  });

  it("committed secret files: .env*, keys — templates allowed", () => {
    expect(fileNameRule("production/.env")).toBe("env-file");
    expect(fileNameRule("production/.env.local")).toBe("env-file");
    expect(fileNameRule("production/.env.production")).toBe("env-file");
    expect(fileNameRule("production/.env.example")).toBeNull();
    expect(fileNameRule("production/.env.local.example")).toBeNull();
    expect(fileNameRule("certs/server.pem")).toBe("key-file");
    expect(fileNameRule("x/gcp-service-account.json")).toBe("credentials-file");
    expect(fileNameRule("src/lib/keys.ts")).toBeNull();
  });

  it("output is file:line + rule only — the value never appears", () => {
    const value = `GOC${"SPX"}-${rnd(28)}`;
    const hits = scanText("src/a.ts", `\nconst c = "${value}";`);
    const out = formatHits(hits, { fingerprints: true }).join("\n");
    expect(out).toMatch(/^src\/a\.ts:2 {2}oauth-client-secret {2}fp=[0-9a-f]{16}$/);
    expect(out).not.toContain(value);
    expect(out).not.toContain(value.slice(7, 15));
  });

  it("allowlist by fingerprint / path; entries need a reason", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
    const value = `rzp${"_live_"}${rnd(14)}`;
    const [hit] = scanText("src/a.ts", `k="${value}"`);
    const f = path.join(dir, "allow.json");
    fs.writeFileSync(f, JSON.stringify({ entries: [{ rule: "razorpay-live-key", fingerprint: fingerprint("razorpay-live-key", value), reason: "test fixture" }] }));
    expect(isAllowed(hit, loadAllowlist(f))).toBe(true);
    fs.writeFileSync(f, JSON.stringify({ entries: [{ path: "docs/**", reason: "docs only" }] }));
    expect(isAllowed(hit, loadAllowlist(f))).toBe(false);
    expect(isAllowed({ ...hit, path: "docs/x/y.md" }, loadAllowlist(f))).toBe(true);
    fs.writeFileSync(f, JSON.stringify({ entries: [{ path: "docs/**" }] }));
    expect(() => loadAllowlist(f)).toThrow(/reason/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parseDiff keeps only added lines with new-file line numbers", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
      "@@ -3,0 +4,2 @@", "+added one", "+added two", "@@ -10 +12 @@", "-old", "+new",
    ].join("\n");
    expect(parseDiff(diff)).toEqual({ "src/a.ts": [{ n: 4, text: "added one" }, { n: 5, text: "added two" }, { n: 12, text: "new" }] });
  });

  it("--diff mode in a real git repo: refuses an added secret, prints no value, exit 1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-git-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
    g("init", "-q"); g("config", "user.email", "t@example.test"); g("config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    g("add", "."); g("commit", "-qm", "base");
    const base = g("rev-parse", "HEAD");
    const value = `GOC${"SPX"}-${rnd(28)}`;
    fs.writeFileSync(path.join(dir, "a.ts"), `export const a = 1;\nexport const s = "${value}";\n`);
    g("commit", "-qam", "leak");
    const out: string[] = [];
    const env = { SECRET_SCAN_ALLOW: path.join(dir, "none.json"), SECRET_SCAN_DENY_FILE: "/nonexistent" };
    const code = run(["--diff", base], { cwd: dir, env, log: (s: string) => out.push(s), err: (s: string) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("a.ts:2  oauth-client-secret");
    expect(out.join("\n")).not.toContain(value);
    out.length = 0;
    expect(run(["--diff", g("rev-parse", "HEAD")], { cwd: dir, env, log: (s: string) => out.push(s), err: (s: string) => out.push(s) })).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
