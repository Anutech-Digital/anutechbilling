import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { checkScope, enforceScope, parseScopeFlags, claimedAreas, scopePath, parseNameStatus, parseLogPatches, removedLines, testNextToClaim, isGenerated, SCOPE_EXIT } from "../scripts/ops/worker-lock-guards.mjs";

/**
 * R-1958: worker-lock refuses a commit/push that undoes other cards' work. A fake git answers the
 * few commands checkScope runs; every rule must refuse, a normal card must pass, generated files pass.
 */
type Change = [status: string, file: string];
type Hist = { sha: string; subject: string; added: string[]; removed?: string[]; before?: string; after?: string };
type Scenario = { changes: Change[]; merges?: boolean; history?: Record<string, Hist[]>; removed?: Record<string, string[]>; readded?: Record<string, string[]>; now?: Record<string, string>; addedBy?: Record<string, string> };

function fakeGit(sc: Scenario) {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    const [cmd] = args;
    const file = args.includes("--") ? args[args.indexOf("--") + 1] : "";
    if (cmd === "merge-base") return "BASE\n";
    if (cmd === "rev-list") return sc.merges ? "m1\n" : "";
    if (cmd === "diff" && args.includes("--name-status")) return sc.changes.map(([s, f]) => `${s}\0${f}\0`).join("");
    if (cmd === "diff") return [...(sc.removed?.[file] ?? []).map((l) => `-${l}`), ...(sc.readded?.[file] ?? []).map((l) => `+${l}`)].join("\n") + "\n";
    if (cmd === "log" && args.includes("--diff-filter=A")) return (sc.addedBy?.[file] ?? "") + "\n";
    if (cmd === "log") {
      return (sc.history?.[file] ?? []).map((h) => `\x1e${h.sha}\t${h.subject}\n\ndiff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` + [...(h.removed ?? []).map((l) => `-${l}`), ...h.added.map((l) => `+${l}`)].join("\n") + "\n").join("");
    }
    if (cmd === "rev-parse" || cmd === "hash-object") {
      const spec = cmd === "hash-object" ? `HEAD:${file}` : args[1];
      const [rev, f] = spec.split(/:(.*)/s);
      if (rev === "HEAD") return (sc.now?.[f] ?? "blob-now") + "\n";
      const h = (sc.history?.[f] ?? []).find((x) => `${x.sha}^` === rev);
      if (h?.before) return h.before + "\n";
      const a = (sc.history?.[f] ?? []).find((x) => x.sha === rev);
      if (a?.after) return a.after + "\n";
      throw new Error("no such path");
    }
    throw new Error("unexpected git " + args.join(" "));
  };
  return { git, calls };
}

const AREAS = ["src/lib/deals", "scripts/ops/worker-lock.mjs"];
const run = (sc: Scenario, extra: Record<string, unknown> = {}) => checkScope("R-1958", { git: fakeGit(sc).git, areas: AREAS, ...extra });

