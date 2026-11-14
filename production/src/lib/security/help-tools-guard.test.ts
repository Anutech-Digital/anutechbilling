/**
 * R-2774 / H-01 (14 Nov 2026) — Help AI tools can NEVER reach the service role.
 *
 * Help AI is getting full power for the owner (G-HELPAI). Its tools must run with the signed-in
 * person's own login (RLS) only. This guard fails the build when:
 *
 *   1. any file under src/lib/ai/help-tools (or the legacy help-data-tools.ts), or ANY file they
 *      import (followed transitively through src/), names createAdminClient /
 *      createAdminClientFor / SUPABASE_SERVICE_ROLE_KEY, or imports a module that builds a client
 *      from a key (@/lib/supabase/bare, @supabase/supabase-js or @supabase/ssr as values,
 *      @/server/postgrest/*);
 *   2. @/lib/supabase/server is imported anywhere in that graph except help-tools/session.ts —
 *      and there only `createClient` (the cookie client);
 *   3. a help-tools file other than reader.ts touches tables (`.from("…")`), or any of them calls
 *      `.rpc(`, `.storage` or `.auth.`, or reads process.env (registry.ts may read HELP_AI_V2 only);
 *   4. scopedReader / sessionClient are called from anywhere but runner.ts and the legacy
 *      help-data-tools.ts (so no one wraps another client into a tool's reader);
 *   5. the readable-table allowlist names a credential table or a table holding a SECRET_COLUMNS
 *      entry (the list is shared with secret-columns.test.ts).
 *
 * Runtime locks are tested in src/lib/ai/help-tools/runner.test.ts (forged session refused,
 * service-role key refused, reader refuses secret columns, query has no write methods).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readSource } from "@/lib/testing/source-cache";
import { SECRET_COLUMNS } from "./secret-columns";
import { HELP_READ_TABLES, HELP_NEVER_TABLES } from "@/lib/ai/help-tools/reader";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const HELP_DIR = "src/lib/ai/help-tools";
const LEGACY = "src/lib/ai/help-data-tools.ts";
const SESSION = `${HELP_DIR}/session.ts`;
const SERVER = "src/lib/supabase/server.ts";

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");
const isTest = (f: string) => /\.(test|spec)\.tsx?$/.test(f);

/** Comments out, so a file that only TALKS about the admin client does not fail. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function helpFiles(): string[] {
  const dir = path.join(ROOT, HELP_DIR);
  return fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !isTest(f)).map((f) => `${HELP_DIR}/${f}`);
}

interface Imp { spec: string; clause: string; typeOnly: boolean }

/** Static, re-export and dynamic imports of a file (type-only ones marked). */
function importsOf(src: string): Imp[] {
  const out: Imp[] = [];
  for (const m of src.matchAll(/\b(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g)) {
    out.push({ spec: m[4], clause: m[3], typeOnly: !!m[2] });
  }
  for (const m of src.matchAll(/\bimport\s*["']([^"']+)["']/g)) out.push({ spec: m[1], clause: "", typeOnly: false });
  for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1], clause: "", typeOnly: false });
  return out;
}

function resolve(fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(path.join(ROOT, fromRel)), spec);
  else return null; // a package
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return rel(c);
  }
  return null;
}

