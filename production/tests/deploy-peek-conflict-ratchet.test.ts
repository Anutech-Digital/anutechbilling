import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { splitScript, pgProcPeekChecks, parseDeployHeaders } from "../scripts/ops/gen-deploy-db.mjs";
import { readSource } from "@/lib/testing/source-cache"; // R-2646: shared, always-fresh read cache (R-2564/R-2630)

// R-2106 (31 Oct 2026): the staging DB step ended "Still missing: r2095receiptlinkundo".
// 20261030123423's deploy-peek required public.tg_bank_txn_payment_link() to EXIST, and the later
// 20261030131008 (which drops it) had a peek requiring it to be ABSENT. The deploy script reads every
// peek once BEFORE applying anything, and its final check wants every peek true — two peeks that can
// never both be true always end in "Still missing" (or re-run the older file on every deploy).
//
// Rule: no migration's peek may require an object to exist when a LATER migration's peek requires
// that same object to be absent. Objects read here: to_regprocedure / to_regclass / to_regtype
// ("is not null" vs "is null") and pg_trigger tgname ("exists" vs "not exists").
//
// Fixing such a pair: change ONLY the `-- deploy-peek:` line of the old file. scripts/migration-order-check.mjs
// (CI) allows a header-only edit of a shipped migration and nothing else — not even a comment line
// (R-2106's first push added two comment lines and turned CI red, and removing them was red again,
// because CI diffs each push against the previous one).

// The deploy scripts' MIGS lines are exactly what runs, in apply order (old files without a header
// are not in them). tests/gen-deploy-db.test.ts proves the scripts match supabase/migrations.
const scripts = ["staging", "live"].map((env) =>
  path.resolve(__dirname, "..", "supabase", "cloudsql", env, "deploy-db-2026-10-07.sh"),
);

type Reqs = { present: Set<string>; absent: Set<string> };

const norm = (s: string) => s.replace(/\s+/g, "").replace(/^public\./, "").toLowerCase();

/** Top-level `and` conjuncts (outside parentheses/quotes); one pair of wrapping parens is peeled off. */
function conjuncts(peek: string): string[] {
  let s = peek.trim();
  const wraps = (x: string) => {
    if (!x.startsWith("(") || !x.endsWith(")")) return false;
    let d = 0;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === "(") d++;
      else if (x[i] === ")" && --d === 0 && i < x.length - 1) return false;
    }
    return true;
  };
  while (wraps(s)) s = s.slice(1, -1).trim();
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && depth === 0 && /^\sand\s/i.test(s.slice(i, i + 5))) {
      out.push(s.slice(start, i).trim());
      start = i + 5;
      i += 4;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

/**
 * Objects a peek strictly requires to exist / to be absent: only a whole top-level `and` conjunct
 * counts, so `x is null or …` and `case when x is null then …` (a peek that tolerates both) do not.
 */
function peekRequirements(peek: string): Reqs {
  const present = new Set<string>();
  const absent = new Set<string>();
  const reg = /^to_reg(procedure|class|type)\(\s*'([^']+)'\s*\)\s+is\s+(not\s+)?null$/i;
  const trg = /^(not\s+)?exists\s*\(\s*select\s+1\s+from\s+pg_trigger\s+where\s+tgname\s*=\s*'([^']+)'.*\)$/i;
  for (const c of conjuncts(peek)) {
    let m = reg.exec(c);
    if (m) (m[3] ? present : absent).add(`${m[1].toLowerCase()}:${norm(m[2])}`);
    m = trg.exec(c);
    if (m) (m[1] ? absent : present).add(`trigger:${m[2].toLowerCase()}`);
  }
  return { present, absent };
}

/** Pairs (earlier requires present, later requires absent) among peeks given in apply order. */
function peekConflicts(list: { file: string; peek: string }[]): string[] {
  const out: string[] = [];
  const reqs = list.map((x) => ({ ...x, r: peekRequirements(x.peek) }));
  reqs.forEach((a, i) => {
    for (const b of reqs.slice(i + 1)) {
      for (const obj of a.r.present) if (b.r.absent.has(obj)) out.push(`${a.file} needs ${obj} present, later ${b.file} needs it absent`);
    }
  });
  return out;
}

/** MIGS lines `"key|file|user|peek"` → { file, peek } in apply order. */
function migrationPeeks(scriptPath: string = scripts[0]): { file: string; peek: string }[] {
  const body: string[] = splitScript(fs.readFileSync(scriptPath, "utf8"), scriptPath).body;
  return body
    .map((l) => /^\s*"[^|]+\|([^|]+)\|[^|]+\|([^"]*)"/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: m[1], peek: m[2] }));
}

