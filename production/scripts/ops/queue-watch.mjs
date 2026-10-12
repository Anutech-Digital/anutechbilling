#!/usr/bin/env node
/**
 * R-1412 — queue-watch: the fast lane for new bug reports. Plain node, no LLM, read-only.
 *
 * Every 90 s it GETs /api/agent/feedback-queue on local (http://localhost:3001) and staging, and
 * prints ONE line per item it has not seen before:
 *     NEW <env> <id> urgent|p0|security|money|normal
 * (classification: scripts/ops/queue-watch-lib.mjs → classify()). A non-200 or a network error
 * prints `QUEUE <env> HTTP <code|down>` at most once per 30 min per env; local being down is
 * just that, rate-limited like any other error.
 *
 * Token: ONLY from scripts/ops/.queue-watch.env (gitignored; copy .queue-watch.env.example):
 *     AGENT_QUEUE_TOKEN=...            used for both envs
 *     AGENT_QUEUE_TOKEN_LOCAL=...      optional, if local's token differs
 *     AGENT_QUEUE_TOKEN_STAGING=...    optional
 *     QUEUE_WATCH_LOCAL_URL / QUEUE_WATCH_STAGING_URL   optional base-URL overrides
 * The token is never printed. Seen ids live in scripts/ops/.queue-watch-state.json (gitignored);
 * the first run prints what is in the queue now, later runs only what is new.
 *
 *   node scripts/ops/queue-watch.mjs          # loop forever
 *   node scripts/ops/queue-watch.mjs --once   # one pass, then exit
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POLL_MS, parseEnvFile, parseState, serializeState, newItems, newLine, shouldReportError, errorLine,
} from "./queue-watch-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, ".queue-watch.env");
const STATE_FILE = join(HERE, ".queue-watch-state.json");
const TIMEOUT_MS = 20_000;

if (!existsSync(ENV_FILE)) {
  console.error(`queue-watch: ${ENV_FILE} not found — copy .queue-watch.env.example next to it and fill the token.`);
  process.exit(2);
}
const cfg = parseEnvFile(readFileSync(ENV_FILE, "utf8"));
const TARGETS = [
  { env: "local", base: cfg.QUEUE_WATCH_LOCAL_URL || "http://localhost:3001", token: cfg.AGENT_QUEUE_TOKEN_LOCAL || cfg.AGENT_QUEUE_TOKEN },
  { env: "staging", base: cfg.QUEUE_WATCH_STAGING_URL || "https://resellersos-staging-njvk4nxhdq-as.a.run.app", token: cfg.AGENT_QUEUE_TOKEN_STAGING || cfg.AGENT_QUEUE_TOKEN },
].filter((t) => t.token);
if (!TARGETS.length) {
  console.error("queue-watch: no AGENT_QUEUE_TOKEN in .queue-watch.env.");
  process.exit(2);
}

let state = existsSync(STATE_FILE) ? parseState(readFileSync(STATE_FILE, "utf8")) : parseState("");

function save() {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, serializeState(state));
  renameSync(tmp, STATE_FILE);
}

function reportError(env, code) {
  const r = shouldReportError(env, state.lastErrorAt, Date.now());
  state.lastErrorAt = r.lastAt;
  if (r.print) console.log(errorLine(env, code));
}

async function poll({ env, base, token }) {
  let res;
  try {
    res = await fetch(`${base.replace(/\/+$/, "")}/api/agent/feedback-queue`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return reportError(env, "down");
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return reportError(env, res.status);
  }
  let body;
  try { body = await res.json(); } catch { return reportError(env, "bad-json"); }
  const r = newItems(env, body?.items, state.seen);
  state.seen = r.seen;
  for (const it of r.fresh) console.log(newLine(env, it));
}

async function tick() {
  await Promise.all(TARGETS.map(poll));
  save();
}

await tick();
if (!process.argv.includes("--once")) setInterval(() => { tick().catch(() => {}); }, POLL_MS);
