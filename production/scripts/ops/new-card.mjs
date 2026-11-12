/**
 * New board card from a template — R-2719 (12 Nov 2026).
 *
 * 12 Nov: three workers had to fix card fields before `worker-lock claim` would take the card (exit 6 —
 * no triage / kind / category / doneWhen), and twice in a week a card was made without bumping
 * meta/nextId (R-2676/R-2677, R-2680/R-2681). This helper builds a card that has EVERY field the claim
 * contract needs (worker-lock.mjs CLAIM_FIELDS) plus owner and a first liveLog line, and takes the id
 * the safe way.
 *
 * It cannot write the board: the board (https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n) is an
 * Artifact database — only Claude's ArtifactData tool can read or write it, node cannot. So it PRINTS
 * (and with --out, saves) the JSON; the session that runs it does the two tool calls:
 *
 *   1. ArtifactData get  — collection `meta`, doc `nextId`. Note `next` (say 2720) and the doc `version` (say 313).
 *   2. node scripts/ops/new-card.mjs --next 2720 --next-version 313 --title "…" --priority p2 --kind bug \
 *        --why "…" --done-when "…" [--goal G-PROCESS] [--category …] [--owner pardeep] [--want "…"] \
 *        [--found-by w-r2719 | --from hitesh] [--by "coordinator"] [--out <dir>]
 *   3. ArtifactData batch with the `writes` it prints — ONE call, two writes:
 *        update meta/nextId {next: 2721, note_r2720} pinned with if_version 313   (someone else took the id → refused)
 *        set    cards/R-2720 with NO if_version                                   (the card already exists → refused)
 *      Either refusal writes nothing: get meta/nextId again and re-run step 2.
 *
 * --out <dir> writes <dir>/cards/R-XXXX.json (the same file `worker-lock claim --card` reads) and
 * <dir>/meta/nextId.update.json, and the printed writes use `file_path`, so nothing is retyped.
 *
 * It refuses (exit 1, names the field) rather than invent: title, priority, kind, why and doneWhen are
 * the caller's to give. Times are this machine's clock in UTC (the same as `date -u`).
 * Tests: tests/ops/new-card.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cardContractGaps } from "./worker-lock.mjs";

export const BOARD_URL = "https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n";
/** Root CLAUDE.md "Card fields": priority p0–p3. */
export const PRIORITIES = ["p0", "p1", "p2", "p3"];
export const PEOPLE = ["pardeep", "hitesh", "abhishek", "pawan", "pratik"];

const VALUE_FLAGS = {
  "--next": "next", "--next-version": "nextVersion", "--title": "title", "--priority": "priority", "--goal": "goal",
  "--kind": "kind", "--category": "category", "--why": "why", "--done-when": "doneWhen", "--owner": "owner",
  "--want": "want", "--area": "area", "--from": "from", "--found-by": "foundBy", "--by": "by", "--out": "out", "--verdict": "verdict",
};

/** argv → options. Throws on an unknown flag or a flag with no value. */
export function parseArgs(argv) {
  const o = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { o.help = true; continue; }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const key = VALUE_FLAGS[flag];
    if (!key) throw new Error(`Unknown argument ${a}`);
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (v == null || (eq < 0 && String(v).startsWith("--"))) throw new Error(`${flag} needs a value`);
    o[key] = String(v);
  }
  return o;
}

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/** "2026-11-12T15:11:21Z" — UTC, whole seconds (what `date -u +%Y-%m-%dT%H:%M:%SZ` prints). */
export function utcStamp(now = new Date()) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The page's own default: p0 → "zaroori", else "naya". */
export const defaultCategory = (priority) => (priority === "p0" ? "zaroori" : "naya");

/**
 * Options → { ok, errors, id, card, metaUpdate, nextVersion }. Pure: `now` is injected.
 * The card passes worker-lock's claim contract (checked here with the same function claim uses).
 */
