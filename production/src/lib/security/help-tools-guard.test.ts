/**
 * R-2774 / H-01 (14 Nov 2026) — Help AI tools can NEVER reach the service role.
 *
 * Help AI is getting full power for the owner (G-HELPAI). Its tools must run with the signed-in
 * person's own login (RLS) only. This guard reads every file with the TypeScript parser (an AST,
 * so no string, comment or regex literal can hide code — rev2) and fails the build when:
 *
 *   1. any file under src/lib/ai/help-tools (or the legacy help-data-tools.ts), or ANY file they
 *      import (followed transitively through src/), names createAdminClient /
 *      createAdminClientFor / SUPABASE_SERVICE_ROLE_KEY / service_role, or imports a module that
 *      builds a client from a key or reaches the DB with a user / tenant of its choosing
 *      (@/lib/supabase/bare, @supabase/supabase-js or @supabase/ssr as values,
 *      @/server/postgrest/*, @/server/db, @supabase/postgrest-js, @prisma/*, pg, module /
 *      node:module), or has an import()/require() whose argument is not a string literal, or a
 *      local (`@/` or relative) import that does not resolve to a file the walk follows (fail
 *      closed — .js / .mjs too);
 *   2. @/lib/supabase/server is imported anywhere in that graph except help-tools/session.ts —
 *      and there only `createClient` (the cookie client);
 *   3. a help-tools file uses an ambient power: process (registry.ts may read
 *      process.env.HELP_AI_V2 only), fetch, require, createRequire, eval, Function, globalThis,
 *      global, window — or imports an npm package outside HELP_NPM_ALLOWED;
 *   4. a help-tools file other than reader.ts touches tables (`.from(…)`), or any of them calls
 *      `.rpc(`, `.storage` or `.auth` (dot or ["…"] form);
 *   5. scopedReader / sessionClient / runOneTool are called from anywhere but runner.ts and the legacy
 *      help-data-tools.ts (so no one wraps another client into a tool's reader);
 *   6. the readable-table allowlist names a credential table or a table holding a SECRET_COLUMNS
 *      entry (the list is shared with secret-columns.test.ts).
 *
 * Runtime locks are tested in src/lib/ai/help-tools/runner.test.ts (forged session refused,
 * service-role key refused, reader refuses secret columns, query has no write methods).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { readSource } from "@/lib/testing/source-cache";
import { listSourceFiles } from "@/lib/testing/walk-source";
import { SECRET_COLUMNS } from "./secret-columns";
import { HELP_READ_TABLES, HELP_NEVER_TABLES } from "@/lib/ai/help-tools/reader";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const HELP_DIR = "src/lib/ai/help-tools";
const LEGACY = "src/lib/ai/help-data-tools.ts";
const SESSION = `${HELP_DIR}/session.ts`;
const REGISTRY = `${HELP_DIR}/registry.ts`;
const SERVER = "src/lib/supabase/server.ts";

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");
const isTest = (f: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
const isHelpFile = (f: string) => f === LEGACY || f.startsWith(`${HELP_DIR}/`);

function helpFiles(): string[] {
  const dir = path.join(ROOT, HELP_DIR);
  return fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !isTest(f)).map((f) => `${HELP_DIR}/${f}`);
}

const SERVICE_ROLE = /\bcreateAdminClient(For)?\b|SUPABASE_SERVICE_ROLE_KEY|\bservice_role\b/;
/**
 * Modules that build a client from a key, or reach the database with a user / tenant of the
 * caller's choosing (withTenant in @/server/db, a bare postgrest / Prisma / pg client — review M2),
 * or load code by a computed name (module / node:module — createRequire).
 */
const KEY_CLIENT_MODULES = [
  /^@\/lib\/supabase\/bare$/, /^@\/server\/postgrest\//, /^@supabase\/ssr$/,
  /^@\/server\/db(\/|$)/, /^@supabase\/postgrest-js$/, /^@prisma\//, /^pg$/, /^(node:)?module$/,
];
const SUPABASE_JS = /^@supabase\/supabase-js$/;
/** npm packages a help-tools file may import as values (what they use today). */
const HELP_NPM_ALLOWED = ["zod"];
/** Ambient powers no help-tools file may name (rev2 #3). */
const AMBIENT = new Set(["process", "fetch", "require", "createRequire", "eval", "Function", "globalThis", "global", "window"]);
/** Table / RPC / storage / auth members of a Supabase client. */
const CLIENT_MEMBERS = new Set(["from", "rpc", "storage", "auth"]);

