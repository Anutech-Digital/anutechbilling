#!/usr/bin/env node
/**
 * Runs the hosting job on a laptop the way Cloud Scheduler runs it on the live site
 * (scripts/setup-cloud-scheduler.sh: every 15 min, 9–21 IST) — here every minute, so a
 * test order is set up within a minute of payment (Pawan, 3 Oct 2026).
 *
 *   node scripts/local-cron.mjs            # keeps running; Ctrl+C to stop
 *   node scripts/local-cron.mjs --once     # one run, then exit
 *
 * Refuses anything but localhost: it carries CRON_SECRET, and a scheduler for the live
 * site already exists.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.LOCAL_CRON_BASE ?? "http://localhost:4320";
const JOBS = ["/api/cron/provision-hosting"];
const EVERY_MS = 60_000;

const host = new URL(BASE).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`local-cron: refusing ${BASE} — this runner is for this machine only.`);
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^"|"$/g, "").trim()]),
);
const secret = env.CRON_SECRET;
if (!secret) {
  console.error("local-cron: CRON_SECRET is not set in .env.local.");
  process.exit(1);
}

async function runOnce() {
  for (const path of JOBS) {
    const at = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
    try {
      const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(170_000) });
      console.log(`${at} ${path} → ${r.status} ${(await r.text()).slice(0, 300)}`);
    } catch (e) {
      console.log(`${at} ${path} → not reached (${e.cause?.code ?? e.message}) — is the app running on ${BASE}?`);
    }
  }
}

await runOnce();
if (!process.argv.includes("--once")) setInterval(runOnce, EVERY_MS);