export function buildCard(o, now = new Date()) {
  const errors = [];
  const next = Number(o.next);
  if (!/^\d+$/.test(clean(String(o.next ?? ""))) || !Number.isSafeInteger(next) || next < 1) errors.push("--next <n> chahiye: meta/nextId ka `next` (pehle ArtifactData get meta/nextId)");
  const nextVersion = Number(o.nextVersion);
  if (!/^\d+$/.test(clean(String(o.nextVersion ?? ""))) || nextVersion < 1) errors.push("--next-version <v> chahiye: meta/nextId doc ka `version` (if_version ke liye — iske bina id surakshit nahi)");
  const title = clean(o.title), why = clean(o.why), doneWhen = clean(o.doneWhen), kind = clean(o.kind).toLowerCase();
  const priority = clean(o.priority).toLowerCase();
  if (!title) errors.push("--title chahiye");
  if (!PRIORITIES.includes(priority)) errors.push(`--priority chahiye: ${PRIORITIES.join(" | ")}`);
  if (!kind) errors.push("--kind chahiye (bug | feature | process | …) — bug = app galat kaam karta / galat data dikhata hai");
  if (kind === "goal") errors.push("--kind goal is helper se nahi — goal card coordinator haath se banata hai");
  if (!why) errors.push("--why chahiye (triage.why: kyon karna hai, kab/kahan dikha)");
  if (!doneWhen) errors.push("--done-when chahiye (kab maana jaaye ki ho gaya — worker ise khud nahi banata)");
  const goal = clean(o.goal);
  if (goal && !/^G-[A-Z0-9-]+$/.test(goal)) errors.push(`--goal "${goal}" galat — G-XXXX jaisa (e.g. G-PROCESS)`);
  const owner = (clean(o.owner) || "pardeep").toLowerCase();
  if (!PEOPLE.includes(owner)) errors.push(`--owner "${owner}" — lowercase person key: ${PEOPLE.join(" | ")}`);
  const foundBy = clean(o.foundBy);
  const from = (clean(o.from) || "ai").toLowerCase();
  if (from === "ai" && !foundBy) errors.push("--found-by chahiye (AI ka card: kis agent/session ne paaya) — ya --from <insaan> jisne maanga");
  if (from !== "ai" && !PEOPLE.includes(from)) errors.push(`--from "${from}" — asli insaan (${PEOPLE.join(" | ")}) ya "ai" + --found-by`);
  const verdict = (clean(o.verdict) || "do").toLowerCase();
  if (errors.length) return { ok: false, errors };

  const at = utcStamp(now);
  const id = `R-${next}`;
  const by = clean(o.by) || foundBy || from;
  const card = {
    id, title: title.slice(0, 400), priority, status: "list", kind,
    category: clean(o.category) || defaultCategory(priority),
    owner, from, goodFor: owner,
    triage: { verdict, why, at },
    why, doneWhen,
    files: [],
    liveLog: [{ at, text: `${by}: card banaya (new-card.mjs) — triage ${verdict}. Next: worker claim kare.` }],
    createdAt: at, updatedAt: at,
  };
  if (goal) card.goal = goal;
  if (foundBy) card.foundBy = foundBy;
  if (clean(o.want)) card.want = clean(o.want);
  if (clean(o.area)) card.area = clean(o.area);
  const gaps = cardContractGaps(card, "claim");
  if (gaps.length) return { ok: false, errors: [`card contract adhoora: ${gaps.join(", ")}`] };
  const metaUpdate = { next: next + 1, [`note_r${next}`]: `${istDay(now)}: ${id} taken by ${by} (${title.slice(0, 160)}).` };
  return { ok: true, errors: [], id, card, metaUpdate, nextVersion };
}

/** "12 Nov" — IST day, the style of the notes in meta/nextId. */
export function istDay(now = new Date()) {
  const d = new Date(new Date(now).getTime() + 330 * 60_000);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
}

/**
 * The ONE ArtifactData batch that takes the id and creates the card together.
 * meta/nextId is pinned (if_version) → refused when someone else took an id meanwhile;
 * the card `set` carries no if_version → refused when that card already exists.
 * `files` = { card, meta } paths → the writes use file_path instead of inline data.
 */
export function batchWrites({ id, card, metaUpdate, nextVersion }, files = null) {
  return [
    { op: "update", collection: "meta", doc_id: "nextId", ...(files ? { file_path: files.meta } : { data: metaUpdate }), if_version: nextVersion },
    { op: "set", collection: "cards", doc_id: id, ...(files ? { file_path: files.card } : { data: card }) },
  ];
}

/** Saves the two JSON files under `dir`; → { card, meta } absolute paths with forward slashes. */
export function writeFiles(dir, built, fsx = fs) {
  const fwd = (p) => path.resolve(p).split(path.sep).join("/");
  const card = path.join(dir, "cards", `${built.id}.json`);
  const meta = path.join(dir, "meta", "nextId.update.json");
  fsx.mkdirSync(path.dirname(card), { recursive: true });
  fsx.mkdirSync(path.dirname(meta), { recursive: true });
  fsx.writeFileSync(card, JSON.stringify(built.card, null, 2) + "\n");
  fsx.writeFileSync(meta, JSON.stringify(built.metaUpdate, null, 2) + "\n");
  return { card: fwd(card), meta: fwd(meta) };
}

const HELP = `node scripts/ops/new-card.mjs --next <n> --next-version <v> --title "…" --priority p0|p1|p2|p3 --kind <bug|feature|process|…> --why "…" --done-when "…"
     [--goal G-XXXX] [--category <c>] [--owner pardeep] [--want "…"] [--area <a>] [--found-by <agent> | --from <person>] [--by <who takes the id>] [--out <dir>]
Pehle: ArtifactData get (collection meta, doc nextId) → next + version. Ye script board par kuch nahi likhta — JSON chhaapta hai.`;

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`✗ ${e.message}\n${HELP}`); return 1; }
  if (o.help || !argv.length) { console.log(HELP); return 0; }
  const built = buildCard(o);
  if (!built.ok) { for (const e of built.errors) console.error(`✗ ${e}`); console.error("(card nahi bana — kuch bhi andaaze se nahi bhara jaata)"); return 1; }
  const files = o.out ? writeFiles(o.out, built) : null;
  const writes = batchWrites(built, files);
  console.log(`✓ ${built.id} ka card taiyaar — claim contract poora (triage, kind, category, doneWhen), owner ${built.card.owner}.`);
  if (files) console.log(`  card file: ${files.card}   (worker-lock claim --card ke liye bhi yahi)\n  meta file: ${files.meta}`);
  else console.log(`\ncard:\n${JSON.stringify(built.card, null, 2)}`);
  console.log(`\nAb EK ArtifactData call (board par yahi likhta hai — node nahi likh sakta):\n  action: "batch", url: "${BOARD_URL}", writes:\n${JSON.stringify(writes, null, 2)}`);
  console.log(`\nRefuse ho (kisi ne id le li / card pehle se hai) → kuch nahi likha gaya: meta/nextId dobara get karo, --next/--next-version badal kar ye script dobara chalao.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