describe("deploy-peek conflict ratchet (R-2106)", () => {
  it("reads present/absent requirements", () => {
    const r = peekRequirements(
      "to_regprocedure('public.f()') is not null and to_regclass('public.t') is null and not exists(select 1 from pg_trigger where tgname = 'trg_x')",
    );
    expect([...r.present]).toEqual(["procedure:f()"]);
    expect([...r.absent].sort()).toEqual(["class:t", "trigger:trg_x"]);
    // a peek that tolerates both states is no strict requirement
    expect([...peekRequirements("(to_regprocedure('public.f()') is null or not has_function_privilege('anon', 'public.f()', 'execute'))").absent]).toEqual([]);
    expect([...peekRequirements("case when to_regclass('public.t') is null then false else true end").absent]).toEqual([]);
    expect([...peekRequirements("(to_regclass('public.t') is not null and exists(select 1 from pg_trigger where tgname = 'trg_y' and tgrelid = to_regclass('public.t')))").present].sort()).toEqual(["class:t", "trigger:trg_y"]);
  });

  it("flags an earlier present + later absent pair (the r2095 shape)", () => {
    expect(
      peekConflicts([
        { file: "a.sql", peek: "to_regprocedure('public.tg_x()') is not null" },
        { file: "b.sql", peek: "to_regprocedure('public.tg_x()') is null" },
      ]),
    ).toHaveLength(1);
  });

  it.each(scripts.map((p) => [path.basename(path.dirname(p)), p]))(
    "no two migrations' peeks contradict each other (%s deploy script)",
    (_env, p) => {
      const peeks = migrationPeeks(p);
      expect(peeks.length).toBeGreaterThan(100);
      expect(peekConflicts(peeks)).toEqual([]);
    },
  );

  it("r2095 pair: the undo's peek needs 123423's work done AND its trigger gone", () => {
    const peeks = migrationPeeks();
    const sale = peeks.find((p) => p.file === "20261030123423_r2095_sale_invoice_on_receipt.sql")!.peek;
    const undo = peeks.find((p) => p.file === "20261030131008_r2095_receipt_link_undo.sql")!.peek;
    expect(sale).not.toMatch(/tg_bank_txn_payment_link/);
    // false before 123423 ran (its column is a positive marker) …
    expect(undo).toMatch(/column_name = 'invoice_on_receipt'/);
    // … and false whenever the trigger or function still exists
    expect(undo).toMatch(/not exists\(select 1 from pg_trigger where tgname = 'trg_bank_txn_payment_link'\)/);
    expect(undo).toMatch(/to_regprocedure\('public\.tg_bank_txn_payment_link\(\)'\) is null/);
  });
});

// ── R-2646 (10 Nov 2026): a peek's `prosrc like` marker must not be in an OLDER body ────────────
// R-2632's migration had `-- deploy-peek: exists(… to_regprocedure('public.correct_invoice_date(text,date,text)')
// and prosrc like '%R-2632%')`, but the R-2173 body it replaces already said "not available yet (R-2632)"
// in a message. The peek was TRUE before the file ran, so the staging/live DB step would have reported it
// applied and silently SKIPPED it — the fix would never reach the DB. A checker caught it by hand.
//
// Rule: for every migration whose own `-- deploy-peek:` tests a public function's prosrc (like/ilike, in a
// non-negated exists(… from pg_proc …) block — gen-deploy-db's pgProcPeekChecks, the deploy scripts' own
// parser), NO earlier body of that function (same name and argument types; any earlier one, because the
// deploy step reads every peek once, BEFORE applying, on a DB that may still hold an old body) may pass
// all of the block's tests. This also covers R-2473's widened MIGS peeks: the extra `or <newer marker>`
// is checked here against every body older than that newer file. Fix: a marker only the new body has
// (e.g. '%An issued invoice keeps its number%'), never a bare card id that an older message, comment or
// TODO could already contain. In a shipped migration only the header line may change.

type Body = { fn: string; sig: string; file: string; body: string };

/** LIKE / ILIKE pattern → RegExp over the whole string (% any, _ one char, \ escapes — Postgres defaults). */
function likeToRegExp(pattern: string, ci: boolean): RegExp {
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += esc(pattern[++i]);
    else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += esc(c);
  }
  return new RegExp(`^${re}$`, ci ? "i" : "");
}

/** `like '<x>'` / `ilike '<x>'` (as pgProcPeekChecks gives it) → does `body` pass it? */
function passes(test: string, body: string): boolean {
  const m = /^(i?)like\s+'((?:[^']|'')*)'$/i.exec(test.trim());
  return !!m && likeToRegExp(m[2].replace(/''/g, "'"), m[1] !== "").test(body);
}

/**
 * The SQL with comments, string literals and dollar-quoted bodies blanked to spaces (same length, same
 * positions); the dollar tags themselves stay, so `as $fn$` and its closing tag can still be found.
 */