const SERVICE_ROLE = /\bcreateAdminClient(For)?\b|SUPABASE_SERVICE_ROLE_KEY|\bservice_role\b/;
const KEY_CLIENT_MODULES = [/^@\/lib\/supabase\/bare$/, /^@\/server\/postgrest\//, /^@supabase\/ssr$/];
const SUPABASE_JS = /^@supabase\/supabase-js$/;

/** Walk the import graph from the help tools; collect every rule break. */
function scanGraph(): { problems: string[]; reached: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = [...helpFiles(), LEGACY];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const body = code(readSource(f));
    // session.ts needs no service-role words; keyRole compares the JWT claim by string — allow it there only.
    if (SERVICE_ROLE.test(f === SESSION ? body.replace(/["']service_role["']/g, "") : body)) problems.push(`${f}: names the service role / admin client`);
    for (const imp of importsOf(body)) {
      if (imp.typeOnly) continue;
      if (KEY_CLIENT_MODULES.some((r) => r.test(imp.spec))) problems.push(`${f}: imports ${imp.spec} (builds a client from a key)`);
      if (SUPABASE_JS.test(imp.spec)) problems.push(`${f}: value import from @supabase/supabase-js (only \`import type\` allowed)`);
      const target = resolve(f, imp.spec);
      if (target === SERVER) {
        const names = imp.clause.replace(/[{}\s]/g, "").split(",").filter(Boolean);
        if (f !== SESSION || names.join(",") !== "createClient") problems.push(`${f}: imports @/lib/supabase/server (${imp.clause.trim() || "side effect"}) — only session.ts may, and only { createClient }`);
        continue; // never walk into the module that also defines the admin client
      }
      if (target && !isTest(target)) queue.push(target);
    }
  }
  return { problems, reached: [...seen] };
}

describe("R-2774 Help AI tools never reach the service role", () => {
  it("the help-tools import graph names no admin client, service-role key or key-built client", () => {
    const { problems, reached } = scanGraph();
    expect(reached.length).toBeGreaterThan(helpFiles().length); // the walk really followed imports
    expect(problems).toEqual([]);
  });

  it("the scanner catches a planted admin import (self-test)", () => {
    const planted = code(`import { createAdminClient } from "@/lib/supabase/server";\nconst c = createAdminClient();`);
    expect(SERVICE_ROLE.test(planted)).toBe(true);
    const imps = importsOf(`import { createClient as x } from "@supabase/supabase-js";\nimport type { A } from "@/lib/supabase/bare";\nconst m = await import("@/lib/supabase/bare");`);
    expect(imps.filter((i) => !i.typeOnly).map((i) => i.spec)).toEqual(["@supabase/supabase-js", "@/lib/supabase/bare"]);
    expect(resolve(SESSION, "@/lib/supabase/server")).toBe(SERVER);
    expect(code("// createAdminClient()\n/* SUPABASE_SERVICE_ROLE_KEY */ const a = 1;")).not.toMatch(SERVICE_ROLE);
  });

  it("only reader.ts touches tables; no rpc / storage / auth / env in help tools", () => {
    const bad: string[] = [];
    for (const f of helpFiles()) {
      const body = code(readSource(f));
      if (!f.endsWith("/reader.ts") && /\.from\(\s*[a-zA-Z"'`]/.test(body.replace(/\b(Array|Buffer)\.from\(/g, ""))) bad.push(`${f}: .from( outside reader.ts`);
      if (/\.rpc\s*\(|\.storage\b|\.auth\./.test(body)) bad.push(`${f}: rpc / storage / auth`);
      const env = [...body.matchAll(/process\.env(?:\.(\w+)|\[)/g)].map((m) => m[1] ?? "[dynamic]");
      const allowed = f.endsWith("/registry.ts") ? ["HELP_AI_V2"] : [];
      for (const e of env) if (!allowed.includes(e)) bad.push(`${f}: reads process.env.${e}`);
    }
    expect(bad).toEqual([]);
  });

  it("scopedReader / sessionClient are called only by the runner and the legacy path", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); continue; }
        if (!/\.tsx?$/.test(e.name) || isTest(e.name)) continue;
        const f = rel(full);
        if (/\b(scopedReader|sessionClient)\s*\(/.test(code(readSource(f)))) callers.push(f);
      }
    };
    walk(SRC);
    const ok = new Set([`${HELP_DIR}/runner.ts`, `${HELP_DIR}/reader.ts`, `${HELP_DIR}/session.ts`, LEGACY]);
    expect(callers.filter((f) => !ok.has(f))).toEqual([]);
  });

  it("no credential table and no table with a secret column is help-readable", () => {
    const secretTables = new Set(SECRET_COLUMNS.map((c) => c.split(".")[0]));
    for (const t of HELP_READ_TABLES) {
      expect(HELP_NEVER_TABLES, t).not.toContain(t);
      expect(secretTables.has(t), t).toBe(false);
    }
    for (const t of secretTables) expect(HELP_NEVER_TABLES).toContain(t);
  });
});
