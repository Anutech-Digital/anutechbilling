/**
 * R-401 (7 Oct 2026) — every new SECURITY INVOKER function must say who may EXECUTE it.
 *
 * What happened (R-400): `20261007160000_quote_one_billing_term.sql` created the helper
 * `public.quote_line_terms_mixed(jsonb)` and a trigger on `quotes` that calls it, with no
 * GRANT. Local Supabase hands every new function in `public` to authenticated (default
 * privileges of role postgres) and to PUBLIC, so every local test was green. Cloud SQL
 * (staging/live) runs migrations as a role with NO such defaults — so the trigger, which runs
 * as the signed-in caller, could not call its helper, and every quote save on staging was
 * a 403 "permission denied for function quote_line_terms_mixed". Hotfix:
 * `20261007250000_quote_terms_fn_grant.sql`.
 *
 * The rule, for every `create [or replace] function public.X(...)` in a migration from
 * 20261001 onward that is NOT `security definer`:
 *   - after all migrations (baseline first, file order, drop resets grants), X with that exact
 *     argument list holds an explicit `grant execute ... to authenticated`;
 *   - or X is in SERVICE_ROLE_ONLY (it must then be granted to service_role), or in
 *     DEFINER_INTERNAL (only ever called from inside SECURITY DEFINER code, which runs as the
 *     owner) — each with a written reason;
 *   - trigger functions (`returns trigger`) are exempt themselves: Postgres checks EXECUTE on
 *     a trigger function once, at CREATE TRIGGER, as the table owner. What they CALL is not:
 *     an invoker trigger runs as the caller, so every invoker helper it calls must be granted
 *     to authenticated — no allow-list excuses that (the exact R-400 shape).
 *
 * `grant ... to anon` never satisfies the rule — definer-hardening-holds.test.ts forbids it.
 * The CI half (sql-tests.yml revokes the local defaults before migrations, and
 * supabase/tests/authenticated_quote_write_cloudsql.test.sql writes a quote as
 * authenticated) proves the same thing against a real database.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "supabase/migrations";
const FROM = "20261001";

/** Invoker functions granted to service_role only, on purpose. Must hold that grant. */
const SERVICE_ROLE_ONLY: Record<string, string> = {
  audit_service_actor:
    "R-051: returns the acting user only for admin-client (service_role) writes; called by " +
    "the SECURITY DEFINER log_row_change trigger. authenticated is revoked on purpose " +
    "(admin-actor.test.ts).",
};

/** Invoker functions only ever called from inside SECURITY DEFINER code (runs as owner). */
const DEFINER_INTERNAL: Record<string, string> = {
  customer_name_key:
    "20261003130000: used only by customer_names_agree, inside match_existing_customer (definer).",
  customer_names_agree:
    "20261003130000: used only inside match_existing_customer (security definer).",
};

/* ── parsing ──────────────────────────────────────────────────────────────── */

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const MULTIWORD_TYPE_START = new Set(["double", "character", "timestamp", "time", "bit", "interval"]);
const TYPE_ALIAS: Record<string, string> = {
  int: "integer", int4: "integer", int8: "bigint", int2: "smallint", bool: "boolean",
  timestamptz: "timestamp with time zone", varchar: "character varying",
  float8: "double precision", float4: "real", decimal: "numeric",
};

/** Split on commas that are not inside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** "p_x text default null, out y int" → "text"; types only, normalised. */
function normArgs(args: string): string {
  return splitTop(args.replace(/"/g, "").toLowerCase())
    .map((p) => p.split(/\s+default\s+|\s*=\s*/)[0].trim().replace(/\s+/g, " "))
    .filter((p) => p && !/^(out)\s/.test(p))
    .map((p) => p.replace(/^(in|inout|variadic)\s+/, ""))
    .map((p) => {
      const t = p.split(" ");
      const ty = t.length >= 2 && !MULTIWORD_TYPE_START.has(t[0]) ? t.slice(1).join(" ") : p;
      return ty.replace(/^public\./, "").replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)/, "")
        .replace(/^([a-z0-9_]+)/, (w) => TYPE_ALIAS[w] ?? w);
    })
    .join(",");
}

type Fn = { name: string; sig: string; file: string; definer: boolean; trigger: boolean; body: string };
type Event =
  | { at: number; kind: "create"; fn: Fn }
  | { at: number; kind: "drop"; name: string; sig: string | null }
  | { at: number; kind: "grant" | "revoke"; name: string; sig: string; roles: string[] }
  | { at: number; kind: "trigger"; file: string; trigger: string; fnName: string };

/** Read the argument list starting right after an opening "(" at `i`; returns [args, endIndex]. */
function readParens(src: string, i: number): [string, number] {
  let depth = 1, j = i;
  while (j < src.length && depth > 0) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")") depth--;
    j++;
  }
  return [src.slice(i, j - 1), j];
}

