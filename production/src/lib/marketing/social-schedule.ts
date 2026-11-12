/**
 * R-2510 (G-SOCIAL): the post time a person types is India time, whatever the browser's own
 * time zone is. The form sends the `datetime-local` text ("2026-11-06T09:00"); the server turns
 * it into a UTC instant here. Pure — shared by the route, the page and the tests.
 */

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const IST_OFFSET_MS = 330 * 60_000;

/** "2026-11-06T09:00" (IST) → Date, or null when the text is not a real date and time. */
export function parseIstLocal(value: string): Date | null {
  const m = LOCAL.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;
  const back = new Date(utc + IST_OFFSET_MS);
  // 2026-02-30 rolls over to March in Date.UTC — refuse it instead.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return null;
  return new Date(utc);
}

/** Date → the `datetime-local` text in IST, for putting a saved time back into the form. */
export function toIstLocal(at: Date | string): string {
  const t = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

/** "6 Nov 2026, 9:00 am" in IST — how the queue shows a post time. */
export function formatIst(at: Date | string): string {
  return new Date(at).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

/** A post time must be ahead of now and within a year — a typo like 2062 is refused. */
export function scheduleProblem(at: Date, now: Date = new Date()): string | null {
  if (at.getTime() <= now.getTime()) return "Choose a post time in the future.";
  if (at.getTime() - now.getTime() > 366 * 24 * 3600_000) return "Choose a post time within the next year.";
  return null;
}

/** Only an approved post with a time that has come is due. Drafts and posts in review never are. */
export function isDue(item: { status: string; scheduled_at: Date | string | null }, now: Date = new Date()): boolean {
  return item.status === "approved" && item.scheduled_at !== null && new Date(item.scheduled_at).getTime() <= now.getTime();
}

/** One-click post times for the form: tomorrow 9 AM and 6 PM, India time ("YYYY-MM-DDTHH:MM"). */
export function quickTimes(now: Date = new Date()): { tomorrowMorning: string; tomorrowEvening: string } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1));
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return { tomorrowMorning: `${day}T09:00`, tomorrowEvening: `${day}T18:00` };
}
