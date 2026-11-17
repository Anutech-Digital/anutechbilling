#!/usr/bin/env node
/**
 * Session health hook — R-2898 (17 Nov 2026).
 *
 * Problem: a coordinator Claude session that runs a day+ gets long (context 80%+), slow, costly and slips
 * (times typed from memory, wrong folder, wrong worktree). The fix is a HANDOFF to a fresh session
 * (.claude/skills/session-handoff). This hook only REMINDS — it never blocks, never writes the board,
 * never runs git or network. It is wired in .claude/settings.json:
 *   UserPromptSubmit -> node production/scripts/ops/session-health.mjs           (mode "prompt")
 *   PreCompact       -> node production/scripts/ops/session-health.mjs compact   (mode "compact")
 * Reads the hook JSON from stdin ({ transcript_path, session_id, ... }). ALWAYS exits 0, < 1 s.
 *
 * HOW SIZE IS ESTIMATED (conservative, documented):
 *  1. Best: the newest assistant message in the LAST ~256 KB of the transcript carries `usage`
 *     (input + cache_read + cache_creation tokens) = the real context size.
 *     % = tokens / CONTEXT_WINDOW_TOKENS.
 *  2. Fallback (no usage found): transcript FILE size. A .jsonl transcript is ~40 bytes per context token
 *     (JSON wrapping, tool results, snapshots) and never shrinks on /compact, so it over-estimates, which is
 *     the safe side. 1M tokens ~ 40 MB, so BYTES_PER_TOKEN = 40. Calibration on Pardeep's laptop, 17 Nov:
 *     the day-long coordinator transcript was ~306 MB, the next one 140 MB after ~6 h - both far past 40 MB,
 *     i.e. both would have been reminded long before they became slow.
 *  Session age = the later of the first transcript line's timestamp and the file birth time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// -- thresholds: change HERE only ---------------------------------------------------------------
export const CONTEXT_WINDOW_TOKENS = Number(process.env.SESSION_HEALTH_WINDOW_TOKENS) || 1_000_000;
export const BYTES_PER_TOKEN = 40; // fallback estimate, see header
export const REMIND_AT_PERCENT = 60; // context % at/above which we remind
export const REMIND_AT_HOURS = 8; // session age (hours) at/above which we remind
export const REMIND_EVERY_MIN = 30; // rate limit: one reminder per this many minutes
export const TAIL_BYTES = 256 * 1024; // how much of the transcript end we read for `usage`
export const HEAD_BYTES = 16 * 1024; // how much of the start we read for the first timestamp
// ------------------------------------------------------------------------------------------------

/** Context % from real token usage, or from file bytes when usage is unknown. */
export function estimatePercent({ tokens, bytes }) {
  const t = Number.isFinite(tokens) && tokens > 0 ? tokens : (Number.isFinite(bytes) && bytes > 0 ? bytes / BYTES_PER_TOKEN : 0);
  return Math.min(999, Math.round((t / CONTEXT_WINDOW_TOKENS) * 100));
}

/** Decide whether to remind. Pure - tested in tests/ops/session-health.test.ts. */
export function decide({ percent, ageHours, nowMs, lastRemindedMs, mode = "prompt" }) {
  const overPct = percent >= REMIND_AT_PERCENT;
  const overAge = ageHours >= REMIND_AT_HOURS;
  const compact = mode === "compact";
  if (!compact && !overPct && !overAge) return { remind: false, reason: "below thresholds" };
  if (!compact && Number.isFinite(lastRemindedMs) && lastRemindedMs > 0 && nowMs - lastRemindedMs < REMIND_EVERY_MIN * 60_000) {
    return { remind: false, reason: "rate limited" };
  }
  return { remind: true, reason: overPct ? "context" : overAge ? "age" : "compact" };
}

export function buildMessage({ percent, ageHours, mode = "prompt" }) {
  const h = (Math.round(ageHours * 10) / 10).toString();
  if (mode === "compact") {
    return `Context abhi summarize hone wala hai (≈${percent}%, ${h} hours). Pehle session-handoff skill se board par handoff doc refresh karo (inFlight, next, ownerPending, rules) - summary mein ye details kho jaati hain.`;
  }
  return `Session lamba ho gaya (≈${percent}%, ${h} hours): session-handoff skill chalao (.claude/skills/session-handoff) - board par handoff likho, owner ko naya session kholne ko kaho, naya kaam mat lo.`;
}

