#!/usr/bin/env node
/**
 * `npm run card:check -- R-xxxx` — a built card's howToCheck as a localhost checklist (R-2457).
 *
 *   npm run card:check -- R-2448                       print: login button, steps with full local URLs, data warnings
 *   npm run card:check -- R-2448 --start [--now "…"]   + write R-2448.check-start.json  (checkRunning, checkStartedAt, checkNow)
 *   npm run card:check -- R-2448 --result "✓ …"        + write R-2448.check-result.json (aiResult, aiResultAt, checkRunning false …)
 *   … --card <file>   the saved card (default <home>/Anutech-HQ/cardfile/cards/R-xxxx.json)
 *   … --host tester1.localhost:3008                    another LOCAL dev server
 *
 * The card file is what ArtifactData `get` with out_dir saves (the same file worker-lock takes as --card).
 * A node script cannot reach the board, so the patch files are written next to the card file and the
 * Claude session applies them: ArtifactData update, collection cards, doc R-xxxx, file_path <patch>,
 * if_version <the version it read>. Times are the machine's UTC clock (same as `date -u`). The status is
 * never in a patch — the owner presses "Theek hai". Logic + tests: card-check-lib.mjs, tests/ops/card-check.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCardCheckArgs, cardFromFile, parseNavLinks, renderChecklist, buildStartPatch, buildResultPatch,
} from "./card-check-lib.mjs";
import { SCENARIOS } from "../dev/scenarios/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const productionDir = path.resolve(here, "..", "..");

function die(msg) {
  console.error(`card:check: ${msg}`);
  process.exit(1);
}

function main(argv) {
  let args;
  try { args = parseCardCheckArgs(argv); } catch (e) { die(e.message); }
  if (args.help || !args.id) {
    console.log('npm run card:check -- R-xxxx [--card <file>] [--host localhost:3001] [--start [--now "…"]] [--result "✓ …"]');
    process.exit(args.help ? 0 : 1);
  }
  const file = path.resolve(args.card ?? path.join(os.homedir(), "Anutech-HQ", "cardfile", "cards", `${args.id}.json`));
  if (!fs.existsSync(file)) {
    die(`no card file at ${file}\n  Save it first: ArtifactData get, collection cards, doc_id ${args.id}, out_dir <home>/Anutech-HQ/cardfile — or pass --card <file>.`);
  }
  let card;
  try { card = cardFromFile(fs.readFileSync(file, "utf8"), args.id); } catch (e) { die(e.message); }
  const links = parseNavLinks(fs.readFileSync(path.join(productionDir, "src", "lib", "nav.ts"), "utf8"));
  for (const l of renderChecklist({ card, host: args.host, links, scenarios: SCENARIOS })) console.log(l);

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const write = (suffix, patch) => {
    const out = path.join(path.dirname(file), `${args.id}.${suffix}.json`);
    fs.writeFileSync(out, `${JSON.stringify(patch, null, 2)}\n`);
    console.log(`\nPatch → ${out}`);
    console.log(`  Board par likho: ArtifactData update · collection cards · doc_id ${args.id} · file_path ${out} · if_version <jo version padha>`);
  };
  try {
    if (args.start) write("check-start", buildStartPatch(now, args.now));
    if (args.result != null) write("check-result", buildResultPatch(now, args.result));
  } catch (e) { die(e.message); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
