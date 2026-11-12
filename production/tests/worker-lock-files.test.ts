import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { LOCK_VERSION, hardPaths, softFolders, claimHardPaths, claimFolders, parseMoveFlags, liveFilesReader, isFileArea, isFileLock, worktreeChangedFiles } from "../scripts/ops/worker-lock-files.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { findConflicts, settleCiWaitLocks, LOCK_STATES } from "../scripts/ops/worker-lock.mjs";

/*
 * R-2718 (12 Nov 2026): locks by file, not by folder. R-2698 claimed the payroll folders; R-2701 waited
 * ~1 h in the slot queue though the two cards never touched the same file. A v2 lock (lockVersion 2)
 * holds its claimed FILES, its --move folders and the files it really changed (recorded `files` + its
 * worktree's live diff); its other claimed folders are scope only. Old locks keep folder = hard.
 */
type Lock = Record<string, unknown>;
const PAYROLL = "src/app/(app)/accounting/payroll";
const FEAT = "src/components/features/payroll";

const v2 = (card: string, areas: string[], extra: Lock = {}): Lock => ({ card, lockVersion: LOCK_VERSION, areas, files: [], moves: [], worktree: `C:/wt/${card}`, ...extra });
const cards = (cs: { card: string }[]) => [...new Set(cs.map((c) => c.card))];

describe("R-2718 file vs folder", () => {
  it("a name with an extension (or a dotfile) is a file; anything else is a folder", () => {
    expect(isFileArea("src/lib/payroll/statutory.ts")).toBe(true);
    expect(isFileArea("docs/WORKER-STEPS.md")).toBe(true);
    expect(isFileArea("production/.env.example")).toBe(true);
    expect(isFileArea(PAYROLL)).toBe(false);
    expect(isFileArea("src/app/api/subscriptions/[id]/generate-renewal-quote")).toBe(false);
  });

  it("parses --move <folder> (repeatable, also --move=) out of the claim args", () => {
    expect(parseMoveFlags(["C:/wt", "a.ts", "--move", "src/lib/old", "--move=production/src/lib/x/"])).toEqual({ rest: ["C:/wt", "a.ts"], moves: ["src/lib/old", "src/lib/x"] });
  });

  it("my new claim holds only its files and --move folders hard", () => {
    expect(claimHardPaths([PAYROLL, `${PAYROLL}/screens.tsx`, "src/lib/old"], ["src/lib/old"])).toEqual([`${PAYROLL}/screens.tsx`, "src/lib/old"]);
  });
});

