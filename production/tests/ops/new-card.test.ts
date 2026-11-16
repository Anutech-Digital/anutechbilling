/* R-2719 (12 Nov 2026) — new-card.mjs. 12 Nov: three workers had to fix card fields before
   `worker-lock claim` took the card (exit 6), and cards were made without bumping meta/nextId
   (R-2676/R-2677, R-2680/R-2681). The helper builds a card with every claim-contract field and
   prints ONE ArtifactData batch that takes the id and creates the card together. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { parseArgs, buildCard, batchWrites, writeFiles, utcStamp, istDay, defaultCategory } from "../../scripts/ops/new-card.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { cardContractGaps, checkCardContract, CLAIM_FIELDS } from "../../scripts/ops/worker-lock.mjs";

const NOW = new Date("2026-11-12T15:11:21.456Z"); // 20:41 IST
const ARGS = [
  "--next", "2720", "--next-version", "313", "--title", "Bank page: total wrong after undo", "--priority", "p1",
  "--kind", "bug", "--goal", "G-RECON", "--why", "12 Nov: seen on staging by chk-train", "--done-when", "Total matches the lines after undo; test",
  "--found-by", "chk-train-1112",
];
const built = () => buildCard(parseArgs(ARGS), NOW);

describe("new-card — the card (R-2719)", () => {
  it("has every field the claim contract needs, plus owner and a first liveLog line", () => {
    const b = built();
    expect(b.ok).toBe(true);
    expect(b.id).toBe("R-2720");
    expect(cardContractGaps(b.card, "claim")).toEqual([]);
    const at = (obj: unknown, dotted: string) => dotted.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
    for (const f of CLAIM_FIELDS as string[]) expect(at(b.card, f), f).toBeTruthy();
    expect(b.card).toMatchObject({
      id: "R-2720", title: "Bank page: total wrong after undo", priority: "p1", status: "list", kind: "bug", category: "naya",
      goal: "G-RECON", owner: "pardeep", from: "ai", foundBy: "chk-train-1112",
      triage: { verdict: "do", why: "12 Nov: seen on staging by chk-train", at: "2026-11-12T15:11:21Z" },
      doneWhen: "Total matches the lines after undo; test",
      createdAt: "2026-11-12T15:11:21Z",
    });
    expect(b.card.liveLog).toHaveLength(1);
    expect(b.card.liveLog[0].at).toBe("2026-11-12T15:11:21Z");
    expect(b.card.liveLog[0].text).toMatch(/chk-train-1112: card banaya/);
    // a fresh card is not claimed and carries no verdicts
    for (const k of ["claimedBy", "claimedAt", "nowDoing", "commits", "galatCount", "ownerCheck", "howToCheck"]) expect(b.card).not.toHaveProperty(k);
  });

  it("worker-lock's own claim check accepts the saved card file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "new-card-"));
    try {
      const b = built();
      const files = writeFiles(dir, b);
      expect(files.card).toMatch(/\/cards\/R-2720\.json$/);
      expect(checkCardContract("R-2720", "claim", { cardPath: files.card, noCheck: false }).ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(files.meta, "utf8"))).toEqual(b.metaUpdate);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("defaults: category like the page (p0 → zaroori), owner pardeep, times in UTC seconds", () => {
    expect(defaultCategory("p0")).toBe("zaroori");
    expect(defaultCategory("p2")).toBe("naya");
    expect(buildCard({ ...parseArgs(ARGS), priority: "P0" }, NOW).card.category).toBe("zaroori");
    expect(buildCard({ ...parseArgs(ARGS), category: "paisa", owner: "Hitesh" }, NOW).card).toMatchObject({ category: "paisa", owner: "hitesh" });
    expect(utcStamp(NOW)).toBe("2026-11-12T15:11:21Z");
    expect(istDay(new Date("2026-11-12T19:00:00Z"))).toBe("13 Nov"); // 00:30 IST next day
  });

  it("a human's card: --from <person>, no foundBy needed; an AI card must say who found it", () => {
    const o = parseArgs(ARGS.slice(0, -2));
    expect(buildCard(o, NOW).errors.join()).toMatch(/--found-by chahiye/);
    const human = buildCard({ ...o, from: "hitesh" }, NOW);
    expect(human.ok).toBe(true);
    expect(human.card.from).toBe("hitesh");
    expect(human.card).not.toHaveProperty("foundBy");
    expect(buildCard({ ...o, from: "Mr X" }, NOW).errors.join()).toMatch(/asli insaan/);
  });

  it("refuses rather than invent: names every missing field, builds nothing", () => {
    const r = buildCard(parseArgs(["--next", "2720", "--next-version", "313"]), NOW);
    expect(r.ok).toBe(false);
    expect(r.card).toBeUndefined();
    const text = r.errors.join("\n");
    for (const f of ["--title", "--priority", "--kind", "--why", "--done-when"]) expect(text).toContain(f);
    expect(buildCard({ ...parseArgs(ARGS), doneWhen: "   " }, NOW).errors.join()).toMatch(/--done-when/);
    expect(buildCard({ ...parseArgs(ARGS), priority: "urgent" }, NOW).errors.join()).toMatch(/--priority/);
    expect(buildCard({ ...parseArgs(ARGS), goal: "recon" }, NOW).errors.join()).toMatch(/--goal/);
    expect(buildCard({ ...parseArgs(ARGS), kind: "goal" }, NOW).errors.join()).toMatch(/goal card/);
  });
});

describe("new-card — the id is taken safely (R-2719)", () => {
  it("needs next AND the doc version — never a guessed id", () => {
    expect(buildCard({ ...parseArgs(ARGS), next: undefined }, NOW).errors.join()).toMatch(/--next <n>/);
    expect(buildCard({ ...parseArgs(ARGS), nextVersion: undefined }, NOW).errors.join()).toMatch(/--next-version/);
    for (const bad of ["R-2720", "27.5", "-3", "0", ""]) expect(buildCard({ ...parseArgs(ARGS), next: bad }, NOW).ok, bad).toBe(false);
  });

  it("one batch: meta/nextId bumped under if_version, the card created with NO if_version", () => {
    const b = built();
    expect(b.metaUpdate).toEqual({ next: 2721, note_r2720: "12 Nov: R-2720 taken by chk-train-1112 (Bank page: total wrong after undo)." });
    const w = batchWrites(b);
    expect(w).toHaveLength(2);
    expect(w[0]).toEqual({ op: "update", collection: "meta", doc_id: "nextId", data: b.metaUpdate, if_version: 313 });
    expect(w[1]).toEqual({ op: "set", collection: "cards", doc_id: "R-2720", data: b.card });
    expect(w[1]).not.toHaveProperty("if_version"); // an existing R-2720 → the whole batch is refused
    // meta is an UPDATE (merge): the other notes in meta/nextId stay
    expect(Object.keys(b.metaUpdate).sort()).toEqual(["next", "note_r2720"]);
  });

  it("with files the writes carry file_path instead of data", () => {
    const w = batchWrites(built(), { card: "C:/x/cards/R-2720.json", meta: "C:/x/meta/nextId.update.json" });
    expect(w[0]).toEqual({ op: "update", collection: "meta", doc_id: "nextId", file_path: "C:/x/meta/nextId.update.json", if_version: 313 });
    expect(w[1]).toEqual({ op: "set", collection: "cards", doc_id: "R-2720", file_path: "C:/x/cards/R-2720.json" });
  });
});

describe("new-card — command line (R-2719)", () => {
  const script = path.resolve(__dirname, "../../scripts/ops/new-card.mjs");
  const run = (args: string[]) => {
    try { return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: `${x.stdout}${x.stderr}` }; }
  };

  it("parses --flag value and --flag=value; rejects unknown flags and missing values", () => {
    expect(parseArgs(["--title=a b", "--priority", "p2"])).toEqual({ help: false, title: "a b", priority: "p2" });
    expect(() => parseArgs(["--force"])).toThrow(/--force/);
    expect(() => parseArgs(["--title"])).toThrow(/--title needs a value/);
    expect(() => parseArgs(["--title", "--priority", "p1"])).toThrow(/--title needs a value/);
  });

  it("prints the card and the batch for the coordinator; writes files with --out; never claims to have written the board", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "new-card-cli-"));
    try {
      const r = run([...ARGS, "--out", dir]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/R-2720 ka card taiyaar/);
      expect(r.out).toMatch(/action: "batch"/);
      expect(r.out).toMatch(/"if_version": 313/);
      expect(r.out).toMatch(/node nahi likh sakta/);
      const card = JSON.parse(fs.readFileSync(path.join(dir, "cards", "R-2720.json"), "utf8"));
      expect(cardContractGaps(card, "claim")).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("missing fields → exit 1 with the field names, no file written", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "new-card-cli-"));
    try {
      const r = run(["--next", "2720", "--next-version", "313", "--title", "x", "--out", dir]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/--done-when chahiye/);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
