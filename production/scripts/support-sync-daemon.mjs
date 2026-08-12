#!/usr/bin/env node
/**
 * Local auto-flush for the Billing→DSP support-plan sync (migration 0224).
 *
 * Run this in its own terminal alongside `npm run dev` — it polls
 * /api/cron/support-sync every 30s, so tagging a subscription "Support (DSP)"
 * in Billing shows up in DSP within half a minute with no manual step.
 *
 * Always follows whatever DSP_API_URL is currently set in .env.local — right
 * now that's local DSP. Do not repoint .env.local at production and leave
 * this running without explicit sign-off; it'll push there automatically.
 *
 * Stop anytime with Ctrl+C.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
const SECRET = process.env.CRON_SECRET;
const INTERVAL_MS = 30_000;

if (!SECRET) {
  console.error("CRON_SECRET not set in .env.local — refusing to start.");
  process.exit(1);
}

async function tick() {
  try {
    const res = await fetch(`${APP_URL}/api/cron/support-sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const body = await res.json();
    if (body.skipped) {
      console.log(`[support-sync] skipped — ${body.reason}`);
      return;
    }
    if ((body.sent ?? 0) > 0 || (body.failed ?? 0) > 0) {
      console.log(`[support-sync] ${new Date().toISOString()} sent=${body.sent} failed=${body.failed}`, body.errors?.length ? body.errors : "");
    }
  } catch (err) {
    console.error(`[support-sync] tick failed:`, err.message);
  }
}

console.log(`[support-sync] polling ${APP_URL}/api/cron/support-sync every ${INTERVAL_MS / 1000}s against DSP_API_URL=${process.env.DSP_API_URL} — Ctrl+C to stop`);
tick();
setInterval(tick, INTERVAL_MS);
