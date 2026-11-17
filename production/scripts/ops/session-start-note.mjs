#!/usr/bin/env node
/**
 * SessionStart hook - R-2898 (17 Nov 2026). Prints a short `additionalContext` so every team member's Claude
 * reads the shared BOARD handoff first. No network, no secrets, no git, always exit 0 (never fails a session).
 * Wired in .claude/settings.json (SessionStart).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BOARD_URL = "https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n";

export function buildNote() {
  return [
    "Session start (hook, R-2898): pehle board ka handoff padho - ArtifactData get, url " + BOARD_URL +
      ", collection `coordinator`, doc `handoff-<person>` (pardeep / hitesh / abhishek / pawan; person pata na ho to ek baar poochho) aur `handoff-team`.",
    "Skill .claude/skills/session-handoff follow karo: handoff mein jo job in-flight hai use dobara shuru mat karo (card ka liveLog dekho); git, board, CI, usage ki taza jaanch karke hi kaam shuru karo.",
    "Phir CLAUDE.md ke session-start steps (fetch + merge origin/manager-pardeep, card summary, 'agla card lo?'). Session lamba ho jaye (context 60%+ ya ~8 ghante) to handoff likh kar naya session kholne ko kaho.",
  ].join("\n");
}

export function output() {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: buildNote() } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(output() + "\n"); } catch { /* ignore */ }
  process.exit(0);
}
