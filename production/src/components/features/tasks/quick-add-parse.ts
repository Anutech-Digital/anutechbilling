/**
 * R-354 — the /tasks quick-add bar: "Call Amit tomorrow 3 PM" → title + due time (IST).
 *
 * Understands: today / aaj, tomorrow / kal, day after tomorrow / parso, weekday names
 * (full names anywhere; short ones like "fri" only after "on" / "next"), and a time
 * as "3 PM", "3:30pm", "at 11 am" or 24-hour "15:00". Whatever is not understood stays
 * in the title. Nothing understood → today 6 PM (tomorrow 6 PM once 6 PM has passed),
 * and `understood` says so, so the bar can show the operator what will be saved.
 *
 * Pure: `now` is passed in; every calendar step goes through lib/dates/ist.
 */
import { addDaysISO, istDayStartUtc, istParts, istToday } from "@/lib/dates/ist";
import type { TaskKind } from "@/lib/supabase/database.types";

export interface QuickAddParse {
  title: string;
  kind: TaskKind;
  dueAt: Date;
  /** Which parts came from the text — false parts were filled with the default. */
  understood: { date: boolean; time: boolean };
}

export const QUICK_ADD_DEFAULT_MINUTES = 18 * 60; // 6 PM IST

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const FULL_DAY = "sunday|monday|tuesday|wednesday|thursday|friday|saturday";
const SHORT_DAY = "sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat";

const KIND_WORDS: [RegExp, TaskKind][] = [
  [/^(call|phone|ring)\b/i, "call"],
  [/^(e-?mail|mail)\b/i, "email"],
  [/^(meet|meeting|demo|visit)\b/i, "meeting"],
];

/** Remove the first match of `re` from `s`; returns [rest, match | null]. */
function take(s: string, re: RegExp): [string, RegExpMatchArray | null] {
  const m = s.match(re);
  if (!m || m.index === undefined) return [s, null];
  return [`${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`, m];
}

export function parseQuickAdd(text: string, now: Date = new Date()): QuickAddParse {
  let rest = ` ${text.trim()} `;
  const today = istToday(now);
  let dateISO: string | null = null;
  let minutes: number | null = null;

  // ── time ──
  let m: RegExpMatchArray | null;
  [rest, m] = take(rest, /\s(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)(?=[\s,.!?]|$)/i);
  if (m) {
    const h12 = Number(m[1]);
    const mm = Number(m[2] ?? 0);
    if (h12 >= 1 && h12 <= 12) {
      const pm = m[3].toLowerCase().startsWith("p");
      minutes = ((h12 % 12) + (pm ? 12 : 0)) * 60 + mm;
    }
  } else {
    [rest, m] = take(rest, /\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=[\s,.!?]|$)/);
    if (m) minutes = Number(m[1]) * 60 + Number(m[2]);
  }

  // ── date ──
  [rest, m] = take(rest, /\s(?:day after tomorrow|parso|parson)(?=[\s,.!?]|$)/i);
  if (m) dateISO = addDaysISO(today, 2);
  if (!dateISO) {
    [rest, m] = take(rest, /\s(?:tomorrow|tmrw|tmr|kal)(?=[\s,.!?]|$)/i);
    if (m) dateISO = addDaysISO(today, 1);
  }
  if (!dateISO) {
    [rest, m] = take(rest, /\s(?:today|aaj|tonight)(?=[\s,.!?]|$)/i);
    if (m) dateISO = today;
  }
  if (!dateISO) {
    [rest, m] = take(rest, new RegExp(`\\s(?:(on|next)\\s+(${FULL_DAY}|${SHORT_DAY})|(${FULL_DAY}))(?=[\\s,.!?]|$)`, "i"));
    if (m) {
      const name = (m[2] ?? m[3]).toLowerCase();
      const target = WEEKDAYS[name];
      const cur = new Date(`${today}T00:00:00Z`).getUTCDay();
      let diff = (target - cur + 7) % 7;
      if (diff === 0 && m[1]?.toLowerCase() === "next") diff = 7;
      dateISO = addDaysISO(today, diff);
    }
  }

  const understood = { date: dateISO !== null, time: minutes !== null };
  const nowMinutes = istParts(now).minutesOfDay;
  if (!dateISO) {
    // No day given: today, unless that moment has already gone — then tomorrow.
    const at = minutes ?? QUICK_ADD_DEFAULT_MINUTES;
    dateISO = at <= nowMinutes ? addDaysISO(today, 1) : today;
  }
  const dueAt = new Date(istDayStartUtc(dateISO).getTime() + (minutes ?? QUICK_ADD_DEFAULT_MINUTES) * 60_000);

  const title = rest
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(at|on|by|for)$/i, "")
    .replace(/[\s,;:-]+$/, "")
    .trim();
  const kind = KIND_WORDS.find(([re]) => re.test(title))?.[1] ?? "followup";

  return { title, kind, dueAt, understood };
}
