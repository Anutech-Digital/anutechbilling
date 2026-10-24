/**
 * IST dates — ek jagah (S21, 28 Sep 2026). AGENTS.md §6.
 *
 * `new Date().toISOString().slice(0, 10)` UTC ki tareekh deta hai. IST = UTC+5:30, to raat
 * 00:00 se 05:30 IST tak wo KAL ki tareekh hai: "aaj ke leads" khaali, due-today "overdue",
 * aur 1 April ki subah naya FY abhi purana. Cloud Run UTC me chalta hai aur browser ka
 * toISOString bhi UTC — dono jagah same galti.
 *
 * Pehle yahi logic ~47 jagah copy tha (`Date.now() + 5.5 * 60 * 60 * 1000`, `330 * 60_000`,
 * `Intl … Asia/Kolkata`). Naya code yahin se le; lint rule naya naive `toISOString().slice(0, 10)`
 * Pardeep ke areas me pakadta hai (eslint.config / .eslintrc — "no-naive-utc-date").
 *
 * Fixed offset jaan-boojhkar: India me DST nahi hai (1945 se), aur arithmetic Intl se tez
 * hai aur har runtime me ek jaisa. Tests Intl("Asia/Kolkata") se cross-check karte hain.
 *
 * Sab functions `YYYY-MM-DD` strings lete/dete hain — wahi shape jo Postgres `date` column
 * aur `<input type="date">` use karte hain.
 */

export const IST_OFFSET_MS = 330 * 60_000;

/** R-275: pass as `timeZone` to every toLocale…String that shows a date or time, so a
 *  device on another zone (or a UTC server render) still prints India time. */
export const IST_TZ = "Asia/Kolkata";
const DAY_MS = 86_400_000;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Instant ko IST wall-clock me shift karo; phir getUTC* = IST parts. */
function shifted(at: Date | number | string): Date {
  const t = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  return new Date(t + IST_OFFSET_MS);
}

/** IST calendar date (YYYY-MM-DD) of an instant. `toIstDate(new Date())` = aaj. */
export function toIstDate(at: Date | number | string): string {
  const s = shifted(at);
  return `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`;
}

/**
 * Ek aisi Date ki tareekh jo UTC parts se BANI hai (`new Date("2026-09-01T00:00:00Z")`,
 * `Date.UTC(y, m, 0)`, ya pehle se IST-shifted Date) — yahan koi timezone shift nahi chahiye.
 * `d.toISOString().slice(0, 10)` ka naam wala roop: lint rule raw form ko pakadta hai, ye
 * function batata hai ki "haan, ye jaan-boojhkar UTC calendar date hai". Instant (abhi ka
 * waqt) ke liye `toIstDate` use karo, ye nahi.
 */
export function utcDateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Aaj ki tareekh IST me, YYYY-MM-DD. */
export function istToday(now: Date = new Date()): string {
  return toIstDate(now);
}

/** Aaj ka mahina IST me, YYYY-MM. */
export function istMonth(now: Date = new Date()): string {
  return istToday(now).slice(0, 7);
}

/** IST wall clock ke hisse — cron "abhi IST me kitne baje" poochhe to. */
export function istParts(now: Date = new Date()): { date: string; year: number; month: number; day: number; hour: number; minute: number; minutesOfDay: number } {
  const s = shifted(now);
  const hour = s.getUTCHours(), minute = s.getUTCMinutes();
  return {
    date: toIstDate(now), year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate(),
    hour, minute, minutesOfDay: hour * 60 + minute,
  };
}

/**
 * R-178 (6 Oct 2026): the dashboard greeting by the IST hour. It used `new Date().getHours()`,
 * which is UTC on the server and IST in the browser, so the server rendered "Good afternoon"
 * and the browser "Good morning" — React error #418 on every load, and AI Help turned red.
 */
export function istGreeting(now: Date = new Date()): "Good morning" | "Good afternoon" | "Good evening" {
  const { hour } = istParts(now);
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** YYYY-MM-DD + n din (calendar arithmetic, timezone-free). */
export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Do YYYY-MM-DD ke beech kitne din (b − a). */
export function daysBetweenISO(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
}

/**
 * IST midnight ka UTC instant — timestamptz column ko "IST ke is din" se filter karna ho to.
 * `istDayStartUtc("2026-09-28")` = 2026-09-27T18:30:00.000Z.
 */
export function istDayStartUtc(iso: string): Date {
  return new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - IST_OFFSET_MS);
}