function codeMask(sql: string): string {
  const out = sql.split("");
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const e = sql.indexOf("\n", i);
      const end = e < 0 ? sql.length : e;
      blank(i, end);
      i = end;
    } else if (two === "/*") {
      const e = sql.indexOf("*/", i + 2);
      const end = e < 0 ? sql.length : e + 2;
      blank(i, end);
      i = end;
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
    } else if (sql[i] === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i, i + 64))?.[0];
      if (!tag) {
        i++;
        continue;
      }
      const e = sql.indexOf(tag, i + tag.length);
      const end = e < 0 ? sql.length : e;
      blank(i + tag.length, end);
      i = end + tag.length;
    } else i++;
  }
  return out.join("");
}

const TYPE_ALIAS: Record<string, string> = {
  int: "integer", int4: "integer", int8: "bigint", int2: "smallint", bool: "boolean", float8: "double precision",
  float4: "real", varchar: "character varying", timestamptz: "timestamp with time zone", timetz: "time with time zone",
  decimal: "numeric", char: "character",
};
const MULTI_WORD = /^(double precision|character varying|timestamp (?:with|without) time zone|time (?:with|without) time zone)\b/;

/** One argument's type, normalised the way to_regprocedure's text reads ("public." dropped, aliases folded, (p,s) dropped). */
function argType(arg: string): string | null {
  let a = arg.replace(/\s+default\s[\s\S]*$/i, "").replace(/\s*=[\s\S]*$/, "").trim().toLowerCase().replace(/\s+/g, " ");
  const mode = /^(in|out|inout|variadic)\s+/.exec(a);
  if (mode?.[1] === "out") return null;
  if (mode) a = a.slice(mode[0].length);
  const norm = (t: string) => {
    const s = t.replace(/^public\./, "").replace(/\s*\([^)]*\)/g, "").replace(/"/g, "").trim();
    const arr = /(\[\])+$/.exec(s)?.[0] ?? "";
    const base = s.slice(0, s.length - arr.length);
    return (TYPE_ALIAS[base] ?? base) + arr;
  };
  if (MULTI_WORD.test(a) || !a.includes(" ")) return norm(a); // unnamed argument
  return norm(a.slice(a.indexOf(" ") + 1)); // "<name> <type>"
}

/** Input-argument types of an argument list (a create function header or a to_regprocedure signature). */
function signature(args: string): string {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of args) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(argType).filter((t): t is string => t !== null).join(",").replace(/\s+/g, ""); // pgProcPeekChecks drops spaces
}

/** Every public `create function` body (prosrc = the text between the dollar quotes) in a migration, in file order. */
function functionBodies(sql: string, file: string): Body[] {
  const code = codeMask(sql);
  const out: Body[] = [];
  const head = /create\s+(?:or\s+replace\s+)?function\s+(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const m of code.matchAll(head)) {
    if (m[1] && m[1].toLowerCase() !== "public") continue;
    let depth = 0;
    let close = -1;
    for (let i = m.index + m[0].length - 1; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) continue;
    // the body's tag must come before the statement ends (a quoted or `begin atomic` body has none)
    const tag = /^[^;]*?\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(code.slice(close));
    if (!tag) continue;
    const start = close + tag[0].length;
    const end = code.indexOf(tag[1], start);
    if (end < 0) continue;
    out.push({ fn: m[2].toLowerCase(), sig: signature(code.slice(m.index + m[0].length, close)), file, body: sql.slice(start, end) });
  }
  return out;
}

/**
 * files: migrations in apply order. For each file's OWN header peek (a deploy-skip file is never run and
 * is left out), every non-negated pg_proc block whose prosrc tests ALL pass on an earlier body of that
 * function → one message.
 */
function peekMarkerTraps(files: { file: string; sql: string }[]): string[] {
  const out: string[] = [];
  const bodies = new Map<string, Body[]>(); // fn → every earlier body, oldest first
  for (const { file, sql } of files) {
    let head: { peek: string | null; skip: string | null };
    try {
      head = parseDeployHeaders(sql, file);
    } catch {
      head = { peek: null, skip: null }; // an old file without a header (not in the deploy scripts)
    }
    if (head.skip) continue;
    if (head.peek) {
      for (const c of pgProcPeekChecks(head.peek) as { fn: string; sig: string | null; tests: { test: string }[] }[]) {
        const sig = c.sig === null ? null : signature(c.sig);
        const hit = (bodies.get(c.fn) ?? []).find((b) => (sig === null || b.sig === sig) && c.tests.every((t) => passes(t.test, b.body)));
        if (hit) {
          out.push(`${file}: deploy-peek ${c.fn} ${c.tests.map((t) => t.test).join(" + ")} is already true on the older body from ${hit.file} — the DB step would skip this migration`);
        }
      }
    }
    for (const b of functionBodies(sql, file)) bodies.set(b.fn, [...(bodies.get(b.fn) ?? []), b]);
  }
  return out;
}