function eventsOf(file: string, raw: string): Event[] {
  const src = stripComments(raw).replace(/"public"\./g, "public.");
  const ev: Event[] = [];

  const cre = /create\s+(?:or\s+replace\s+)?function\s+(public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = cre.exec(src))) {
    if (!m[1]) continue; // only schema-qualified public.* functions are in scope
    const [args, after] = readParens(src, cre.lastIndex);
    const tag = /\$[a-z_]*\$/i.exec(src.slice(after));
    let header: string, body: string, trailer: string;
    if (tag) {
      const open = after + tag.index;
      const close = src.indexOf(tag[0], open + tag[0].length);
      header = src.slice(after, open);
      body = src.slice(open + tag[0].length, close);
      const end = src.indexOf(";", close + tag[0].length);
      trailer = src.slice(close + tag[0].length, end < 0 ? undefined : end);
    } else {
      const end = src.indexOf(";", after);
      header = src.slice(after, end); body = ""; trailer = "";
    }
    ev.push({
      at: m.index, kind: "create",
      fn: {
        name: m[2].toLowerCase(), sig: normArgs(args), file,
        definer: /security\s+definer/i.test(header + " " + trailer),
        trigger: /returns\s+(event_)?trigger\b/i.test(header),
        body,
      },
    });
  }

  const drop = /drop\s+function\s+(?:if\s+exists\s+)?public\.([a-z0-9_]+)\s*(\()?/gi;
  while ((m = drop.exec(src))) {
    const sig = m[2] ? normArgs(readParens(src, drop.lastIndex)[0]) : null;
    ev.push({ at: m.index, kind: "drop", name: m[1].toLowerCase(), sig });
  }

  const gr = /\b(grant|revoke)\s+(?:execute|all(?:\s+privileges)?)\s+on\s+function\s+([\s\S]*?)\s+(to|from)\s+([^;']+)/gi;
  while ((m = gr.exec(src))) {
    const roles = m[4].toLowerCase().replace(/"/g, "").split(",").map((r) => r.trim().split(/\s/)[0]);
    for (const target of splitTop(m[2])) {
      const t = /public\.([a-z0-9_]+)\s*\(([\s\S]*)\)\s*$/i.exec(target.trim());
      if (!t) continue;
      ev.push({ at: m.index, kind: m[1].toLowerCase() as "grant" | "revoke", name: t[1].toLowerCase(), sig: normArgs(t[2]), roles });
    }
  }

  const trg = /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+"?([a-z0-9_]+)"?[\s\S]*?execute\s+(?:function|procedure)\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
  while ((m = trg.exec(src))) ev.push({ at: m.index, kind: "trigger", file, trigger: m[1], fnName: m[2].toLowerCase() });

  return ev.sort((a, b) => a.at - b.at);
}

type Finding = { file: string; fn: string; problem: string };

/**
 * Replays baseline + migrations in order and returns every rule break. Pure: the test below
 * feeds it a copy of the migrations WITHOUT the R-400 hotfix grant and requires a finding.
 */
function analyse(files: Array<[string, string]>): { findings: Finding[]; checked: Fn[] } {
  const grants = new Map<string, Set<string>>(); // "name(sig)" → roles
  const latest = new Map<string, Fn>(); // "name(sig)" → newest definition
  const scanned: Fn[] = [];
  const triggers: Array<{ file: string; trigger: string; fnName: string }> = [];
  const key = (n: string, s: string) => `${n}(${s})`;

  for (const [file, text] of files) {
    const inScope = file.slice(0, FROM.length) >= FROM && file !== "baseline.sql";
    for (const e of eventsOf(file, text)) {
      if (e.kind === "create") {
        latest.set(key(e.fn.name, e.fn.sig), e.fn);
        if (!grants.has(key(e.fn.name, e.fn.sig))) grants.set(key(e.fn.name, e.fn.sig), new Set());
        if (inScope) scanned.push(e.fn);
      } else if (e.kind === "drop") {
        for (const k of [...grants.keys()]) {
          if (k === key(e.name, e.sig ?? "") || (e.sig === null && k.startsWith(e.name + "("))) grants.delete(k);
        }
      } else if (e.kind === "grant" || e.kind === "revoke") {
        const k = key(e.name, e.sig);
        const set = grants.get(k) ?? new Set<string>();
        for (const r of e.roles) { if (e.kind === "grant") set.add(r); else set.delete(r); }
        grants.set(k, set);
      } else if (e.kind === "trigger" && inScope) {
        triggers.push(e);
      }
    }
  }

  const findings: Finding[] = [];
  const has = (f: Fn, role: string) => grants.get(key(f.name, f.sig))?.has(role) ?? false;
  const seen = new Set<string>();
  for (const f of scanned) {
    const k = key(f.name, f.sig);
    if (seen.has(k) || f.definer || f.trigger) continue;
    seen.add(k);
    const last = latest.get(k);
    if (last && last.definer) continue; // a later migration made it definer
    if (SERVICE_ROLE_ONLY[f.name]) {
      if (!has(f, "service_role")) findings.push({ file: f.file, fn: k, problem: "SERVICE_ROLE_ONLY but no grant execute to service_role" });
      continue;
    }
    if (DEFINER_INTERNAL[f.name]) continue;
    if (!has(f, "authenticated")) {
      findings.push({ file: f.file, fn: k, problem: "SECURITY INVOKER with no `grant execute on function public." + k + " to authenticated`" });
    }
  }

  /* Triggers: an invoker trigger function runs as the caller, so each invoker helper it calls
     must be granted to authenticated. No allow-list applies here. */
  const byName = (n: string) => [...latest.values()].filter((f) => f.name === n);
  for (const t of triggers) {
    for (const tf of byName(t.fnName)) {
      if (tf.definer) continue;
      for (const c of tf.body.matchAll(/public\.([a-z0-9_]+)\s*\(/gi)) {
        const helpers = byName(c[1].toLowerCase()).filter((h) => !h.definer && !h.trigger);
        const fn = `${t.trigger} → ${tf.name}() → ${c[1]}()`;
        if (helpers.length && !helpers.some((h) => has(h, "authenticated")) && !findings.some((x) => x.fn === fn)) {
          findings.push({
            file: t.file, fn,
            problem: "trigger runs as the caller and calls an invoker helper not granted to authenticated",
          });
        }
      }
    }
  }
  return { findings, checked: scanned };
}

/* ── the real tree ────────────────────────────────────────────────────────── */

const migrationFiles = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const tree: Array<[string, string]> = [
  ["baseline.sql", readFileSync("supabase/baseline.sql", "utf8")],
  ...migrationFiles.map((f): [string, string] => [f, readFileSync(`${DIR}/${f}`, "utf8")]),
];
const HOTFIX = "20261007250000_quote_terms_fn_grant.sql";

describe("R-401: new SECURITY INVOKER functions carry an explicit EXECUTE grant", () => {
  const { findings, checked } = analyse(tree);

  it("scanned enough functions for the rule to mean something", () => {
    expect(checked.filter((f) => !f.definer).length).toBeGreaterThan(10);
    expect(checked.some((f) => f.name === "quote_line_terms_mixed")).toBe(true);
  });

  it("every invoker function from 20261001 on is granted (Cloud SQL gives no PUBLIC default)", () => {
    expect(
      findings,
      findings.map((f) => `${f.file}: ${f.fn} — ${f.problem}`).join("\n") +
        "\nAdd `grant execute on function public.<name>(<arg types>) to authenticated;` in the " +
        "migration (never anon). Local Supabase grants it by default; Cloud SQL does not (R-400).",
    ).toEqual([]);
  });

  it("would have caught R-400: without the hotfix grant the quote helper is flagged", () => {
    const hotfix = tree.find(([f]) => f === HOTFIX);
    expect(hotfix).toBeDefined();
    const without = tree.map(([f, t]): [string, string] =>
      f === HOTFIX ? [f, t.replace(/grant execute on function public\.quote_line_terms_mixed\(jsonb\)[^;]*;/gi, "")] : [f, t]);
    const { findings: f2 } = analyse(without);
    const hits = f2.map((x) => x.fn).join("\n");
    expect(hits).toContain("quote_line_terms_mixed(jsonb)");
    expect(hits).toContain("trg_quotes_one_billing_term → quotes_refuse_mixed_billing_term() → quote_line_terms_mixed()");
  });

  it("every allow-list entry is still a real invoker function with a reason", () => {
    const invokers = new Set(checked.filter((f) => !f.definer).map((f) => f.name));
    for (const [name, why] of Object.entries({ ...SERVICE_ROLE_ONLY, ...DEFINER_INTERNAL })) {
      expect(invokers.has(name), `${name} is allow-listed but no migration from ${FROM} creates it as invoker`).toBe(true);
      expect(why.length).toBeGreaterThan(20);
    }
  });

  it("parses argument lists to grant-style type lists", () => {
    expect(normArgs("p_lines jsonb")).toBe("jsonb");
    expect(normArgs('"p_id" "uuid", "p_at" timestamp with time zone DEFAULT now(), out x int')).toBe("uuid,timestamp with time zone");
    expect(normArgs("int4, varchar(20), numeric(12,2)")).toBe("integer,character varying,numeric");
  });
});
