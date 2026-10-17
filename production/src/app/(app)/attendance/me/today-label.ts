/**
 * "Thursday, 16 October" in IST — built by hand, not via Intl (R-1471).
 *
 * This line is the only time-dependent text in the server-rendered HTML of /attendance/me.
 * `toLocaleDateString("en-IN", …)` gives different punctuation/order depending on the ICU
 * build (Cloud Run's Node vs the browser), so the hydrated text did not match the server
 * HTML and React threw #418. Plain arithmetic + fixed English names give byte-identical
 * output on both sides. Lives outside page.tsx because Next only allows page exports there.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function todayLabel(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return `${WEEKDAYS[ist.getUTCDay()]}, ${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}`;
}
