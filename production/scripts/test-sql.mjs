#!/usr/bin/env node
/**
 * supabase/tests/ ke saare SQL regression test ek saath chalao.
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * Ye test paise wale raaste ki hifazat karte hain — `record_payment` ka idempotency,
 * issued invoice ka immutable hona, invoice delete par serial dobara na milna, aur paanch
 * alag tenant-isolation. CLAUDE.md §25.2 khud kehta hai ki ye "not in CI and not in the
 * hook" hain, yaani inhe chalane ka ek hi tarika tha: koi haath se yaad rakhe.
 *
 * 29 Aug 2026: koi npm script tha hi nahi. Yaani inhe ek saath kabhi chalaya hi nahi gaya.
 *
 * ─── DEFAULT LOCAL DB (R-2493, 5 Nov 2026) ─────────────────────────────────
 * Bina flag ke ye LOCAL docker DB par chalti hai. Pehle default linked project (staging) tha —
 * 5 Nov ek worker ne `--local` bhoola aur ye staging par chal padi. Remote ab sirf
 * `--remote <ref>` AUR TEST_SQL_REMOTE_OK=<wahi ref> se, CI me kabhi nahi; pehli line hamesha
 * `target: …`. Niyam: scripts/dev/sql-test-target.mjs; test: tests/test-sql-target.test.ts.
 *
 * ─── HAR FILE ROLLBACK KARTI HAI ────────────────────────────────────────────
 * Har file `begin; … rollback;` me lipti hai, aur Postgres me DDL bhi transactional hai.
 * Chalane se pehle ye script khud jaanchti hai ki har file me `rollback` hai aur `commit`
 * NAHI hai — ek bhi file is shart par fail hui to kuch bhi nahi chalta.
 *
 * ─── EXIT 0 KA MATLAB ───────────────────────────────────────────────────────
 * Ye file `raise exception` se fail hoti hai aur exit 1 deti hai (24 Aug ko naapa). Par
 * exit 0 wo bhi deti hai jo chup-chaap kuch na kare. Isliye har run ke saath ek CANARY
 * chalta hai — ek file jo hamesha fail honi chahiye. Canary hara ho gaya to poori report
 * bekaar hai, aur script khud fail ho jaati hai.
 */
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveSqlTestTarget, describeSqlTestTarget, readLinkedRef, linkedRefReason } from "./dev/sql-test-target.mjs";

/* ── 0. Kahan chalega — sabse pehle, kuch bhi jodne se pehle (R-2493) ── */
const resolved = resolveSqlTestTarget(process.argv.slice(2), process.env);
console.log(describeSqlTestTarget(resolved.target));
const refuse = (why) => { console.error(`RUKA — ${why}`); process.exit(2); };
if (resolved.reason) refuse(resolved.reason);
if (resolved.target.kind === "remote") {
  const why = linkedRefReason(resolved.target.ref, readLinkedRef(process.cwd()));
  if (why) refuse(why);
}
const only = resolved.only;

const DIR = "supabase/tests";

/* ── 1. Surakshit hai ya nahi — kuch chalane se pehle ── */
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const unsafe = files.filter((f) => {
  const s = readFileSync(join(DIR, f), "utf8");
  return !/^\s*rollback\s*;/im.test(s) || /^\s*commit\s*;/im.test(s);
});
if (unsafe.length) {
  console.error("RUKA — ye file production par rollback nahi karti:\n  " + unsafe.join("\n  "));
  process.exit(2);
}

/* ── 2. Canary — harness sach me fail hota hai? ── */
const tmp = mkdtempSync(join(tmpdir(), "sqlcanary-"));
const canary = join(tmp, "canary.sql");
writeFileSync(canary, "begin;\n  do $$ begin raise exception 'CANARY'; end $$;\nrollback;\n");

const TRANSIENT = /TransportError|LegacyDbConfigLoginRole|ECONNRESET|fetch failed/i;

/* ── Target (R-2493; pehle --local 23 Sep, --db-url S18 28 Sep) ───────────────
 * local — default, aur `--local` (CI ka `npm run test:sql:local`, apna throwaway stack):
 *   docker ke supabase_db_* container me psql.
 * `--db-url=postgres://…@127.0.0.1:54322/postgres` — psql seedha, bina docker exec; sirf
 *   local host (scripts/dev/local-guard.mjs), taaki ye kabhi remote ka chor-darwaza na bane.
 * `--remote <ref>` — linked project; upar ref + TEST_SQL_REMOTE_OK + link teeno jaanch chuke. */