interface Imp { spec: string; names: string[]; typeOnly: boolean }

const isLocal = (spec: string) => spec.startsWith("@/") || spec.startsWith(".");

/** A local import → the file it loads, or null when nothing on disk matches. */
function resolve(fromRel: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : path.resolve(path.dirname(path.join(ROOT, fromRel)), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return rel(c);
  }
  return null;
}

const stringArg = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

/** Imported names (the original name for `a as b`; "*" for namespace / default / dynamic). */
function clauseNames(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return ["*"];
  const out: string[] = [];
  if (clause.name) out.push("default");
  const nb = clause.namedBindings;
  if (nb && ts.isNamespaceImport(nb)) out.push("*");
  if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly) out.push((e.propertyName ?? e.name).text);
  return out;
}

/** Is `node` the `x` in `process.env.HELP_AI_V2` read in registry.ts — the one allowed env read? */
function isAllowedEnvRead(f: string, node: ts.Identifier): boolean {
  if (f !== REGISTRY || node.text !== "process") return false;
  const env = node.parent;
  if (!ts.isPropertyAccessExpression(env) || env.expression !== node || env.name.text !== "env") return false;
  const key = env.parent;
  return ts.isPropertyAccessExpression(key) && key.expression === env && key.name.text === "HELP_AI_V2";
}

/** A member name of `x.name` or `x["name"]`, else null. */
function memberName(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) return stringArg(n.argumentExpression);
  return null;
}

interface FileScan { imports: Imp[]; problems: string[] }

