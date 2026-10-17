import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs ops script, no types
import { loadMap, parseArgs, resolveEnv, planLines, parseDescribeYaml, diffEnv, diffLines, diffIsClean } from "../../scripts/ops/live-env-commands.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { scanText } from "../../scripts/ops/secret-scan.mjs";

/* R-1462 (17 Oct 2026): the cutover's Cloud Run env/secret wiring is printed from a checked-in
   map of NAMES. These tests pin: the map matches the runbook tables, the output holds no
   secret-looking value, the diff reads a describe-yaml correctly, and there is no apply path. */

const map = loadMap();
const live = resolveEnv(map, "live");
const root = fileURLToPath(new URL("../../", import.meta.url));
const runbook = readFileSync(`${root}docs/R-909-LIVE-CUTOVER.md`, "utf8");

/** Env names in the first column of a runbook table between two headings. */
function tableNames(from: string, to: string): string[] {
  const body = runbook.split(from)[1].split(to)[0];
  return [...body.matchAll(/^\| `([A-Z][A-Z0-9_]*)(?:=[^`]*)?` \|/gm)].map((m) => m[1]);
}

describe("live-env map vs runbook", () => {
  it("section 2.1 table = map entries with section 2.1 (memory row is a flag, not an env)", () => {
    const want = tableNames("### 2.1", "### 2.2").sort();
    const have = map.vars.filter((v: { section: string }) => v.section === "2.1").map((v: { name: string }) => v.name).sort();
    expect(have).toEqual(want);
    expect(want.length).toBe(14);
  });

  it("section 2.3 fixes are in the map", () => {
    const body = runbook.split("### 2.3")[1].split("### 2.4")[0];
    const fixes = [...body.matchAll(/^\| `([A-Z][A-Z0-9_]*)/gm)].map((m) => m[1]);
    expect(fixes).toContain("NEXT_PUBLIC_APP_URL");
    expect(map.vars.find((v: { name: string }) => v.name === "NEXT_PUBLIC_APP_URL").section).toBe("2.3");
    expect(map.vars.find((v: { name: string }) => v.name === "SUPABASE_SERVICE_ROLE_KEY").removePlainFirst).toBe(true);
  });

  it("section 2.2 keep list: every name in the map's keep list is named in the runbook text", () => {
    const sec22 = runbook.split("### 2.2")[1].split("### 2.3")[0];
    const tokens = new Set(sec22.split(/[`,\s/()]+/));
    for (const n of map.keep.names) {
      // the runbook writes families as DIRECTADMIN_URL/ADMIN_USER/API_KEY/IP or GOOGLE_OAUTH_CLIENT_ID/SECRET
      const parts = n.split("_");
      let ok = tokens.has(n);
      for (let k = 1; k < parts.length && !ok; k++) {
        const prefix = parts.slice(0, k).join("_") + "_", suffix = parts.slice(k).join("_");
        ok = tokens.has(suffix) && [...tokens].some((t) => t.startsWith(prefix) && t !== n);
      }
      expect(ok, n).toBe(true);
    }
    expect(map.keep.names.length).toBe(21);
  });

  it("Google redirect URI matches section 3", () => {
    expect(runbook).toContain(`${live.cfg.appUrl}${map.googleOAuth.redirectPath}`);
  });

  it("service/region/project come from the repo config, both envs", () => {
    expect(live.cfg).toMatchObject({ service: "resellersos", region: "asia-southeast1", project: "resellsubsos-prod" });
    expect(resolveEnv(map, "staging").cfg.service).toBe("resellersos-staging");
    for (const v of live.vars) if (v.kind === "secret") expect(v.secret).toMatch(/^live-[a-z0-9-]+$/);
    for (const v of resolveEnv(map, "staging").vars) if (v.kind === "secret") expect(v.secret).toMatch(/^staging-[a-z0-9-]+$/);
  });
});

describe("plan output", () => {
  const lines: string[] = planLines(live);
  const text = lines.join("\n");

  it("prints --update-secrets with NAME=secret-name:latest only", () => {
    const sec = lines.filter((l) => l.includes("--update-secrets=") && !l.startsWith("#"));
    expect(sec.length).toBe(2); // bulk line + SUPABASE_SERVICE_ROLE_KEY re-add
    for (const l of sec) {
      const arg = l.split("--update-secrets=")[1];
      for (const pair of arg.split(",")) expect(pair).toMatch(/^[A-Z][A-Z0-9_]*=live-[a-z0-9-]+:latest$/);
    }
    expect(text).toContain("--update-env-vars=DATA_GATEWAY=1,");
    expect(text).toContain("--remove-env-vars=SUPABASE_SERVICE_ROLE_KEY");
    expect(text).toContain("redirect URI : https://reselleros.anutech.in/api/auth/callback/google");
  });

  it("never uses --set-env-vars / --set-secrets, and every command names service, region, project", () => {
    expect(text).not.toMatch(/--set-(env-vars|secrets)=/);
    for (const l of lines.filter((l) => l.startsWith("gcloud"))) {
      expect(l).toMatch(/^gcloud run services update resellersos --region=asia-southeast1 --project=resellsubsos-prod /);
    }
  });

  it("holds no secret value pattern (secret-scan rules)", () => {
    expect(scanText("plan.txt", text)).toEqual([]);
    expect(scanText("plan-staging.txt", planLines(resolveEnv(map, "staging")).join("\n"))).toEqual([]);
    expect(scanText("live-env-map.json", readFileSync(`${root}scripts/ops/live-env-map.json`, "utf8"))).toEqual([]);
  });

  it("the optional DMS_SSO_SECRET line is commented, not a command", () => {
    const dms = lines.filter((l) => l.includes("DMS_SSO_SECRET"));
    expect(dms.length).toBeGreaterThan(0);
    for (const l of dms) expect(l.startsWith("#")).toBe(true);
  });
});

describe("no apply mode", () => {
  it("refuses --run / --apply / --execute", () => {
    for (const f of ["--run", "--apply", "--execute"]) expect(() => parseArgs([f])).toThrow(/only prints/);
    expect(() => parseArgs(["--env", "prod"])).toThrow(/live or staging/);
    expect(parseArgs(["--env", "staging", "--diff", "x.yaml"])).toEqual({ env: "staging", diff: "x.yaml", help: false });
  });

  it("the script never imports child_process (cannot run gcloud)", () => {
    const src = readFileSync(`${root}scripts/ops/live-env-commands.mjs`, "utf8");
    expect(src).not.toMatch(/child_process|spawn|execSync|execFile/);
  });
});

/* Fake describe output: names only, invented values. Shape = `gcloud run services describe --format=yaml`. */
const FIXTURE = `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: resellersos
spec:
  template:
    spec:
      containers:
      - image: example/image:fake
        env:
        - name: DATA_GATEWAY
          value: '1'
        - name: AUTH_PROVIDER
          value: authjs
        - name: AUTH_URL
          value: https://reselleros.anutech.in
        - name: STORAGE_BACKEND
          value: gcs
        - name: GCS_BUCKET
          value: resellsubsos-live-files
        - name: DB_POOL_MAX
          value: '3'
        - name: NEXT_PUBLIC_APP_URL
          value: https://reselleros.anutech.in
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              key: latest
              name: live-database-url
        - name: ANON_DATABASE_URL
          valueFrom:
            secretKeyRef:
              key: latest
              name: live-anon-database-url
        - name: SERVICE_DATABASE_URL
          valueFrom:
            secretKeyRef:
              key: '3'
              name: live-service-database-url
        - name: AUTH_DATABASE_URL
          valueFrom:
            secretKeyRef:
              key: latest
              name: old-auth-url-secret
        - name: SUPABASE_JWT_SECRET
          valueFrom:
            secretKeyRef:
              key: latest
              name: live-supabase-jwt-secret
        - name: AUTH_SECRET
          valueFrom:
            secretKeyRef:
              key: latest
              name: live-auth-secret
        - name: SUPABASE_SERVICE_ROLE_KEY
          value: fake-plain-placeholder
        - name: CRON_SECRET
          value: fake-placeholder
        - name: SECRETS_MASTER_KEY
          value: fake-placeholder
        - name: SOME_OLD_FLAG
          value: '1'
        ports:
        - name: http1
          containerPort: 8080
        resources:
          limits:
            memory: 1Gi
      volumes:
      - name: cloudsql
        csi:
          driver: gcp.csi.run
status:
  traffic:
  - percent: 100
    revisionName: resellersos-00001-abc
`;

describe("--diff against a describe yaml", () => {
  const described = parseDescribeYaml(FIXTURE);

  it("reads plain and secret env entries, ignores ports/volumes, keeps no plain values", () => {
    expect(described.get("DATA_GATEWAY")).toEqual({ kind: "plain" });
    expect(described.get("DATABASE_URL")).toEqual({ kind: "secret", secret: "live-database-url", version: "latest" });
    expect(described.has("http1")).toBe(false);
    expect(described.has("cloudsql")).toBe(false);
    expect(JSON.stringify([...described.values()])).not.toContain("placeholder");
  });

  it("reports missing / wrong secret / plain-should-be-secret / extra / keep-missing by NAME", () => {
    const d = diffEnv(live, described);
    expect(d.missing).toEqual(["JOBS_DATABASE_URL"]);
    expect(d.wrongSecret).toEqual(["AUTH_DATABASE_URL: has old-auth-url-secret, map says live-auth-database-url"]);
    expect(d.plainShouldBeSecret).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
    expect(d.notLatest).toEqual(["SERVICE_DATABASE_URL (version 3)"]);
    expect(d.extra).toEqual(["SOME_OLD_FLAG"]);
    expect(d.keepMissing).toContain("AGENT_QUEUE_TOKEN");
    expect(d.keepMissing).not.toContain("CRON_SECRET");
    expect(diffIsClean(d)).toBe(false);
    const out = diffLines(live, d).join("\n");
    expect(out).toContain("MISSING on the service (1)");
    expect(out).toContain("RESULT: not yet");
    expect(out).not.toContain("placeholder");
    expect(scanText("diff.txt", out)).toEqual([]);
  });

  it("is clean once every mapped name matches", () => {
    const fixed = FIXTURE
      .replace("old-auth-url-secret", "live-auth-database-url")
      .replace("- name: SUPABASE_SERVICE_ROLE_KEY\n          value: fake-plain-placeholder",
        "- name: SUPABASE_SERVICE_ROLE_KEY\n          valueFrom:\n            secretKeyRef:\n              key: latest\n              name: live-service-role-key\n        - name: JOBS_DATABASE_URL\n          valueFrom:\n            secretKeyRef:\n              key: latest\n              name: live-jobs-database-url");
    const d = diffEnv(live, parseDescribeYaml(fixed));
    expect(diffIsClean(d)).toBe(true);
    expect(d.ok.length).toBe(live.vars.filter((v: { optional?: boolean }) => !v.optional).length);
    expect(diffLines(live, d).join("\n")).toContain("RESULT: service matches the map.");
  });

  it("a non-describe file yields no env (main exits 2 instead of a bogus diff)", () => {
    expect(parseDescribeYaml("hello: world\n").size).toBe(0);
  });
});