const migDir = path.resolve(__dirname, "..", "supabase", "migrations");
const oldBody = `create or replace function public.correct_invoice_date(p_invoice_id text, p_new_date date, p_reason text default 'a, b')
returns jsonb language plpgsql as $fn$
begin
  raise exception 'That move is not available yet (R-2632) - pick a date in the same financial year.';
end $fn$;`;
const newBody = oldBody.replace("That move is not available yet (R-2632)", "R-2632 cross-FY: refused for good");
const peekOf = (marker: string, sig = "text,date,text") =>
  `-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.correct_invoice_date(${sig})') and prosrc like '${marker}')\n`;
const plain = (sql: string) => `-- deploy-peek: true\n${sql}`;

describe("deploy-peek marker not already in an older body (R-2646)", () => {
  it("LIKE/ILIKE read as Postgres does", () => {
    expect(likeToRegExp("%R-2632%", false).test("x (R-2632) y")).toBe(true);
    expect(likeToRegExp("%r-2632%", false).test("R-2632")).toBe(false);
    expect(likeToRegExp("%r-2632%", true).test("R-2632")).toBe(true);
    expect(likeToRegExp("a_c", false).test("abc")).toBe(true);
    expect(likeToRegExp("a\\_c", false).test("abc")).toBe(false);
  });

  it("finds each public function body with its argument types; comments, quoted bodies and other schemas are not bodies", () => {
    const sql = [
      "-- create function public.not_this(a int) as $$ x $$",
      "/* create function public.nor_this(a int) as $$ R-1 $$ */",
      oldBody,
      "create function q() returns int language sql as 'select 1';",
      "create function private.p(a int) returns int language sql as $$ select 2 $$;",
      "create function f(out x int, y varchar(20), z timestamptz) returns int language sql as $$ select 1 $$;",
    ].join("\n");
    const b = functionBodies(sql, "x.sql");
    expect(b.map((x) => [x.fn, x.sig])).toEqual([
      ["correct_invoice_date", "text,date,text"],
      ["f", "charactervarying,timestampwithtimezone"],
    ]);
    expect(b[0].body).toContain("(R-2632)");
    expect(signature("text, int, timestamptz")).toBe("text,integer,timestampwithtimezone");
  });

  it("flags the R-2632 shape: the marker was already in the body it replaces", () => {
    const traps = peekMarkerTraps([
      { file: "a_r2173.sql", sql: plain(oldBody) },
      { file: "b_r2632.sql", sql: peekOf("%R-2632%") + newBody },
    ]);
    expect(traps).toHaveLength(1);
    expect(traps[0]).toMatch(/^b_r2632\.sql: .*already true on the older body from a_r2173\.sql/);
  });

  it("flags a marker in ANY earlier body, not only the newest (a DB behind still holds it)", () => {
    const middle = oldBody.replace("That move is not available yet (R-2632)", "Not this year");
    const traps = peekMarkerTraps([
      { file: "a.sql", sql: plain(oldBody) },
      { file: "b.sql", sql: plain(middle) },
      { file: "c.sql", sql: peekOf("%R-2632%") + newBody },
    ]);
    expect(traps).toEqual([expect.stringMatching(/^c\.sql: .*older body from a\.sql/)]);
  });

  it("passes a marker only the new body has, an overload with other types, a negated block and a deploy-skip file", () => {
    const a = { file: "a.sql", sql: plain(oldBody) };
    expect(peekMarkerTraps([a, { file: "b.sql", sql: peekOf("%R-2632 cross-FY%") + newBody }])).toEqual([]);
    const overload = { file: "a.sql", sql: plain(oldBody.replace("p_new_date date", "p_new_date integer")) };
    expect(peekMarkerTraps([overload, { file: "b.sql", sql: peekOf("%R-2632%") + newBody }])).toEqual([]);
    const negated = `-- deploy-peek: not exists(select 1 from pg_proc where proname = 'correct_invoice_date' and prosrc like '%R-2632%')\n`;
    expect(peekMarkerTraps([a, { file: "b.sql", sql: negated + newBody }])).toEqual([]);
    const skipped = `${peekOf("%R-2632%")}-- deploy-skip: never deployed\n${newBody}`;
    expect(peekMarkerTraps([a, { file: "b.sql", sql: skipped }])).toEqual([]);
  });

  it("no migration's peek marker is already in an older body (supabase/migrations)", () => {
    const files = fs
      .readdirSync(migDir)
      .filter((f) => /^\d{14}_.*\.sql$/.test(f))
      .sort()
      .map((file) => ({ file, sql: readSource(path.join(migDir, file)) }));
    expect(files.length).toBeGreaterThan(500);
    expect(peekMarkerTraps(files)).toEqual([]);
  });
});