describe("R-1958 scope guard — a change must not undo other cards' work", () => {
  it("a normal card (only its own claimed files, a new migration, a new test) passes", () => {
    const r = run({ changes: [["M", "production/src/lib/deals/deal-rules.ts"], ["A", "production/supabase/migrations/20261026031500_r1958.sql"], ["A", "production/tests/deal-rules-new.test.ts"], ["M", "production/scripts/ops/worker-lock.mjs"]] });
    expect(r.ok).toBe(true);
    expect(r.refused).toEqual([]);
    expect(r.message).toMatch(/✓ R-1958/);
  });

  it("rule 1: an existing file OUTSIDE the claim, modified or deleted, is refused with its name", () => {
    const r = run({ changes: [["M", "production/src/lib/deals/x.ts"], ["M", "production/src/lib/billing/invoice-math.ts"], ["D", "production/src/app/(app)/quotes/page.tsx"]] });
    expect(r.ok).toBe(false);
    expect(r.refused.map((x: { rule: string; file: string }) => [x.rule, scopePath(x.file)])).toEqual([
      ["area", "src/lib/billing/invoice-math.ts"],
      ["area", "src/app/(app)/quotes/page.tsx"],
    ]);
    expect(r.message).toMatch(/exit 9/);
    expect(r.message).toMatch(/src\/lib\/billing\/invoice-math\.ts \(M\)/);
    expect(r.message).toMatch(/--allow-outside/);
  });

  it("rule 1: generated files and tests next to claimed code are allowed", () => {
    const r = run({ changes: [
      ["M", "production/supabase/cloudsql/staging/deploy-db-2026-10-07.sh"],
      ["M", "production/supabase/cloudsql/live/deploy-db-2026-10-07.sh"],
      ["M", "production/src/server/migrations-health/peeks.generated.ts"],
      ["M", "production/src/lib/supabase/database.generated.ts"],
      ["M", "docs/API.md"],
      ["M", "production/tests/worker-lock.test.ts"],
      ["M", "production/tests/deals-pipeline.test.ts"],
    ] });
    expect(r.refused).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rule 1: an unrelated existing test outside the claim is refused; a NEW non-test file only warns", () => {
    const r = run({ changes: [["M", "production/tests/invoice-math.test.ts"], ["A", "production/src/lib/other/new-helper.ts"]] });
    expect(r.refused.map((x: { file: string }) => scopePath(x.file))).toEqual(["tests/invoice-math.test.ts"]);
    expect(r.warnings.join("\n")).toMatch(/naya file claim ke bahar: src\/lib\/other\/new-helper\.ts/);
  });

  it("rule 2: an existing migration modified, deleted or renamed is refused — even inside the claim", () => {
    const r = checkScope("R-1958", { git: fakeGit({ changes: [
      ["M", "production/supabase/migrations/20261020000000_old.sql"],
      ["D", "production/supabase/migrations/20261021000000_older.sql"],
      ["D", "production/prisma/migrations/20261001_init/migration.sql"],
    ] }).git, areas: ["supabase/migrations/20261020000000_old.sql"] });
    expect(r.ok).toBe(false);
    expect(r.refused.map((x: { rule: string }) => x.rule)).toEqual(["migration", "migration", "migration"]);
    const ownMig = "production/supabase/migrations/20261025000000_r1958.sql";
    const own = checkScope("R-1958", { git: fakeGit({ changes: [["M", ownMig]], addedBy: { [ownMig]: "R-1958: first push" } }).git, areas: [] });
    expect(own.ok).toBe(true);
    expect(own.warnings.join("\n")).toMatch(/isi card ki pichhli push wali migration/);
    expect(parseNameStatus("R100\0production/supabase/migrations/a.sql\0production/supabase/migrations/b.sql\0")).toEqual([
      { status: "D", file: "production/supabase/migrations/a.sql" }, { status: "A", file: "production/supabase/migrations/b.sql" },
    ]);
  });

  it("rule 3: a file back to the exact version from before another card's recent commit is refused (git reset --soft case)", () => {
    const f = "production/src/lib/deals/deal-rules.ts";
    const r = run({ changes: [["M", f]], now: { [f]: "blob-old" }, history: { [f]: [{ sha: "aaaa1111bbbb", subject: "R-1915: vendor bill keeps tds", added: ["const tds = computeTds(bill);"], before: "blob-old" }] } });
    expect(r.ok).toBe(false);
    expect(r.refused[0].rule).toBe("revert");
    expect(r.refused[0].why).toMatch(/R-1915 commit aaaa1111/);
  });

  it("rule 3: deleting another card's recent lines AND bringing back what it removed is refused", () => {
    const f = "production/src/lib/deals/deal-rules.ts";
    const added = ["const a = applyRounding(total);", "if (isSplitBilled(sub)) return null;", "return quoteFor(periodStart, periodEnd);", "logRenewal(sub.id, period);"];
    const old = ["return quoteFor(start, start + 365);"];
    const r = run({ changes: [["M", f]], history: { [f]: [{ sha: "cccc2222dddd", subject: "R-1952: split billing", added, removed: old, before: "blob-x" }] }, removed: { [f]: added.slice(0, 3) }, readded: { [f]: old } });
    expect(r.ok).toBe(false);
    expect(r.refused[0].why).toMatch(/R-1952 commit cccc2222.*3\/4 nayi lines hata di, aur uski hatayi 1 purani lines wapas/);
    /* a commit that only ADDED lines (e.g. a new component): deleting 80%+ of them is a revert */
    const pure = run({ changes: [["D", f]], history: { [f]: [{ sha: "eeee", subject: "R-1899: statement row", added }] }, removed: { [f]: added } });
    expect(pure.refused[0].why).toMatch(/R-1899 commit eeee.*4\/4 nayi lines/);
  });

  it("rule 3: a refactor of another card's recent lines (its old lines NOT brought back) passes — the real R-1952-over-R-1915 shape", () => {
    const f = "production/src/lib/deals/deal-rules.ts";
    const added = ["const toPay = expenseStillOwed(expense);", "const paidPart = expense.paid_amount ?? 0;", "{(expense.advance_applied ?? 0) > 0 || paidPart > 0", "? ` (bill ${rupee(expense.amount)})`"];
    const r = run({ changes: [["M", f]], history: { [f]: [{ sha: "1a77e72a", subject: "WIP R-1915: screens", added, removed: ["const toPay = expense.amount;"] }] }, removed: { [f]: added }, readded: { [f]: ["const toPay = expenseCashDue(expense);"] } });
    expect(r.ok).toBe(true);
  });

  it("rule 3: editing a couple of another card's lines, or my own card's lines, is not a revert", () => {
    const f = "production/src/lib/deals/deal-rules.ts";
    const added = ["const a = applyRounding(total);", "if (isSplitBilled(sub)) return null;", "return quoteFor(periodStart, periodEnd);", "logRenewal(sub.id, period);", "const b = 1 + something;"];
    const two = run({ changes: [["M", f]], history: { [f]: [{ sha: "c1", subject: "R-1952: x", added, before: "blob-x" }] }, removed: { [f]: added.slice(0, 2) } });
    expect(two.ok).toBe(true);
    const own = run({ changes: [["M", f]], now: { [f]: "blob-old" }, history: { [f]: [{ sha: "c2", subject: "WIP R-1958: first try", added, before: "blob-old" }] }, removed: { [f]: added } });
    expect(own.ok).toBe(true);
  });

  /*
   * R-1964 — the real R-1962 shape (blob hashes from the repo, 26 Oct): R-1899 (ea82e098) changed
   * bs-lines.tsx 295ebb52 → 407eaf0e; c0159d00 (R-1905) put it back to 295ebb52; R-1962 brought 407eaf0e back.
   */
  const RF = "production/src/app/(app)/accounting/balance-sheet/bs-lines.tsx";
  const X_ADDED = ["<StatementRow href={drillHref(line)} amount={line.amount}>", "const rowLabel = line.label ?? line.code;", "<StatementRow.Cell>{rowLabel}</StatementRow.Cell>"];
  const X_REMOVED = ["<tr className=\"hover:bg-muted\" onClick={() => go(line)}>", "<td>{line.label}</td>"];
  const X = { sha: "ea82e098aa", subject: "R-1899: whole statement row highlights on hover and keyboard focus", added: X_ADDED, removed: X_REMOVED, before: "295ebb52", after: "407eaf0e" };
  const Y = { sha: "c0159d00bb", subject: "R-1905: each bank field says what is wrong with it; UPI ID optional", added: X_REMOVED, removed: X_ADDED, before: "407eaf0e", after: "295ebb52" };
  const restoreRun = (card: string, sc: Scenario) => checkScope(card, { git: fakeGit(sc).git, areas: ["src/app/(app)/accounting"] });
  const exitCodes = (card: string, sc: Scenario) => {
    const codes: number[] = [];
    const dir = mkdtempSync(path.join(os.tmpdir(), "r1964-"));
    writeFileSync(path.join(dir, `${card}.json`), JSON.stringify({ card, areas: ["src/app/(app)/accounting"] }));
    enforceScope(card, "commits", { lockDir: dir, git: fakeGit(sc).git, exit: (c: number) => { codes.push(c); } });
    return codes;
  };

  it("R-1964: bringing back a card's version that a later commit had wrongly reverted is a RESTORE — passes with a note", () => {
    const sc: Scenario = { changes: [["M", RF]], now: { [RF]: "407eaf0e" }, history: { [RF]: [Y, X] }, removed: { [RF]: X_REMOVED }, readded: { [RF]: X_ADDED } };
    const r = restoreRun("R-1962", sc);
    expect(r.refused).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.restored).toHaveLength(1);
    expect(r.message).toMatch(/\[restore\] src\/app\/\(app\)\/accounting\/balance-sheet\/bs-lines\.tsx — R-1899 commit ea82e098 ka kaam wapas; R-1905 commit c0159d00/);
    expect(exitCodes("R-1962", sc)).toEqual([]);
  });

  it("R-1964: the true revert itself (c0159d00 putting R-1899's file back) is still exit 9", () => {
    const sc: Scenario = { changes: [["M", RF]], now: { [RF]: "295ebb52" }, history: { [RF]: [X] }, removed: { [RF]: X_ADDED }, readded: { [RF]: X_REMOVED } };
    const r = restoreRun("R-1905", sc);
    expect(r.ok).toBe(false);
    expect(r.restored).toEqual([]);
    expect(r.refused[0].rule).toBe("revert");
    expect(r.refused[0].why).toMatch(/R-1899 commit ea82e098/);
    expect(exitCodes("R-1905", sc)).toEqual([SCOPE_EXIT]);
  });

  it("R-1964: a 'restore' by commit message only is still exit 9 — Y must really have put X's file back (blob hashes)", () => {
    /* Y is genuine work of its own here (its version is NOT X's parent version), whatever its subject says */
    const Yreal = { ...Y, subject: "R-1905: revert of ea82e098 (restore R-1899)", after: "aaaa0000" };
    const r = restoreRun("R-1962", { changes: [["M", RF]], now: { [RF]: "407eaf0e" }, history: { [RF]: [Yreal, X] }, removed: { [RF]: X_REMOVED }, readded: { [RF]: X_ADDED } });
    expect(r.ok).toBe(false);
    expect(r.refused[0].why).toMatch(/R-1905 commit c0159d00/);
  });

  it("R-1964: reverting the restore again (revert of a revert of a revert) is still exit 9", () => {
    const R = { sha: "069461c8cc", subject: "R-1962: bring back R-1899's statement row highlight", added: X_ADDED, removed: X_REMOVED, before: "295ebb52", after: "407eaf0e" };
    const r = restoreRun("R-1999", { changes: [["M", RF]], now: { [RF]: "295ebb52" }, history: { [RF]: [R, Y, X] }, removed: { [RF]: X_ADDED }, readded: { [RF]: X_REMOVED } });
    expect(r.ok).toBe(false);
    expect(r.refused[0].why).toMatch(/R-1962 commit 069461c8/);
  });

  it("R-1964: a restore does not hide a LATER card's work being undone on the same file", () => {
    const zAdded = ["const total = sumLines(lines, { roundTo: 2 });", "if (!lines.length) return <EmptyState />;", "const footer = renderFooter(total, period);"];
    const Z = { sha: "dddd3333", subject: "R-1950: balance sheet footer", added: zAdded, removed: [], before: "295ebb52", after: "5555zzzz" };
    const r = restoreRun("R-1962", { changes: [["M", RF]], now: { [RF]: "407eaf0e" }, history: { [RF]: [Z, Y, X] }, removed: { [RF]: [...X_REMOVED, ...zAdded] }, readded: { [RF]: X_ADDED } });
    expect(r.ok).toBe(false);
    expect(r.refused[0].why).toMatch(/R-1950 commit dddd3333/);
  });

  it("no claimed areas known (no lock) → rule 1 only warns, the old behaviour; migrations are still refused", () => {
    const g = fakeGit({ changes: [["M", "production/src/lib/billing/invoice-math.ts"]] }).git;
    const r = checkScope("R-1958", { git: g, areas: [] });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/claim ke areas nahi mile/);
    const m = checkScope("R-1958", { git: fakeGit({ changes: [["D", "production/supabase/migrations/20261020000000_old.sql"]] }).git, areas: [] });
    expect(m.ok).toBe(false);
  });

  it("a range with merge commits (manager merge) → area/revert rules only warn", () => {
    const r = run({ merges: true, changes: [["M", "production/src/lib/billing/invoice-math.ts"]] });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/merge commit hai, sirf chetavni/);
  });

  it("--allow-outside <path> lets that path through and reports it for the log", () => {
    const r = run({ changes: [["M", "production/src/lib/billing/invoice-math.ts"]] }, { allowOutside: ["src/lib/billing"] });
    expect(r.ok).toBe(true);
    expect(r.allowedUsed).toEqual(["src/lib/billing/invoice-math.ts"]);
    expect(parseScopeFlags(["--card", "c.json", "--allow-outside", "src/a", "--allow-outside=src/b", "--fixes-red"])).toEqual({ rest: ["--card", "c.json", "--fixes-red"], allowOutside: ["src/a", "src/b"] });
  });

  it("worktree mode (check, before the commit) diffs the working tree and hashes the file on disk", () => {
    const f = "production/src/lib/deals/deal-rules.ts";
    const fk = fakeGit({ changes: [["M", f]], now: { [f]: "blob-old" }, history: { [f]: [{ sha: "e1", subject: "R-1923: onboarding", added: ["x = 1 + total;"], before: "blob-old" }] } });
    const r = checkScope("R-1958", { git: fk.git, areas: AREAS, mode: "worktree" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ye commit doosre card/);
    expect(fk.calls.find((c) => c[0] === "diff" && c.includes("--name-status"))).toEqual(["diff", "--name-status", "-z", "--no-renames", "BASE"]);
    expect(fk.calls.some((c) => c[0] === "hash-object")).toBe(true);
  });

  it("claimed areas = the lock's claim + the card's files (never the lock's growing `files`)", () => {
    expect(claimedAreas({ areas: ["src/lib/deals"], files: ["src/lib/billing/x.ts"] }, { files: ["production/tests"] })).toEqual(["src/lib/deals", "production/tests"]);
    expect(claimedAreas(null, null)).toEqual([]);
    /* R-2106: a lock/card written as one comma-joined string (29 Oct: R-2102/R-2104/R-2098) still counts per path */
    expect(claimedAreas({ areas: ["src/lib/deals,src/lib/quotes"] }, { files: ["production/src/a.ts, src/b.ts"] })).toEqual(["src/lib/deals", "src/lib/quotes", "production/src/a.ts", "src/b.ts"]);
    expect(scopePath("../docs/WORKER-STEPS.md")).toBe("docs/WORKER-STEPS.md");
    expect(testNextToClaim("tests/worker-lock-guards.test.ts", ["scripts/ops/worker-lock.mjs"])).toBe(true);
    expect(testNextToClaim("tests/invoice.test.ts", ["scripts/ops/worker-lock.mjs"])).toBe(false);
    expect(isGenerated("production/src/server/migrations-health/peeks.generated.ts")).toBe(true);
    expect(removedLines("--- a/x\n-  const tds = 1;\n-}\n+new")).toEqual(new Set(["const tds = 1;"]));
    expect(parseLogPatches("\x1eabc\tR-1: s\n+++ b/x\n+const y = 2;\n")[0].added).toEqual(new Set(["const y = 2;"]));
  });

  it("enforceScope exits 9 on a refusal, logs --allow-outside, and only warns when git itself fails", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "r1958-"));
    writeFileSync(path.join(dir, "R-1958.json"), JSON.stringify({ card: "R-1958", areas: ["src/lib/deals"], files: [] }));
    const codes: number[] = [];
    const exit = (c: number) => { codes.push(c); };
    enforceScope("R-1958", "commits", { lockDir: dir, git: fakeGit({ changes: [["M", "production/src/lib/billing/x.ts"]] }).git, exit });
    expect(codes).toEqual([SCOPE_EXIT]);
    expect(SCOPE_EXIT).toBe(9);
    enforceScope("R-1958", "commits", { lockDir: dir, allowOutside: ["src/lib/billing"], git: fakeGit({ changes: [["M", "production/src/lib/billing/x.ts"]] }).git, exit });
    expect(codes).toEqual([9]);
    expect(readFileSync(path.join(dir, "_scope-guard.log"), "utf8")).toMatch(/"allowOutside":\["src\/lib\/billing\/x.ts"\]/);
    const ok = enforceScope("R-1958", "commits", { lockDir: dir, git: () => { throw new Error("git missing"); }, exit });
    expect(ok).toBe(true);
    expect(codes).toEqual([9]);
    expect(existsSync(path.join(dir, "R-1958.json"))).toBe(true);
  });

  it("worker-lock wires the guard into check and into push before AND after the rebase", () => {
    const src = readFileSync(path.join(__dirname, "..", "scripts", "ops", "worker-lock.mjs"), "utf8");
    const push = src.slice(src.indexOf("async function pushWithTurn"), src.indexOf("R-1898 (25 Oct 2026)"));
    expect(push.indexOf("scope();")).toBeGreaterThan(-1);
    expect(push.indexOf("scope();")).toBeLessThan(push.indexOf("rebaseResolvingDerived(") /* R-2105: the rebase runs there */);
    expect(push.lastIndexOf("scope((c)")).toBeGreaterThan(push.indexOf("rebaseResolvingDerived(") /* R-2105: the rebase runs there */);
    expect(src).toMatch(/enforceScope\(card, "worktree"/);
  });
});
