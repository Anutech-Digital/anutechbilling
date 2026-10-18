#!/usr/bin/env node
/**
 * QA run — one command for Hitesh (and his scheduled routine):
 *
 *   node e2e/qa/run.mjs                 # all QA checks against STAGING (resellersos-staging)
 *   node e2e/qa/run.mjs --grep buy      # only matching tests (retest one area)
 *   QA_BASE_URL=http://localhost:3001 node e2e/qa/run.mjs   # local instead
 *   node e2e/qa/run.mjs --report-only   # rebuild the report from the last run, no browser
 *
 * Runs the Playwright specs in e2e/qa/, then writes (in the repo root):
 *   docs/qa/runs/<date>.md          pass/fail table + one ready-made bug card per failure
 *   docs/qa/runs/<date>.cards.json  the same cards as data, for the routine to post
 * Each card's owner is worked out from the failing URL via OWNERS.json, so a failure on
 * /buy/... goes to Pawan and one on /accounting/... to Pardeep without anyone deciding.
 *
 * Never points at production: only a resellersos-staging-… Cloud Run URL or localhost is accepted.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ownerOf } from "../../scripts/areas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const prod = join(here, "..", "..");
const root = join(prod, "..");
/* R-1604 (19 Oct 2026): the old "reselleros-test" app is retired; daily testing is on staging. */
const BASE = process.env.QA_BASE_URL || "https://resellersos-staging-njvk4nxhdq-as.a.run.app";
if (!/^https:\/\/resellersos-staging-[a-z0-9-]+\.a\.run\.app\/?$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(BASE)) {
  console.error(`Refusing to run QA against ${BASE}: only staging (resellersos-staging) or localhost.`);
  process.exit(2);
}

const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST date
const jsonOut = join(prod, "test-results", "qa-report.json");
mkdirSync(dirname(jsonOut), { recursive: true });

const reportOnly = process.argv.includes("--report-only"); // rebuild the .md from the last run
const args = ["playwright", "test", "e2e/qa", "--reporter=list,json", ...process.argv.slice(2).filter((x) => x !== "--report-only")];
const run = reportOnly ? { status: 0 } : spawnSync("npx", args, {
  cwd: prod, stdio: "inherit", shell: true,
  env: { ...process.env, PLAYWRIGHT_BASE_URL: BASE, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut },
});
if (!existsSync(jsonOut)) { console.error("Playwright wrote no report — see the output above."); process.exit(1); }
const report = JSON.parse(readFileSync(jsonOut, "utf8"));

/** URL path → owning area, via the route folder that serves it. */
function ownerOfUrl(path) {
  const seg = path.split("?")[0].split("/").filter(Boolean)[0];
  const app = join(prod, "src", "app");
  for (const group of readdirSync(app)) {
    const dir = seg ? join(app, group, seg) : join(app, group, "page.tsx");
    if (group.startsWith("(") && existsSync(dir)) {
      const o = ownerOf(relative(root, dir).replace(/\\/g, "/") + (seg ? "/" : ""));
      if (o !== "unowned" && o !== "shared") return o;
    }
  }
  return "sab";
}

const rows = [], fails = [];
const strip = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
function walk(suite, trail = []) {
  for (const s of suite.suites || []) walk(s, s.title && !s.title.endsWith(".ts") ? [...trail, s.title] : trail);
  for (const spec of suite.specs || []) for (const t of spec.tests || []) {
    const r = t.results?.[t.results.length - 1] || {};
    const status = t.status === "expected" ? "pass" : t.status === "skipped" ? "skip" : t.status === "flaky" ? "flaky" : "FAIL";
    rows.push({ title: spec.title, project: t.projectName, status, file: spec.file });
    if (status !== "FAIL") continue;
    const err = strip(r.error?.message || r.errors?.[0]?.message || "").split("\n").filter(Boolean).slice(0, 6).join("\n");
    const url = (/Open (\/[^\s"\\]*)/.exec(JSON.stringify(r.steps || [])) || [])[1] || (spec.title.match(/(\/[\w\-/]*)/) || [])[1] || "/";
    const steps = (r.steps || []).map((s) => s.title).filter((x) => !/^(Before|After) Hooks$/.test(x));
    const shot = (r.attachments || []).find((a) => a.name === "screenshot")?.path;
    fails.push({
      path: url.split("?")[0], title: spec.title, device: t.projectName === "mobile-chrome" ? "phone" : "desktop",
      steps, err, screenshot: shot ? relative(root, shot).replace(/\\/g, "/") : null,
    });
  }
}
walk(report);

/* One card per page, not per check: when a page does not open, every calculator check on
   it fails for the same reason, and fourteen cards would bury the one that matters. */
const cards = [];
for (const path of [...new Set(fails.map((f) => f.path))]) {
  const here_ = fails.filter((f) => f.path === path);
  const checks = [...new Set(here_.map((f) => f.title))];
  const devices = [...new Set(here_.map((f) => f.device))].join(" + ");
  const noOpen = here_.every((f) => /page\.goto|Test timeout|milliseconds to open/.test(f.err));
  cards.push({
    key: `${path} · ${noOpen ? "does-not-open" : checks.join(" | ")}`,
    title: noOpen
      ? `Bug: ${path} bahut der mein khulta hai / nahi khulta (${devices})`
      : `Bug: ${path} — ${checks[0]}${checks.length > 1 ? ` (+${checks.length - 1} aur)` : ""} fail (${devices})`,
    owner: ownerOfUrl(path), url: BASE + path, steps: here_[0].steps, expected: checks.join("; "),
    actual: here_[0].err, screenshot: here_[0].screenshot, failing_checks: checks,
    priority: /buy|checkout|cart|login|signup/.test(path) || checks.some((c) => /price|total|GST/i.test(c)) ? "p1" : "p2",
  });
}

const n = (s) => rows.filter((r) => r.status === s).length;
const md = [
  `# QA run ${day}`, "",
  `Base: ${BASE} · ${rows.length} checks · **${n("pass")} pass · ${n("FAIL")} fail** · ${n("flaky")} flaky · ${n("skip")} skipped`,
  "", "| result | check | device |", "|---|---|---|",
  ...rows.map((r) => `| ${r.status === "FAIL" ? "❌" : r.status === "pass" ? "✅" : r.status} | ${r.title} | ${r.project} |`),
  "", cards.length ? "## Bug cards (ready to post)" : "## Koi naya bug nahi", "",
  ...cards.flatMap((c) => [
    `### ${c.title}`, `- **Kiska:** ${c.owner} · **Priority:** ${c.priority.toUpperCase()}`, `- **Kahan:** ${c.url}`,
    `- **Steps:** ${c.steps.map((s, i) => `${i + 1}) ${s}`).join("  ")}`, `- **Expected:** ${c.expected}`,
    "- **Actual:**", "```", c.actual || "(no message)", "```", c.screenshot ? `- **Screenshot:** \`${c.screenshot}\`` : "", "",
  ]),
].join("\n");
const outDir = join(root, "docs", "qa", "runs");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${day}.md`), md);
writeFileSync(join(outDir, `${day}.cards.json`), JSON.stringify({ day, base: BASE, cards }, null, 2));
console.log(`\nQA: ${n("pass")} pass, ${n("FAIL")} fail → docs/qa/runs/${day}.md`);
process.exit(run.status ?? 1);