/** Parse one file and check it; `src` is the file's text. */
function scanFile(f: string, src: string): FileScan {
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, /\.[cm]?jsx?$/.test(f) ? ts.ScriptKind.JS : f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const help = isHelpFile(f);
  const imports: Imp[] = [];
  const problems: string[] = [];
  const at = (n: ts.Node) => `${f}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  const visit = (node: ts.Node): void => {
    // Imports and re-exports.
    if (ts.isImportDeclaration(node)) {
      const spec = stringArg(node.moduleSpecifier);
      if (spec != null) imports.push({ spec, names: clauseNames(node.importClause), typeOnly: !!node.importClause?.isTypeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = stringArg(node.moduleSpecifier);
      if (spec != null) imports.push({ spec, names: ["*"], typeOnly: node.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = stringArg(node.moduleReference.expression);
      if (spec == null) problems.push(`${at(node)}: import = require() with a computed argument`);
      else imports.push({ spec, names: ["*"], typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const spec = node.arguments.length === 1 ? stringArg(node.arguments[0]) : null;
      if (spec == null) problems.push(`${at(node)}: import()/require() whose argument is not a string literal (it cannot be checked)`);
      else imports.push({ spec, names: ["*"], typeOnly: false });
    }

    // Service-role words in names and strings (comments are not in the AST).
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      // keyRole in session.ts compares the JWT claim with the string "service_role" — allowed there only.
      const allowed = f === SESSION && ts.isStringLiteral(node) && text === "service_role";
      if (!allowed && SERVICE_ROLE.test(text)) problems.push(`${at(node)}: names the service role / admin client (${text.slice(0, 40)})`);
    }

    if (help) {
      // Ambient powers: any identifier use, except as a property name (x.fetch) or a declaration's member name.
      if (ts.isIdentifier(node) && AMBIENT.has(node.text) && !isAllowedEnvRead(f, node)) {
        const p = node.parent;
        const isMemberName = (ts.isPropertyAccessExpression(p) && p.name === node) || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.name === node);
        if (!isMemberName) problems.push(`${at(node)}: uses ${node.text} (no ambient powers in help tools)`);
      }
      // Supabase client members: .from( only in reader.ts; .rpc / .storage / .auth nowhere.
      const m = memberName(node);
      if (m && CLIENT_MEMBERS.has(m)) {
        const obj = (node as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
        const isArrayFrom = m === "from" && ts.isIdentifier(obj) && ["Array", "Buffer", "Object"].includes(obj.text);
        if (m === "from" ? !isArrayFrom && !f.endsWith("/reader.ts") : true) problems.push(`${at(node)}: .${m} on a client (only reader.ts reads tables; no rpc / storage / auth)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const imp of imports) {
    if (imp.typeOnly) continue;
    if (KEY_CLIENT_MODULES.some((r) => r.test(imp.spec))) problems.push(`${f}: imports ${imp.spec} (builds a client from a key / picks its own user)`);
    if (SUPABASE_JS.test(imp.spec)) problems.push(`${f}: value import from @supabase/supabase-js (only \`import type\` allowed)`);
    if (isLocal(imp.spec)) {
      const target = resolve(f, imp.spec);
      if (!target || !/\.tsx?$/.test(target)) problems.push(`${f}: local import ${imp.spec} does not resolve to a .ts file the guard follows (fail closed)`);
      else if (target === SERVER && (f !== SESSION || imp.names.join(",") !== "createClient")) problems.push(`${f}: imports @/lib/supabase/server (${imp.names.join(",")}) — only session.ts may, and only { createClient }`);
    } else if (help && !HELP_NPM_ALLOWED.includes(imp.spec)) {
      problems.push(`${f}: imports npm package ${imp.spec} (help tools may use only ${HELP_NPM_ALLOWED.join(", ")})`);
    }
  }
  return { imports, problems };
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
    const { imports, problems: p } = scanFile(f, readSource(f));
    problems.push(...p);
    for (const imp of imports) {
      if (imp.typeOnly || !isLocal(imp.spec)) continue;
      const target = resolve(f, imp.spec);
      if (!target || target === SERVER) continue; // reported above; never walk into the module that also defines the admin client
      if (!isTest(target)) queue.push(target);
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

  const PLANTED = `${HELP_DIR}/planted.ts`;
  const plantedProblems = (src: string) => scanFile(PLANTED, src).problems;

  it("the scanner catches a planted admin import (self-test)", () => {
    expect(plantedProblems(`import { createAdminClient } from "@/lib/supabase/server";\nconst c = createAdminClient();`)).not.toEqual([]);
    expect(plantedProblems(`import { createClient } from "@/lib/supabase/server";\nconst c = createClient();`)).not.toEqual([]); // only session.ts
    expect(scanFile(SESSION, `import { createClient } from "@/lib/supabase/server";\nconst c = createClient();`).problems).toEqual([]);
    expect(scanFile(SESSION, `import { createClient, createAdminClient as a } from "@/lib/supabase/server";`).problems).not.toEqual([]);
    expect(plantedProblems(`import { createClient as x } from "@supabase/supabase-js";`)).not.toEqual([]);
    expect(plantedProblems(`import type { SupabaseClient } from "@supabase/supabase-js";\nimport type { A } from "@/lib/supabase/bare";\ntype T = typeof import("./types");`)).toEqual([]);
    expect(resolve(SESSION, "@/lib/supabase/server")).toBe(SERVER);
    expect(plantedProblems("// createAdminClient()\n/* SUPABASE_SERVICE_ROLE_KEY */ const a = 1;")).toEqual([]);
  });

  it("the scanner catches a planted import of a module that picks its own user / tenant or talks to the DB directly (self-test, review M2)", () => {
    for (const spec of ["@/server/db", "@/server/db/tenant", "@supabase/postgrest-js", "@prisma/client", "@prisma/adapter-pg", "pg"]) {
      expect(plantedProblems(`import { x } from "${spec}";\nx();`), spec).not.toEqual([]);
      expect(plantedProblems(`const m = await import("${spec}");`), spec).not.toEqual([]);
    }
    expect(plantedProblems(`import type { Pool } from "pg";`)).toEqual([]);
  });

  it("the scanner catches backtick / computed dynamic imports and code hidden after a '//' inside a string (self-test, review L3)", () => {
    expect(plantedProblems("const m = await import(`@/lib/supabase/bare`);")).not.toEqual([]);
    expect(plantedProblems("const p = \"@/lib/supabase/\" + \"bare\";\nconst m = await import(p);")).not.toEqual([]);
    expect(plantedProblems("const m = await import(`@/lib/supabase/${'bare'}`);")).not.toEqual([]);
    expect(plantedProblems("const m = await import(\"@/lib/\" + \"supabase/bare\");")).not.toEqual([]);
    expect(plantedProblems("const u = \"a//b\"; const c = createAdminClient();")).not.toEqual([]);
    expect(plantedProblems("const u = 'http://x'; const m = await import(\"@/lib/supabase/bare\");")).not.toEqual([]);
    expect(plantedProblems("const u = `x//y`; const k = SUPABASE_SERVICE_ROLE_KEY;")).not.toEqual([]);
    expect(plantedProblems("const re = /\\/\\//; const c = createAdminClient();")).not.toEqual([]);
    // still clean: comments that only talk about it, a literal import of a followed file, type-position import()
    expect(plantedProblems("// createAdminClient()\n/* import(x) */ const a = \"x\"; const m = await import(\"./types\");\ntype T = typeof import(\"./types\");")).toEqual([]);
  });

  it("the scanner is the TypeScript parser: no regex / string / comment trick hides code (self-test, rev2 #2-4)", () => {
    // A regex literal after `)` — a hand scanner reads it as division and swallows the next line.
    expect(plantedProblems("declare const x: boolean;\nif (x) /a\\//.test(\"\"); import { createAdminClient as mk } from \"@/lib/supabase/server\";\nmk();")).not.toEqual([]);
    // Ambient powers in a help-tools file: process (any form), fetch, require, createRequire, eval, Function, globalThis.
    expect(plantedProblems("const k = process[\"env\"][\"SUPABASE_\" + \"SERVICE_ROLE_KEY\"];")).not.toEqual([]);
    expect(plantedProblems("const r = fetch(\"https://db.example/rest/v1/tenant_secrets\");")).not.toEqual([]);
    expect(plantedProblems("import { createRequire } from \"node:module\";\nconst req = createRequire(import.meta.url);\nconst pg = req(\"p\" + \"g\");")).not.toEqual([]);
    expect(plantedProblems("import * as m from \"module\";\nconst x = m;")).not.toEqual([]);
    expect(plantedProblems("const r = require;\nconst pg = r(\"pg\");")).not.toEqual([]);
    expect(plantedProblems("const f = eval(\"1\");")).not.toEqual([]);
    expect(plantedProblems("const f = new Function(\"return 1\");")).not.toEqual([]);
    expect(plantedProblems("const g = globalThis;")).not.toEqual([]);
    // A local import that does not resolve to a file the walk follows fails closed (.js / .mjs too).
    expect(plantedProblems("import { x } from \"./nope.js\";\nx();")).not.toEqual([]);
    expect(plantedProblems("import { x } from \"@/lib/does-not-exist.mjs\";\nx();")).not.toEqual([]);
    // npm packages from a help-tools file: only the allowlist.
    expect(plantedProblems("import axios from \"axios\";\naxios.get(\"/\");")).not.toEqual([]);
    expect(plantedProblems("import { z } from \"zod\";\nconst s = z.string();")).toEqual([]);
  });

  it("the scanner catches table / rpc / storage / auth use and env reads in help tools (self-test)", () => {
    expect(plantedProblems("declare const c: any;\nc.from(\"invoices\");")).not.toEqual([]);
    expect(plantedProblems("declare const c: any;\nc[\"rpc\"](\"x\");")).not.toEqual([]);
    expect(plantedProblems("declare const c: any;\nc.storage.from(\"b\");")).not.toEqual([]);
    expect(plantedProblems("declare const c: any;\nc.auth.getUser();")).not.toEqual([]);
    expect(plantedProblems("const v = process.env.HELP_AI_V2;")).not.toEqual([]); // only registry.ts
    expect(scanFile(REGISTRY, "const v = process.env.HELP_AI_V2;").problems).toEqual([]);
    expect(scanFile(REGISTRY, "const v = process.env.OTHER;").problems).not.toEqual([]);
    // Array.from and a property merely NAMED fetch are not client / ambient uses.
    expect(plantedProblems("const a = Array.from([1]); const o = { fetch: 1 }.fetch;")).toEqual([]);
  });

  it("scopedReader / sessionClient / runOneTool are called only by the runner and the legacy path", () => {
    const NAMES = new Set(["scopedReader", "sessionClient", "runOneTool"]);
    const callers: string[] = [];
    for (const full of listSourceFiles(SRC, (name) => /\.tsx?$/.test(name) && !isTest(name))) {
      const f = rel(full);
      const src = readSource(f);
      if (!/scopedReader|sessionClient|runOneTool/.test(src)) continue;
      const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      let calls = false;
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && NAMES.has(n.expression.text)) calls = true;
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (calls) callers.push(f);
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
