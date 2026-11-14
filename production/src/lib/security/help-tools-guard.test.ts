/**
 * R-2774 / H-01 (14 Nov 2026) — Help AI tools can NEVER reach the service role.
 *
 * Help AI is getting full power for the owner (G-HELPAI). Its tools must run with the signed-in
 * person's own login (RLS) only. This guard fails the build when:
 *
 *   1. any file under src/lib/ai/help-tools (or the legacy help-data-tools.ts), or ANY file they
 *      import (followed transitively through src/), names createAdminClient /
 *      createAdminClientFor / SUPABASE_SERVICE_ROLE_KEY, or imports a module that builds a client
 *      from a key or reaches the DB with a user / tenant of its choosing (@/lib/supabase/bare,
 *      @supabase/supabase-js or @supabase/ssr as values, @/server/postgrest/*, @/server/db,
 *      @supabase/postgrest-js, @prisma/*, pg), or has an import()/require() whose argument is not
 *      a plain string literal (it could not be checked);
 *   2. @/lib/supabase/server is imported anywhere in that graph except help-tools/session.ts —
 *      and there only `createClient` (the cookie client);
 *   3. a help-tools file other than reader.ts touches tables (`.from("…")`), or any of them calls
 *      `.rpc(`, `.storage` or `.auth.`, or reads process.env (registry.ts may read HELP_AI_V2 only);
 *   4. scopedReader / sessionClient / runOneTool are called from anywhere but runner.ts and the legacy
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
import { listSourceFiles } from "@/lib/testing/walk-source";
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

/**
 * Comments out, so a file that only TALKS about the admin client does not fail. A small scanner,
 * not a regex: strings ('…', "…", `…${…}…`) and regex literals are kept as they are, so a `//`
 * inside one never hides the code after it (review L3).
 */
function code(src: string): string {
  const n = src.length;
  let out = "";
  let i = 0;
  let depth = 0; // { } depth in code
  const templates: number[] = []; // depth at each open `${`
  let prev = ""; // last non-space code char
  const regexCanStart = () => prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|case|do|else|in|of|void|yield|await|instanceof)$/.test(out.trimEnd());
  const templateText = () => { // i is just past a "`" or a closing "}" of `${`
    while (i < n) {
      const c = src[i];
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { out += c; i++; prev = "`"; return; }
      if (c === "$" && src[i + 1] === "{") { out += "${"; i += 2; depth++; templates.push(depth); prev = "{"; return; }
      out += c; i++;
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      out += src.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "`") { out += c; i++; templateText(); continue; }
    if (c === "/" && regexCanStart()) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n") {
        const ch = src[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "[") cls = true;
        else if (ch === "]") cls = false;
        else if (ch === "/" && !cls) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = "a";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
        depth--;
        out += c;
        i++;
        templateText();
        continue;
      }
      depth--;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
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
  for (const m of src.matchAll(DYNAMIC_LITERAL)) out.push({ spec: m[2], clause: "", typeOnly: false });
  return out;
}

