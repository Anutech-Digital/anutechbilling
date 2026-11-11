/**
 * R-2672 (G-SOCIAL): the week the AI plans. Pure — the cron, the "Plan this week now" button and
 * the tests share it.
 *
 * - `planSlots(now, count)`: `count` post times over the next 7 India days (from tomorrow), spread
 *   evenly, alternating 9 AM and 6 PM IST — the two times the form offers.
 * - `pictureFor(urls, i)`: the pictures the owner listed, in turn (Instagram needs one).
 * - `planStatus(autopilot)`: autopilot posts are approved at once (they go out at their time);
 *   otherwise they wait in "Waiting for approval".
 */
import { parseIstLocal } from "./social-schedule";

const IST_OFFSET_MS = 330 * 60_000;
const p2 = (n: number) => String(n).padStart(2, "0");

export const MIN_POSTS_PER_WEEK = 1;
export const MAX_POSTS_PER_WEEK = 7;
export const MAX_PICTURES = 30;

export function planSlots(now: Date, count: number): Date[] {
  const n = Math.max(MIN_POSTS_PER_WEEK, Math.min(MAX_POSTS_PER_WEEK, Math.round(count)));
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    // Days 1..7 after today, spread: 3 posts → days 1, 3, 5 (Tue/Thu/Sat from a Monday).
    const dayOffset = 1 + Math.floor((i * 7) / n);
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + dayOffset));
    const hour = i % 2 === 0 ? "09" : "18";
    out.push(parseIstLocal(`${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${hour}:00`)!);
  }
  return out;
}

export function pictureFor(urls: readonly string[], i: number): string | null {
  return urls.length ? urls[i % urls.length] : null;
}

export function planStatus(autopilot: boolean): "approved" | "review" {
  return autopilot ? "approved" : "review";
}

/** One link per line → the public https picture links, at most MAX_PICTURES, no repeats. */
export function parsePictureLinks(text: string): { urls: string[]; bad: string[] } {
  const urls: string[] = []; const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    let ok = false;
    try { const u = new URL(line); ok = u.protocol === "https:" && line.length <= 2000; } catch { ok = false; }
    if (!ok) bad.push(line);
    else if (!urls.includes(line)) urls.push(line);
  }
  return { urls: urls.slice(0, MAX_PICTURES), bad };
}
