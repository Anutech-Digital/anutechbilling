/**
 * IST wall-clock time ↔ instant, for the attendance "Fix attendance" dialog (R-603).
 *
 * The owner types "09:30" meaning India time, whatever zone the browser is in. So the
 * offset is written explicitly (+05:30) — never `new Date(y, m, d, h, min)`, which would
 * use the browser's zone. India has no DST, so the fixed offset is exact.
 */
import { IST_TZ } from "@/lib/dates/ist";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-10-09" + "09:30" (IST) → "2026-10-09T04:00:00.000Z". Null when either part is invalid. */
export function istTimeToIso(dateISO: string, hhmm: string): string | null {
  const t = hhmm.trim();
  if (!YMD.test(dateISO) || !HHMM.test(t)) return null;
  const ms = Date.parse(`${dateISO}T${t}:00+05:30`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** Instant → "HH:mm" in IST (for prefilling the time inputs). Empty string for null. */
export function isoToIstHhmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

export type CorrectionCheck =
  | { ok: true; checkIn: string | null; checkOut: string | null }
  | { ok: false; error: string };

/**
 * Validate the dialog before it calls the RPC (the RPC checks again).
 * mode "save" needs a check-in; "absent" sends both times null.
 */
export function buildCorrection(
  mode: "save" | "absent",
  dateISO: string,
  inHhmm: string,
  outHhmm: string,
  note: string,
): CorrectionCheck {
  if (note.trim().length < 3) return { ok: false, error: "Write a reason (why this is being corrected)." };
  if (mode === "absent") return { ok: true, checkIn: null, checkOut: null };
  const checkIn = istTimeToIso(dateISO, inHhmm);
  if (!checkIn) return { ok: false, error: "Enter a check in time." };
  if (!outHhmm.trim()) return { ok: true, checkIn, checkOut: null };
  const checkOut = istTimeToIso(dateISO, outHhmm);
  if (!checkOut) return { ok: false, error: "Check out time is not valid." };
  if (Date.parse(checkOut) <= Date.parse(checkIn)) return { ok: false, error: "Check out must be after check in." };
  return { ok: true, checkIn, checkOut };
}
