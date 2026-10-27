/*
 * Related SQL tests before a push (R-1936; moved out of worker-lock.mjs and made honest by R-1955, 26 Oct 2026).
 *
 * When a push changes supabase/migrations/*.sql, the SQL tests that mention a function/table/view those
 * migrations create run on the LOCAL DB: migration + test in ONE rolled-back transaction. A red test is
 * compared with the same test WITHOUT the card's migrations, to tell this push's breakage from old local
 * breakage (leftover rows, a missing older migration):
 *   red with, green without the pending migrations → this push broke it → block (exit 5)
 *   red with AND without                           → old local breakage → warn only (CI decides)
 *
 * R-1955: "red without" is only a proof when NONE of the card's migrations is already on the local DB
 * (its `-- deploy-peek:` is true there). An applied migration cannot be taken out inside the transaction
 * (undoing its tables, columns, data and grants in general cannot be done safely by guessing), so
 * "without the migration" would still include it. Choice: such a red test is NOT PROVEN — never called
 * old breakage (a proof we did not make) and never called this push's fault. It blocks (exit 5) and the
 * message gives the two ways on: (1) a local DB without the card's migration (`npx supabase db reset`
 * from a worktree on anutech/manager-pardeep — wipes local data, ask Pardeep first), then
 * `worker-lock sql-related <CARD>` again; or (2) Pardeep's OK → push with `--skip-related-sql`
 * (logged). Every not-proven result is also written to the lock folder's _ci-gate.log, so the gap is
 * never silent. Tests: tests/worker-lock-sql.test.ts (fake psql).
 */

/** Functions / tables / views a migration creates or replaces (lower case, no schema). */
export function migrationDefines(sql) {
  const names = new Set();
  const src = String(sql ?? "").replace(/--[^\n]*/g, "");
  const id = String.raw`(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?`;
  const res = [
    new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+${id}`, "gi"),
    new RegExp(String.raw`create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${id}`, "gi"),
    new RegExp(String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${id}`, "gi"),
  ];
  for (const re of res) for (const m of src.matchAll(re)) names.add(m[1].toLowerCase());
  return [...names];
}

/** The test files (of [{file, src}]) that mention any of the names as a whole word. */
export function relatedSqlTests(names, tests) {
  if (!names.length) return [];
  const res = names.map((n) => new RegExp(String.raw`(^|[^a-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`, "i"));
  return tests.filter((t) => res.some((re) => re.test(t.src))).map((t) => ({ ...t, hits: names.filter((n, i) => res[i].test(t.src)) }));
}

/** First-line `-- deploy-peek: <SQL boolean>` of a migration, or null. */
export function deployPeek(sql) {
  const m = /^\s*--\s*deploy-peek:\s*(.+)$/m.exec(String(sql ?? "").split("\n").slice(0, 3).join("\n"));
  return m ? m[1].trim() : null;
}

/** Same safety rule as scripts/test-sql.mjs: ends in rollback, never commits. */
export function sqlTestSafe(src) {
  return /^\s*rollback\s*;/im.test(src) && !/^\s*commit\s*;/im.test(src);
}

/** One script: begin; the not-yet-applied migrations (their own begin;/commit; lines dropped); the test (ends in rollback). */
export function relatedTestScript(pendingMigrations, testSrc) {
  const mig = pendingMigrations.map((m) => `-- migration ${m.file}\n` + m.src.replace(/^\s*(begin|commit)\s*;\s*$/gim, "-- ($1 dropped: one rolled-back transaction)")).join("\n\n");
  return `begin;\n${mig}\n\n${testSrc}\n`;
}

/** What to do when a red test could not be compared (R-1955). */
export function notProvenHelp(appliedNames) {
  return `\n   Kyun: migration (${appliedNames}) local DB par pehle se lagi hai; use transaction me hataya nahi ja sakta, isliye "migration ke bina" wala compare nahi ho saka.` +
    "\n   Aage do raaste: (1) local DB ko base par lao — anutech/manager-pardeep wale worktree se `npx supabase db reset` (local data mit jaata hai — pehle Pardeep se poochho), phir is worktree se `worker-lock sql-related <CARD>` dobara;" +
    "\n   (2) Pardeep ka OK ho to `push <CARD> ... --skip-related-sql` (_ci-gate.log me likha jaata hai; card ke liveLog me bhi likho). CI ka \"SQL tests\" phir bhi chalega.";
}