describe("R-2718 the R-2698 / R-2701 case", () => {
  const r2698 = v2("R-2698", [PAYROLL, FEAT, "src/lib/payroll/statutory.ts"], { files: [`${PAYROLL}/screens.tsx`] });

  it("a card on a DIFFERENT file in the same folder claims at once", () => {
    const mine = claimHardPaths([`${FEAT}/employee-detail-drawer.tsx`, "src/lib/queries/payroll.ts"]);
    expect(findConflicts("R-2701", mine, [r2698])).toEqual([]);
  });

  it("the SAME file is refused — a claimed file, a recorded changed file, or one changed live in its worktree", () => {
    expect(cards(findConflicts("R-2701", ["src/lib/payroll/statutory.ts"], [r2698]))).toEqual(["R-2698"]);
    expect(cards(findConflicts("R-2701", [`${PAYROLL}/screens.tsx`], [r2698]))).toEqual(["R-2698"]);
    const live = (l: Lock) => (l.card === "R-2698" ? [`${FEAT}/employee-delete-dialog.tsx`] : []);
    expect(findConflicts("R-2701", [`${FEAT}/employee-delete-dialog.tsx`], [r2698], { live })).toEqual([
      { card: "R-2698", mine: `${FEAT}/employee-delete-dialog.tsx`, theirs: `${FEAT}/employee-delete-dialog.tsx` },
    ]);
    /* without the live diff the same file would pass — the live read is what makes a soft folder safe */
    expect(findConflicts("R-2701", [`${FEAT}/employee-delete-dialog.tsx`], [r2698])).toEqual([]);
  });

  it("an OLD lock (no lockVersion — a card already running) keeps its whole folders", () => {
    const old = { card: "R-2698", areas: [PAYROLL, FEAT], files: [] };
    expect(isFileLock(old)).toBe(false);
    expect(hardPaths(old)).toEqual([PAYROLL, FEAT]);
    expect(softFolders(old)).toEqual([]);
    expect(cards(findConflicts("R-2701", [`${FEAT}/employee-detail-drawer.tsx`], [old]))).toEqual(["R-2698"]);
    /* a new card's soft folder inside (or around) an old lock's folder is refused at claim, as before */
    expect(cards(findConflicts("R-2701", [], [old], { soft: [`${FEAT}/sub`] }))).toEqual(["R-2698"]);
    /* …while two v2 soft folders on the same folder do not clash */
    expect(findConflicts("R-2701", [], [v2("R-2698", [FEAT])], { soft: [FEAT] })).toEqual([]);
  });

  it("a --move folder is hard both ways: no file inside it, and no soft folder overlapping it", () => {
    const mover = v2("R-9001", [FEAT], { moves: [FEAT] });
    expect(cards(findConflicts("R-2701", [`${FEAT}/x.tsx`], [mover]))).toEqual(["R-9001"]);
    /* someone claims a soft folder inside the folder being moved */
    expect(cards(findConflicts("R-2701", [], [mover], { soft: [`${FEAT}/sub`] }))).toEqual(["R-9001"]);
    /* I move a folder another card works in (soft) */
    expect(cards(findConflicts("R-9002", [FEAT], [r2698], { moves: [FEAT] }))).toEqual(["R-2698"]);
    expect(findConflicts("R-9002", ["src/lib/other"], [r2698], { moves: ["src/lib/other"] })).toEqual([]);
  });

  it("generated deploy-db / peeks files still never clash (R-2105)", () => {
    const peeks = "src/server/migrations-health/peeks.generated.ts";
    const l = v2("R-1", ["src/lib/x/a.ts"], { files: [peeks] });
    expect(findConflicts("R-2", [peeks], [l])).toEqual([]);
  });

  it("a ci-wait v2 lock whose worktree is gone still holds what it recorded (and is settled on green)", () => {
    const pushed = v2("R-2698", [PAYROLL], { files: [`${PAYROLL}/screens.tsx`], state: LOCK_STATES.ciWait, pushedSha: "abc1234", worktree: "C:/gone" });
    expect(cards(findConflicts("R-2701", [`${PAYROLL}/screens.tsx`], [pushed]))).toEqual(["R-2698"]);
    const removed: string[] = [];
    const left = settleCiWaitLocks("R-2701", [`${PAYROLL}/screens.tsx`], [pushed], {
      gh: () => JSON.stringify([{ workflowName: "CI", status: "completed", conclusion: "success", headSha: "abc1234", databaseId: 1, url: "u", createdAt: "2026-11-12T10:00:00Z" }, { workflowName: "SQL tests", status: "completed", conclusion: "success", headSha: "abc1234", databaseId: 2, url: "u", createdAt: "2026-11-12T10:00:00Z" }]),
      isAncestor: () => true, remove: (c: string) => removed.push(c), print: () => {},
    });
    expect(removed).toEqual(["R-2698"]);
    expect(left).toEqual([]);
  });
});

describe("R-2718 live changed files of another worktree", () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "r2718-live-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "core.autocrlf", "false");
    fs.mkdirSync(path.join(repo, "production", "src", "lib", "payroll"), { recursive: true });
    fs.writeFileSync(path.join(repo, "production", "src", "lib", "payroll", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repo, "production", "src", "lib", "payroll", "b.ts"), "export const b = 1;\n");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/anutech/manager-pardeep", "HEAD");
    /* the card: one committed change, one uncommitted, one new file */
    fs.writeFileSync(path.join(repo, "production", "src", "lib", "payroll", "a.ts"), "export const a = 2;\n");
    git("commit", "-qam", "R-1: a");
    fs.writeFileSync(path.join(repo, "production", "src", "lib", "payroll", "b.ts"), "export const b = 2;\n");
    fs.writeFileSync(path.join(repo, "production", "src", "lib", "payroll", "c.ts"), "export const c = 1;\n");
  });
  afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it("reads committed + uncommitted + untracked files, app-relative", () => {
    expect(worktreeChangedFiles(repo).sort()).toEqual(["src/lib/payroll/a.ts", "src/lib/payroll/b.ts", "src/lib/payroll/c.ts"]);
    expect(worktreeChangedFiles(path.join(repo, "missing"))).toEqual([]);
  });

  it("reads each v2 lock's worktree once per 30 s, and never an old lock's", () => {
    let reads = 0, t = 0;
    const live = liveFilesReader({ read: () => { reads++; return ["x.ts"]; }, now: () => t });
    const l = v2("R-1", ["src/lib/payroll"], { worktree: repo });
    expect(live(l)).toEqual(["x.ts"]);
    expect(live(l)).toEqual(["x.ts"]);
    expect(reads).toBe(1);
    t = 31_000;
    live(l);
    expect(reads).toBe(2);
    expect(live({ card: "R-old", areas: ["src/lib/payroll"], worktree: repo })).toEqual([]);
    expect(reads).toBe(2);
  });

  it("end to end: a soft folder blocks exactly the files changed in that worktree", () => {
    const l = v2("R-1", ["src/lib/payroll"], { worktree: repo });
    const live = liveFilesReader();
    expect(cards(findConflicts("R-2", ["src/lib/payroll/c.ts"], [l], { live }))).toEqual(["R-1"]);
    expect(findConflicts("R-2", ["src/lib/payroll/d.ts"], [l], { live })).toEqual([]);
  });
});

