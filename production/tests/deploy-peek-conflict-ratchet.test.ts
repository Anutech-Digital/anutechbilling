import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { splitScript } from "../scripts/ops/gen-deploy-db.mjs";

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