/**
 * Run the SQL tests related to the changed migrations on the LOCAL DB. deps:
 *   changed: [{file, src}] migrations this push adds/changes; tests: [{file, src}] supabase/tests/*.sql;
 *   psql(sql) => {status, out} (null when no local DB).
 * Returns { ok, skipped?, ran: [{file, ok, why?, localRed?, notProven?}], applied: [file], notProven: [file], message }.
 */
export function runRelatedSql({ changed, tests, psql }) {
  if (!changed.length) return { ok: true, skipped: true, ran: [], message: "(koi migration nahi badli — related SQL tests nahi)" };
  const names = [...new Set(changed.flatMap((m) => migrationDefines(m.src)))];
  const related = relatedSqlTests(names, tests);
  if (!related.length) return { ok: true, skipped: true, ran: [], message: `(badli migrations [${names.join(", ") || "kuch nahi banaya"}] ka koi SQL test nahi mila)` };
  if (!psql) return { ok: true, skipped: true, ran: [], message: `⚠ local DB nahi chal raha — ${related.length} related SQL test chhode (${related.map((t) => t.file).join(", ")}). CI ka "SQL tests" dekhna.` };
  if (changed.some((m) => /\bconcurrently\b/i.test(m.src.replace(/--[^\n]*/g, "")))) {
    return { ok: true, skipped: true, ran: [], message: "⚠ migration me CONCURRENTLY hai (transaction me nahi chalta) — related SQL tests chhode; CI dekhna." };
  }
  /* A migration whose deploy-peek is already true on the local DB is applied — run the test on top of it. */
  const pending = [];
  const applied = [];
  for (const m of changed) {
    const peek = deployPeek(m.src);
    let isApplied = false;
    if (peek) { const r = psql(`select case when (${peek}) then 'PEEK_APPLIED' else 'PEEK_PENDING' end;`); isApplied = r.status === 0 && /PEEK_APPLIED/.test(r.out); }
    (isApplied ? applied : pending).push(m);
  }
  const ran = [];
  for (const t of related) {
    if (!sqlTestSafe(t.src)) { ran.push({ file: t.file, ok: false, why: "rollback se khatam nahi hoti / commit karti hai (CI ka runner bhi mana karega)" }); continue; }
    const r = psql(relatedTestScript(pending, t.src));
    if (r.status === 0) { ran.push({ file: t.file, ok: true }); continue; }
    const why = (String(r.out).match(/ERROR:[^\n]{0,300}/g) ?? [String(r.out).slice(-300)]).slice(0, 3).join(" | ");
    /* Green once the pending migrations are left out = they broke it: a proven red, whatever else is applied. */
    const redWithout = pending.length ? psql(relatedTestScript([], t.src)).status !== 0 : null;
    if (redWithout === false) { ran.push({ file: t.file, ok: false, why }); continue; }
    /* Red without the card's migrations too = old local breakage — a proof ONLY when none of them is on the local DB (R-1955). */
    if (!applied.length) { ran.push({ file: t.file, ok: true, localRed: true, why }); continue; }
    ran.push({ file: t.file, ok: false, notProven: true, why });
  }
  const bad = ran.filter((x) => !x.ok && !x.notProven);
  const notProven = ran.filter((x) => x.notProven);
  const localRed = ran.filter((x) => x.localRed);
  const green = ran.length - bad.length - notProven.length - localRed.length;
  const appliedNames = applied.map((m) => m.file).join(", ");
  const head = `related SQL tests (${names.join(", ")}): ${green}/${ran.length} hare` + (pending.length ? `, ${pending.length} nayi migration ke saath (rollback)` : "") +
    (applied.length ? `; ${applied.length} migration local DB par pehle se lagi (${appliedNames}) — test usi par chala, "migration ke bina" compare nahi` : "");
  return {
    ok: !bad.length && !notProven.length, ran, applied: applied.map((m) => m.file), notProven: notProven.map((x) => x.file),
    message: (bad.length || notProven.length ? "✗ " : "✓ ") + head +
      localRed.map((b) => `\n   ⚠ ${b.file}: migration ke bina bhi local DB par laal (local DB ki purani gadbad, is push ki nahi) — ${b.why}`).join("") +
      bad.map((b) => `\n   ✗ ${b.file}: ${b.why}`).join("") +
      notProven.map((b) => `\n   ? ${b.file}: laal — PROOF NAHI BANA (purani gadbad hai ya is push ki, pata nahi) — ${b.why}`).join("") +
      (notProven.length ? notProvenHelp(appliedNames) : ""),
  };
}