/** Newest `usage` total (tokens) found in a transcript tail, or null. */
export function tokensFromTail(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || l.indexOf('"usage"') === -1) continue;
    try {
      const o = JSON.parse(l);
      const u = o && o.message && o.message.usage;
      if (u && typeof u === "object") {
        const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (total > 0) return total;
      }
    } catch { /* partial first line of the tail, or not JSON - skip */ }
  }
  return null;
}

export function firstTimestampMs(text) {
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      const t = Date.parse((o && o.timestamp) || "");
      if (Number.isFinite(t)) return t;
    } catch { /* partial or not JSON */ }
  }
  return null;
}

function readSlice(fd, start, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return buf.toString("utf8", 0, n);
}

/** Read size + age + tokens of a transcript file; never throws. */
export function measureTranscript(file, nowMs = Date.now(), opts = {}) {
  const out = { bytes: 0, tokens: null, ageHours: 0 };
  let fd;
  try {
    const st = fs.statSync(file);
    out.bytes = st.size;
    fd = fs.openSync(file, "r");
    const tailLen = Math.min(TAIL_BYTES, st.size);
    out.tokens = tokensFromTail(readSlice(fd, Math.max(0, st.size - tailLen), tailLen));
    const first = firstTimestampMs(readSlice(fd, 0, Math.min(HEAD_BYTES, st.size)));
    // A resumed/copied transcript can start with old entries (17 Nov: first line was 20 days old), so the
    // session start is the LATER of the first timestamp and the file birth time (never over-reports age).
    const birth = !opts.ignoreBirth && st.birthtimeMs > 0 ? st.birthtimeMs : 0;
    const startMs = Math.max(first !== null ? first : 0, birth) || st.mtimeMs;
    out.ageHours = Math.max(0, (nowMs - startMs) / 3_600_000);
  } catch { /* unreadable -> zeros -> no reminder */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return out;
}

export function stateFile(key) {
  const h = crypto.createHash("sha1").update(String(key || "unknown")).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `claude-session-health-${h}.json`);
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}
function writeState(file, s) {
  try { fs.writeFileSync(file, JSON.stringify(s)); } catch { /* ignore */ }
}

/** Whole hook: stdin JSON in -> the string to print (or ""). Never throws. */
export function run(stdinText, mode = "prompt", nowMs = Date.now(), opts = {}) {
  let input = {};
  try { input = JSON.parse(stdinText || "{}"); } catch { return ""; }
  const tp = input && input.transcript_path;
  if (!tp || typeof tp !== "string") return "";
  const m = measureTranscript(tp, nowMs, opts);
  const percent = estimatePercent({ tokens: m.tokens, bytes: m.bytes });
  const sf = stateFile(input.session_id || tp);
  const state = readState(sf);
  const d = decide({ percent, ageHours: m.ageHours, nowMs, lastRemindedMs: state.lastRemindedMs, mode });
  if (mode === "compact") {
    // After a compact the summary has lost the details: force a reminder on the very next prompt.
    writeState(sf, { ...state, lastRemindedMs: 0 });
    return JSON.stringify({ systemMessage: buildMessage({ percent, ageHours: m.ageHours, mode }) });
  }
  if (!d.remind) return "";
  writeState(sf, { ...state, lastRemindedMs: nowMs });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: buildMessage({ percent, ageHours: m.ageHours, mode }) } });
}

function main() {
  const mode = process.argv[2] === "compact" ? "compact" : "prompt";
  let data = "";
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    try { const o = run(data, mode); if (o) process.stdout.write(o + "\n"); } catch { /* never fail the session */ }
    process.exit(0);
  };
  const timer = setTimeout(done, 700); // stdin never closed -> still finish < 1 s
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { data += c; });
  process.stdin.on("end", () => { clearTimeout(timer); done(); });
  process.stdin.on("error", () => { clearTimeout(timer); done(); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