/** `import("x")` / `require('x')` / import(`x`) with a plain string literal (no `${}`) — the only dynamic form allowed. */
const DYNAMIC_LITERAL = /(?<![\w$.])(?:import|require)\s*\(\s*(["'`])([^"'`$\\\n]+)\1\s*\)/g;
const DYNAMIC_ANY = /(?<![\w$.])(?:import|require)\s*\(/g;

/** Dynamic imports whose argument is anything but a plain string literal (review L3). */
function nonLiteralImports(src: string): number {
  const all = [...src.matchAll(DYNAMIC_ANY)].length;
  const literal = [...src.matchAll(DYNAMIC_LITERAL)].length;
  return all - literal;
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
/**
 * Modules that build a client from a key, or reach the database with a user / tenant of the
 * caller's choosing (withTenant in @/server/db, a bare postgrest / Prisma / pg client — review M2).
 */
const KEY_CLIENT_MODULES = [
  /^@\/lib\/supabase\/bare$/, /^@\/server\/postgrest\//, /^@supabase\/ssr$/,
  /^@\/server\/db(\/|$)/, /^@supabase\/postgrest-js$/, /^@prisma\//, /^pg$/,
];
const SUPABASE_JS = /^@supabase\/supabase-js$/;

/** The per-file rules (comments already stripped from `body`): service-role words, key-built clients. */
function fileProblems(f: string, body: string): string[] {
  const problems: string[] = [];
  // session.ts needs no service-role words; keyRole compares the JWT claim by string — allow it there only.
  if (SERVICE_ROLE.test(f === SESSION ? body.replace(/["']service_role["']/g, "") : body)) problems.push(`${f}: names the service role / admin client`);
  for (const imp of importsOf(body)) {
    if (imp.typeOnly) continue;
    if (KEY_CLIENT_MODULES.some((r) => r.test(imp.spec))) problems.push(`${f}: imports ${imp.spec} (builds a client from a key)`);
    if (SUPABASE_JS.test(imp.spec)) problems.push(`${f}: value import from @supabase/supabase-js (only \`import type\` allowed)`);
  }
  const computed = nonLiteralImports(body);
  if (computed) problems.push(`${f}: ${computed} import()/require() with a computed or template argument (only a plain string literal can be checked)`);
  return problems;
}

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
    problems.push(...fileProblems(f, body));
    for (const imp of importsOf(body)) {
      if (imp.typeOnly) continue;
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

  const PLANTED = `${HELP_DIR}/planted.ts`;
  const plantedProblems = (src: string) => fileProblems(PLANTED, code(src));

  it("the scanner catches a planted import of a module that picks its own user / tenant or talks to the DB directly (self-test, review M2)", () => {
    for (const spec of ["@/server/db", "@/server/db/tenant", "@supabase/postgrest-js", "@prisma/client", "@prisma/adapter-pg", "pg"]) {
      expect(plantedProblems(`import { x } from "${spec}";\nx();`), spec).not.toEqual([]);
      expect(plantedProblems(`const m = await import("${spec}");`), spec).not.toEqual([]);
    }
    expect(plantedProblems(`import { x } from "pg-format";\nimport { y } from "@/server/dbx";`)).toEqual([]);
    expect(plantedProblems(`import type { Pool } from "pg";`)).toEqual([]);
  });

  it("the scanner catches backtick / computed dynamic imports and code hidden after a '//' inside a string (self-test, review L3)", () => {
    expect(plantedProblems("const m = await import(`@/lib/supabase/bare`);")).not.toEqual([]);
    expect(plantedProblems("const p = \"@/lib/supabase/\" + \"bare\";\nconst m = await import(p);")).not.toEqual([]);
    expect(plantedProblems("const m = await import(`@/lib/supabase/${'bare'}`);")).not.toEqual([]);
    expect(plantedProblems("const m = await import(\"@/lib/\" + \"supabase/bare\");")).not.toEqual([]);
    expect(plantedProblems("const m = require(name);")).not.toEqual([]);
    expect(plantedProblems("const u = \"a//b\"; const c = createAdminClient();")).not.toEqual([]);
    expect(plantedProblems("const u = 'http://x'; const m = await import(\"@/lib/supabase/bare\");")).not.toEqual([]);
    expect(plantedProblems("const u = `x//y`; const k = process.env.SUPABASE_SERVICE_ROLE_KEY;")).not.toEqual([]);
    expect(plantedProblems("const re = /\\/\\//; const c = createAdminClient();")).not.toEqual([]);
    // still clean: comments that only talk about it, a literal import of a safe module, type-position import()
    expect(plantedProblems("// createAdminClient()\n/* import(x) */ const a = \"x\"; const m = await import(\"./types\");\ntype T = typeof import(\"./types\");")).toEqual([]);
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

  it("scopedReader / sessionClient / runOneTool are called only by the runner and the legacy path", () => {
    const callers: string[] = [];
    for (const full of listSourceFiles(SRC, (name) => /\.tsx?$/.test(name) && !isTest(name))) {
      const f = rel(full);
      const src = readSource(f);
      if (!/scopedReader|sessionClient|runOneTool/.test(src)) continue;
      if (/\b(scopedReader|sessionClient|runOneTool)\s*\(/.test(code(src))) callers.push(f);
    }
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
