/**
 * R-2689 / R-2690 / R-2691 (G-SOCIAL): pure rules for comment replies, follower tracking + the
 * weekly report, and the daily to-do list. No database, no network (social-engagement.test.ts).
 */
import { utcDateISO } from "@/lib/dates/ist";

// ── R-2690: followers ───────────────────────────────────────────────────────────────────────

export type FollowerPlatform = "facebook" | "instagram" | "linkedin";
export interface FollowerRow { platform: FollowerPlatform; day: string; followers: number }
export interface FollowerTrend { now: number | null; change7: number | null; change30: number | null; series: { day: string; followers: number }[] }

const dayMinus = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return utcDateISO(d);
};

/** Latest count, change over 7 and 30 days (from the closest earlier snapshot), last 30 days' series. */
export function followerTrend(rows: readonly FollowerRow[], platform: FollowerPlatform, today: string): FollowerTrend {
  const mine = rows.filter((r) => r.platform === platform && r.day <= today).sort((a, b) => a.day.localeCompare(b.day));
  if (!mine.length) return { now: null, change7: null, change30: null, series: [] };
  const last = mine[mine.length - 1];
  const before = (n: number) => [...mine].reverse().find((r) => r.day <= dayMinus(today, n));
  const w = before(7);
  const m = before(30);
  return {
    now: last.followers,
    change7: w ? last.followers - w.followers : null,
    change30: m ? last.followers - m.followers : null,
    series: mine.filter((r) => r.day > dayMinus(today, 30)).map((r) => ({ day: r.day, followers: r.followers })),
  };
}

/** Monday (India date) of the week `day` is in — the key of a weekly report. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return dayMinus(day, back);
}

// ── R-2689: comments ────────────────────────────────────────────────────────────────────────

export const COMMENT_KINDS = ["question", "praise", "complaint", "spam", "other"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];
export type CommentMode = "off" | "ask" | "auto";

export function normaliseKind(v: unknown): CommentKind {
  const s = String(v ?? "").toLowerCase().trim();
  return (COMMENT_KINDS as readonly string[]).includes(s) ? s as CommentKind : "other";
}

/**
 * May the AI send this reply without a person? Only on Autopilot, never for a complaint (a person
 * answers those) and never for spam (nothing is sent; a person may hide it).
 */
export function aiMaySend(mode: CommentMode, kind: CommentKind, aiPaused: boolean): boolean {
  return mode === "auto" && !aiPaused && (kind === "question" || kind === "praise" || kind === "other");
}

/** A reply the platform will take: trimmed, no links the AI invented, at most 800 characters. */
export function cleanReply(text: unknown): string {
  return String(text ?? "").replace(/https?:\/\/\S+/g, "").replace(/[ \t]+/g, " ").trim().slice(0, 800);
}

/** Comments are checked at most this often per company (the publish cron runs every 10 minutes). */
export const COMMENT_CHECK_MINUTES = 25;

// ── R-2691: the daily to-do list ────────────────────────────────────────────────────────────

export interface TodoItem { id: string; text: string; why: string; done: boolean; doneAt?: string | null; doneBy?: string | null }
export const TODO_COUNT = 5;

/** Things that grow an audience but that Meta / LinkedIn do not let software do — a person does them. */
export const FALLBACK_TODO: readonly { text: string; why: string }[] = [
  { text: "Invite people who reacted to your latest Facebook post to like the Page", why: "People who already reacted are the easiest new followers." },
  { text: "Share today's post on your own Facebook / LinkedIn profile with one line about why it matters", why: "Your network sees it first; the Page's reach grows from there." },
  { text: "Like and leave a helpful comment on 3 posts from customers or local business pages", why: "Real comments from the Page bring visitors back to it." },
  { text: "Send today's post to 2 WhatsApp groups where your customers are", why: "Groups bring clicks and new followers fast." },
  { text: "Post a real photo from your office or a customer visit as an Instagram Story", why: "Stories with real people build trust; software may not take the photo for you." },
];

export function normaliseTodo(raw: unknown, idPrefix: string): TodoItem[] {
  const list = (Array.isArray(raw) ? raw : []).flatMap((r) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const text = String(o.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const why = String(o.why ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    return text ? [{ text, why }] : [];
  });
  const filled = [...list, ...FALLBACK_TODO.filter((f) => !list.some((l) => l.text === f.text))].slice(0, TODO_COUNT);
  return filled.map((t, i) => ({ id: `${idPrefix}-${i + 1}`, text: t.text, why: t.why, done: false }));
}

/** Tick or untick one item; unknown ids change nothing. */
export function tickTodo(items: readonly TodoItem[], id: string, done: boolean, by: string, at: string): TodoItem[] {
  return items.map((t) => (t.id === id ? { ...t, done, doneAt: done ? at : null, doneBy: done ? by : null } : t));
}