const LOCAL = resolved.target.kind === "local";
const DB_URL = resolved.target.kind === "db-url" ? resolved.target.url : null;
if (DB_URL && spawnSync("psql", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error("--db-url ke liye `psql` PATH par chahiye.");
  process.exit(2);
}
let CONTAINER = null;
if (LOCAL) {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  CONTAINER = (ps.stdout ?? "")
    .split(/[\r\n]+/)
    .map((x) => x.trim())
    .find((n) => /^supabase_db_/.test(n));
  if (!CONTAINER) {
    console.error("Local Supabase chalu hona chahiye (supabase_db_* container nahi mila) — `npx supabase start`. Remote par apne aap kabhi nahi jaata.");
    process.exit(2);
  }
}

/* ── Teen khane, do nahi ───────────────────────────────────────────────────
 *
 * `NOT APPLICABLE HERE:` ka matlab hai file ka vishay is database par hai hi nahi.
 * `sandbox_tenant_isolation` do ASLI tenant naapta hai — sandbox aur live — kyunki
 * sawal hi yahi hai ki production par baitha tester live kitaabon tak pahunch sakta
 * hai ya nahi. Jis database par wo do nahi hain, wahan kuch NAAPA HI NAHI GAYA. Use
 * FAIL ginna utna hi jhootha hai jitna PASS ginna.
 *
 * (Pehle yahan ek teesra khana bhi tha, report-style `TESTRESULT` file ke liye, is
 *  bharose par ki wo pass hone par non-zero deti hain. Naapa: teeno exit 0 deti hain.
 *  Wo `raise` failure branch par hai, aur mera grep file ke HEADER me us purani shakl
 *  ke hataye jaane ka zikr pakad raha tha — L46 wahi baat kehta hai, comment ko code
 *  samajh lena. Khana hata diya gaya.) */
const isSkippable = (src) => /NOT APPLICABLE HERE/.test(src);
const classify = (r) => (r.ok ? "ok" : /NOT APPLICABLE HERE/.test(r.out) ? "skip" : "fail");

function runOne(path) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = DB_URL
      ? spawnSync("psql", ["-v", "ON_ERROR_STOP=1", DB_URL],
          { input: readFileSync(path, "utf8"), encoding: "utf8", timeout: 120_000 })
      : LOCAL
      ? spawnSync(
          "docker",
          ["exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
          /* ON_ERROR_STOP ke bina psql galti dikhata hai aur exit 0 deta hai — yaani
             har laal test hara padha jaata. */
          { input: readFileSync(path, "utf8"), encoding: "utf8", timeout: 120_000 },
        )
      : /* sirf target "remote" — jo upar do baar maanga aur link se mila hua hai (R-2493) */
        /* --project-ref: the CLI runs on exactly the ref that was checked, never on whatever
           SUPABASE_PROJECT_ID / a parent workdir would pick (code-review, R-2493). */
        spawnSync("npx", ["supabase", "db", "query", "--linked", "--project-ref", resolved.target.ref, "-f", path], {
          encoding: "utf8", shell: true, timeout: 120_000,
        });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    /* Windows par process khatam ho jaane ka apna code hai — use "test fail" batana
       poori report ko jhootha bana dega. (backup:db isi par do baar mara tha.) */
    if (r.status === 3221225794) return { ok: false, out, fatal: "process launch (0xC0000142)" };
    /* CLI ki login-role step kabhi-kabhi network par mar jaati hai aur agli koshish me
       chal jaati hai — use bug samajh kar reh jana ek poora session kha sakta hai. */
    if (r.status !== 0 && TRANSIENT.test(out) && attempt === 1) continue;
    return { ok: r.status === 0, out };
  }
  return { ok: false, out: "" };
}

const c = runOne(canary);
if (c.ok) {
  console.error("RUKA — canary HARA hai. `raise exception` wali file bhi pass ho rahi hai,");
  console.error("       yaani neeche ka har green jhooth hota. Harness theek karo pehle.");
  process.exit(3);
}
console.log("canary laal — harness sach me fail hota hai. ab asli test.\n");

/* ── 3. Asli test ── */
const list = only ? files.filter((f) => f.includes(only)) : files;

/* Bundle me sirf wo file ja sakti hai jo pass hone par exit 0 de. "NOT APPLICABLE
   HERE" wali file exception phenkti hai, to bundle me daalne se poora bundle toot
   jaata aur baaki 53 bewajah ek-ek karke dobara chaltin. Wo alag chalti hai. */
const srcOf = (f) => readFileSync(join(DIR, f), "utf8");
const special = list.filter((f) => isSkippable(srcOf(f)));
const bundleable = list.filter((f) => !special.includes(f));
if (!list.length) { console.error(`koi test "${only}" se mel nahi khata`); process.exit(2); }