describe("R-2718 claim writes a v2 lock that older code still reads safely", () => {
  it("the claim stores lockVersion + moves; the folders stay in `areas` (scope, and hard for old readers)", () => {
    const src = fs.readFileSync(path.resolve("scripts/ops/worker-lock.mjs"), "utf8");
    expect(src).toMatch(/const fileLock = v2 \? \{ lockVersion: LOCK_VERSION, folders: .*, moves: /);
    expect(src).toMatch(/\.\.\.fileLock, areas: \[\.\.\.new Set\(\[\.\.\.keep, \.\.\.areas\.map\(normPath\)\]\)\]/);
    /* old findConflicts read areas + files: a v2 lock's folders are in areas, so an old reader is stricter, never looser */
    const l = v2("R-1", [PAYROLL, "src/lib/payroll/statutory.ts"]);
    const oldReader = [...(l.areas as string[]), ...(l.files as string[])];
    expect(oldReader).toContain(PAYROLL);
  });
});

describe("R-2718 review fixes", () => {
  it("the disk decides file vs folder at claim (Dockerfile = file, [id] = folder); by name when it does not exist yet", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "r2718-fold-"));
    fs.mkdirSync(path.join(wt, "production", "supabase", "functions", "foo"), { recursive: true });
    fs.writeFileSync(path.join(wt, "production", "supabase", "functions", "foo", "Dockerfile"), "FROM x\n");
    fs.mkdirSync(path.join(wt, "production", "src", "app", "api", "x", "[id]"), { recursive: true });
    const areas = ["supabase/functions/foo/Dockerfile", "src/app/api/x/[id]", "src/lib/new-folder", "src/lib/new-file.ts"];
    expect(claimFolders(areas, wt)).toEqual(["src/app/api/x/[id]", "src/lib/new-folder"]);
    const folders = claimFolders(areas, wt);
    expect(claimHardPaths(areas, [], folders)).toEqual(["supabase/functions/foo/Dockerfile", "src/lib/new-file.ts"]);
    /* the lock's `folders` list wins over the name rule for others reading it */
    const l = v2("R-1", areas, { folders });
    expect(hardPaths(l)).toEqual(["supabase/functions/foo/Dockerfile", "src/lib/new-file.ts"]);
    expect(cards(findConflicts("R-2", ["supabase/functions/foo/Dockerfile"], [l]))).toEqual(["R-1"]);
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("fail closed: when another worktree's changes cannot be read, its soft folders count as hard", () => {
    const l = v2("R-2698", [PAYROLL]);
    expect(hardPaths(l, null)).toEqual([PAYROLL]);
    const live = liveFilesReader({ read: () => null });
    expect(cards(findConflicts("R-2701", [`${PAYROLL}/new.tsx`], [l], { live }))).toEqual(["R-2698"]);
    /* a worktree folder that is gone (pushed + cleaned up) is not an error: its recorded files count */
    expect(worktreeChangedFiles("C:/definitely/not/here")).toEqual([]);
  });

  it("other worktrees are read with --no-optional-locks (never take their index.lock)", () => {
    const src = fs.readFileSync(path.resolve("scripts/ops/worker-lock-files.mjs"), "utf8");
    expect(src).toMatch(/execFileSync\("git", \["--no-optional-locks", "-C", worktree/);
  });

  it("a re-claim of an OLD lock stays old; push records its files BEFORE the git push", () => {
    const src = fs.readFileSync(path.resolve("scripts/ops/worker-lock.mjs"), "utf8");
    expect(src).toMatch(/const v2 = !own \|\| isFileLock\(own\);/);
    const push = src.slice(src.indexOf("async function pushWithTurn"), src.indexOf("R-1898 (25 Oct 2026)"));
    expect(push.indexOf("pushedFiles")).toBeGreaterThan(0);
    expect(push.indexOf("pushedFiles")).toBeLessThan(push.indexOf('sh("git push -q anutech HEAD:manager-pardeep"'));
  });
});