// ── Indian financial year (April → March) ─────────────────────────────

/*
 * R-1609 (19 Oct 2026): this is the ONE place the April-FY rule is written. ~20 files used to
 * hand-roll `m >= 4 ? y : y - 1`; they now call these. A string is read as a calendar date
 * ("YYYY-MM-DD", or a "YYYY-MM" period) with no timezone shift; a Date is read in IST.
 */

/** FY ka start saal: 2026-03-31 → 2025, 2026-04-01 → 2026. "YYYY-MM" bhi chalta hai. Date do to IST me padhte hain. */
export function fyStartYear(at: string | Date = new Date()): number {
  const iso = typeof at === "string" ? at.slice(0, 10) : toIstDate(at);
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  return m >= 4 ? y : y - 1;
}

/** 1 April of the FY a date falls in: "2026-02-10" → "2025-04-01". */
export function fyStartISO(at: string | Date = new Date()): string {
  return `${fyStartYear(at)}-04-01`;
}

/**
 * The one FY label format: "2026-27" for start year 2026 — what GST / ITR / TDS forms, the
 * depreciation schedule and the Form 16 CSV print. Screens that want "FY 2026-27" prefix it.
 */
export function fyLabelOfYear(startYear: number): string {
  return `${startYear}-${pad2((startYear + 1) % 100)}`;
}

/** "FY2627" for start year 2026 — the `tds_receivable.fiscal_year` column's stored code. */
export function fyCodeOfYear(startYear: number): string {
  return `FY${pad2(startYear % 100)}${pad2((startYear + 1) % 100)}`;
}

/** "2026-27" style label (GST / ITR / TDS forms isi tarah likhte hain). */
export function fyLabel(at: string | Date = new Date()): string {
  return fyLabelOfYear(fyStartYear(at));
}

/** FY ki pehli aur aakhri tareekh: { start: "2026-04-01", end: "2027-03-31" }. */
export function fyBounds(at: string | Date = new Date()): { start: string; end: string; startYear: number } {
  const y = fyStartYear(at);
  return { start: `${y}-04-01`, end: `${y + 1}-03-31`, startYear: y };
}

// ── Month bounds ───────────────────────────────────────────────────────

/**
 * Mahine ki seema. "2026-09" ya "2026-09-17" dono chalte hain.
 * { start: "2026-09-01", end: "2026-09-30", nextStart: "2026-10-01" } — query me `gte start`
 * aur `lt nextStart` likho, `lte end` nahi (timestamp columns par end-of-day chhoot jata hai).
 */
export function monthBounds(monthOrDate: string = istMonth()): { start: string; end: string; nextStart: string } {
  const y = Number(monthOrDate.slice(0, 4)), m = Number(monthOrDate.slice(5, 7));
  const start = `${y}-${pad2(m)}-01`;
  const next = new Date(Date.UTC(y, m, 1));
  const nextStart = next.toISOString().slice(0, 10);
  return { start, end: addDaysISO(nextStart, -1), nextStart };
}

// ── Formatting ─────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "28 Sep 2026" — IST me. YYYY-MM-DD string ko calendar date maana jata hai (koi shift nahi);
 * Date / timestamp string ko pehle IST me badla jata hai.
 */
/**
 * R-275: "02:30 pm" — the IST clock time of an instant. "" for null or an unparseable value.
 */
export function formatIstTime(at: string | Date | number | null | undefined): string {
  if (at === null || at === undefined || at === "") return "";
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: IST_TZ });
}

export function formatIstDate(at: string | Date | number): string {
  const iso = typeof at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : toIstDate(at);
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * R-1139: "Oct 2026" for a "2026-10" (or "2026-10-17") month — built from the numbers, so the
 * viewer's time zone can never move it. (`new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(…)`
 * without timeZone showed "Sep" for October on a device west of UTC.)
 * `{ year: "2-digit" }` → "Oct 26" (chart axes); `{ month: "long" }` → "October 2026".
 * Anything that is not a YYYY-MM month comes back unchanged.
 */
export function formatMonthLabel(
  ym: string,
  opts: { month?: "short" | "long"; year?: "numeric" | "2-digit" } = {},
): string {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(ym);
  if (!match) return ym;
  const m = Number(match[2]);
  if (m < 1 || m > 12) return ym;
  const name = (opts.month === "long" ? MONTHS_LONG : MONTHS)[m - 1];
  const year = opts.year === "2-digit" ? match[1].slice(2) : match[1];
  return `${name} ${year}`;
}