const nameOf = (f) => f.replace(/\.test\.sql$|\.sql$/, "");
const t0 = Date.now();

/* ── EK HI CALL, jab tak sab hara hai ──────────────────────────────────────
 *
 * 29 Aug 2026 par naapa: `select 1` bhi **4.5 second** leta hai. Poora waqt CLI ke shuru
 * hone aur login-role ke handshake me jaata hai — SQL me nahi. Yaani 43 alag call ka 3+
 * minute lagbhag poora intezaar tha, kaam nahi.
 *
 * Pehle process SAMANANTAR chalane ki koshish ki. Wo **dheemi** nikli — 220s se 281s — aur
 * 6 test aapas ki takkar se laal ho gaye. Wo raasta chhod diya gaya, aur ye tippani isliye
 * hai ki koi use dobara na aazmaye.
 *
 * Sab kuch ek file me jod kar EK call: **8 second**. Har test apne `begin; … rollback;` me
 * lipta hai, isliye jodne se koi haalat ek se doosre me nahi behti.
 *
 * ── AUR YE KAISE PATA KI SAB CHALE ──
 * Ek call me CLI sirf AAKHRI statement ka nateeja dikhata hai, to 43 "PASS" line dikhti hi
 * nahi. Isliye sabse aakhir me ek MARKER lagta hai. Marker output me hai = script poori
 * chali. Marker nahi hai = beech me kahin ruk gayi, chahe exit code kuch bhi kahe — aur us
 * soorat me ye ek-ek karke dobara chalta hai, taaki naam pata chale.
 *
 * Yaani tez raasta sirf tab, jab sab hara ho. Kuch laal hua to poori keemat lagti hai —
 * aur us waqt keemat maayne nahi rakhti, naam maayne rakhta hai. */
const MARKER = "SQL_SUITE_REACHED_THE_END";
const bundle = join(tmp, "bundle.sql");
writeFileSync(
  bundle,
  bundleable.map((f) => readFileSync(join(DIR, f), "utf8")).join("\n\n") +
    `\n\nselect '${MARKER}' as marker;\n`,
);

const fast = runOne(bundle);
const reachedEnd = fast.out.includes(MARKER);

const failed = [];
if (fast.ok && reachedEnd) {
  for (const f of bundleable) console.log(` ok   ${nameOf(f)}`);
} else {
  console.log(
    fast.ok
      ? " ek-saath wala run beech me ruk gaya (marker nahi mila) — ab ek-ek karke\n"
      : " ek-saath wale run me kuch laal hai — ab ek-ek karke, taaki naam pata chale\n",
  );
  let n = 0;
  for (const f of bundleable) {
    n++;
    const r = runOne(join(DIR, f));
    if (r.fatal) {
      console.error(`\n RUKA — ${nameOf(f)}: ${r.fatal}`);
      console.error(" Ye test ka fail nahi hai. Machine par process khatam ho gaye — dobara chalao.");
      process.exit(4);
    }
    console.log(`${r.ok ? " ok  " : " FAIL"} [${n}/${bundleable.length}] ${nameOf(f)}`);
    if (!r.ok) failed.push({ name: nameOf(f), out: r.out });
  }
  if (failed.length === 0) {
    /* Ek saath laal, akele sab hare. Iska matlab test aapas me takra rahe hain — aur wo ek
       asli baat hai, chhupane wali nahi. */
    console.log("\n ⚠️  ek saath laal, akele sab hare — test aapas me takra rahe hain");
  }
}
/* Alag chalne wali file. */
const skipped = [];
for (const f of special) {
  const r = runOne(join(DIR, f));
  const v = classify(r);
  if (v === "skip") { skipped.push(nameOf(f)); console.log(` skip ${nameOf(f)} - is database par laagu nahi`); }
  else if (v === "ok") { console.log(` ok   ${nameOf(f)}`); }
  else { failed.push({ name: nameOf(f), out: r.out }); console.log(` FAIL ${nameOf(f)}`); }
}

console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s`);

/* ── 4. Nateeja ── */
console.log(`\n${list.length - failed.length - skipped.length}/${list.length} pass  ${skipped.length} not-applicable  ${failed.length} FAIL`);
for (const f of failed) {
  console.log(`\n───── ${f.name}`);
  const why = f.out.match(/ERROR:[^\\"]{0,400}/g);
  console.log((why ? why.join("\n") : f.out.slice(0, 600)).trim());
}
process.exit(failed.length ? 1 : 0);
