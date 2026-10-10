/**
 * R-013 — a later migration must not undo the 27 Sep security hardening.
 *
 * `20260927100000_definer_rpc_hardening.sql` closed three holes, and it closed them by
 * REPAIRING THE STATE THE DATABASE WAS IN: a `do $$ … regexp_replace … $$` block that
 * rewrote 17 SECURITY DEFINER bodies, and a loop that revoked anon EXECUTE from the
 * definer functions that existed at that moment. Both are one-shot sweeps. Neither can
 * defend a function written afterwards, and the repo has no shortage of later migrations
 * that recreate one of those very functions from a pre-hardening body.
 *
 * It nearly happened the day after. R-014 and R-015 recreate `delete_project_invoice`,
 * `delete_subscription_invoice` and `raise_project_milestone_invoice` — three of the
 * seventeen — and `next_document_number`, and the first drafts carried the weak guard and
 * an `anon` grant straight back in.
 *
 * `supabase/tests/definer_rpc_hardening.test.sql` DOES catch the guard half (its FAIL 4 is
 * a repo-wide scan of `pg_get_functiondef`). It is not in CI, it needs a database, and it
 * had not been run in a while. This file is the cheap half that runs every time anybody
 * types `npm run test` — a source scan over the migration files, which needs nothing.
 *
 * It does NOT replace the SQL test: only that one can see what is actually installed on a
 * database. It catches the case that actually bit, which is a migration being written.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "supabase/migrations";
/** The migration that did the hardening. Anything after it inherits the rules. */
const HARDENING = "20260927100000";

const later = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql") && f.split("_")[0] > HARDENING)
  .sort();

/** Comments stripped — several of these files quote the old form in order to explain it (L46). */
const code = (f: string) =>
  readFileSync(`${DIR}/${f}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--.*$/gm, "");

describe("the hardening migration exists and says what it did", () => {
  it("is still in the tree", () => {
    const files = readdirSync(DIR).filter((f) => f.startsWith(HARDENING));
    expect(files).toHaveLength(1);
  });

  it("scanned enough later migrations for this file to mean something", () => {
    /* A scan that scanned nothing passes. `grid-flow-col-reset.test.ts` makes the same
       check for the same reason. */
    expect(later.length).toBeGreaterThan(10);
  });
});

describe("no later migration reintroduces the weak tenant guard", () => {
  /* The weak form is `if v_tenant is not null and …`, which is NO guard at all when
     v_tenant is NULL — the anon case, and the signed-in-but-no-users-row case. Quote and
     invoice ids are countable (Q-1111-2026-27-0001), so `reopen_quote` was reachable
     against any tenant without logging in.

     The hardened form keeps the same condition and adds the null case:
       if (v_tenant is null and coalesce(auth.role(), '') in ('anon','authenticated'))
          or (v_tenant is not null and <original condition>) then                        */
  it.each(later)("%s", (file) => {
    expect(code(file)).not.toMatch(/if v_tenant is not null and /);
  });
});

/**
 * Functions an RLS POLICY evaluates, which must stay callable by whoever runs the query.
 *
 * A policy runs as the querying role, so a policy helper that anon cannot execute breaks
 * the query rather than protecting anything. `20260927100000` exempts these deliberately
 * (it reads `pg_policy` and skips any function a policy names), and the rule below has to
 * exempt them too — a rule that fires on the right answer gets deleted within a week, and
 * then it is not there for the wrong one (AGENTS.md L103).
 *
 * An allow-list rather than a looser regex, on purpose: adding a name here is a visible,
 * reviewable act with a reason attached. Each entry says which policy needs it.
 */
const POLICY_HELPERS: Record<string, string> = {
  hierarchy_sees_all:
    "leads_hierarchy_select/write/delete in 20260928100000 — the reporting-tree policies",
  visible_owner_ids:
    "the same three policies — owner_id = any(visible_owner_ids())",
  is_demo_visitor:
    "R-524: the RESTRICTIVE 'demo visitor no insert/update/delete' policies on storage.objects (to public)",
};

/**
 * PostgREST's db_pre_request runs as the REQUEST's role — anon included — before every request,
 * so anon must be able to EXECUTE it or every logged-out request fails. Not a policy helper,
 * so the "named by a policy" check below does not apply; instead each must be the configured hook.
 */
const PRE_REQUEST_HOOKS: Record<string, string> = {
  demo_pre_request:
    "R-524: makes a 'Try the demo' visitor's request READ ONLY (20261009220000 / 20261009220100)",
};

describe("no later migration hands anon EXECUTE back", () => {
  /* `create or replace function` KEEPS a function's grants. `drop function` + `create`
     RESETS them to the PUBLIC default — which is how hole 3 regenerates, and it is the
     difference nobody would notice while writing the migration. */
  it.each(later)("%s", (file) => {
    const src = code(file);
    const grants = src.match(/grant\s+execute\s+on\s+function[\s\S]{0,300}?;/gi) ?? [];
    for (const g of grants) {
      if (!/\banon\b/.test(g)) continue;
      const exempt = [...Object.keys(POLICY_HELPERS), ...Object.keys(PRE_REQUEST_HOOKS)].find((fn) => g.includes(fn));
      expect(
        exempt,
        `${file} grants anon EXECUTE on a function that is not a known RLS policy ` +
          `helper:\n${g}\n` +
          "20260927100000 removed exactly this. If a logged-out flow genuinely needs it, " +
          "add it to POLICY_HELPERS with the policy that evaluates it, or say so on the " +
          "board (R-013) — do not re-grant quietly.",
      ).toBeDefined();
    }
  });

  it("every allow-listed pre-request hook is really wired as pgrst.db_pre_request", () => {
    const all = readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => code(f)).join("\n");
    for (const fn of Object.keys(PRE_REQUEST_HOOKS)) {
      expect(all.includes(`pgrst.db_pre_request to ''public.${fn}''`), `${fn} is allow-listed as a pre-request hook but nothing sets it`)
        .toBe(true);
    }
  });

  it("every allow-listed helper is still named by a policy in the tree", () => {
    /* An exemption whose reason has expired is worse than no exemption: it keeps a grant
       alive for a policy nobody has any more. Checked against the migration text rather
       than against a live database, so it runs with no Docker. */
    const all = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(`${DIR}/${f}`, "utf8"))
      .join("\n");
    for (const fn of Object.keys(POLICY_HELPERS)) {
      const policiesUsingIt = all
        .split(/create policy/i)
        .slice(1)
        .filter((block) => block.slice(0, 600).includes(fn));
      expect(policiesUsingIt.length, `${fn} is allow-listed but no policy names it`)
        .toBeGreaterThan(0);
    }
  });
});

describe("the document-number allocator specifically", () => {
  it("is dropped and recreated, so it must re-state its grants without anon", () => {
    /* Singled out because the consequence is the least reversible in the app: one anon
       call burns a number from the gapless CGST Rule 46 series, and a burned number is
       never reissued — it is a permanent hole an auditor asks about. */
    const f = later.find((x) => x.includes("document_number_ist_fy"));
    expect(f).toBeDefined();
    const src = code(f as string);
    expect(src).toMatch(/drop function if exists public\.next_document_number/);
    expect(src).toMatch(/revoke all on function public\.next_document_number[^;]*from public, anon;/);
    expect(src).toMatch(/grant execute on function public\.next_document_number[\s\S]{0,120}to authenticated, service_role;/);
  });
});
