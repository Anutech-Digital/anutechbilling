/**
 * R-438 — office location (geofence) for self check-in. Pure: no I/O.
 *
 * The decision that counts is made in the database (mark_self_attendance, migration
 * 20261010233000_attendance_geofence.sql) so it cannot be skipped. This file holds the same
 * arithmetic for the owner's settings row ("this phone is 37 m from the saved office"), the
 * input checks for what the owner saves, and the mapping of the database's refusal to the
 * route's reply.
 */
import { z } from "zod";

export const GEOFENCE_MODES = ["off", "flag", "block"] as const;
export type GeofenceMode = (typeof GEOFENCE_MODES)[number];

export const DEFAULT_RADIUS_M = 150;

/** Same rule as the SQL: up to this much of the phone's reported accuracy widens the circle. */
export const MAX_ACCURACY_ALLOWANCE_M = 100;

/** Great-circle distance in metres (haversine) — same formula as attendance_distance_m(). */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Would a phone at this point (with this accuracy) count as inside the office circle? */
export function insideOffice(
  office: { lat: number; lng: number; radiusM: number },
  phone: { lat: number; lng: number; accuracyM?: number | null },
): { inside: boolean; distanceM: number } {
  const d = distanceM(office.lat, office.lng, phone.lat, phone.lng);
  const allowance = Math.min(Math.max(phone.accuracyM ?? 0, 0), MAX_ACCURACY_ALLOWANCE_M);
  return { inside: d <= office.radiusM + allowance, distanceM: d };
}

/** "about 40 m" / "about 500 m" / "about 2.3 km" — same rounding as the SQL refusal. */
export function describeDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(Math.round(m / 100) / 10).toFixed(1)} km`;
}

/** A coordinate from a request body, or null when missing / not a finite number in range. */
export function coord(v: unknown, limit: 90 | 180): number | null {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit ? v : null;
}

/** The phone's reported accuracy in metres, or null. */
export function accuracyM(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000 ? v : null;
}

/** What the owner may save. Turning the check on requires a location. */
export const officeLocationSchema = z.object({
  lat:     z.number().min(-90).max(90).nullable(),
  lng:     z.number().min(-180).max(180).nullable(),
  radiusM: z.number().int("Use whole metres.").min(25, "The circle must be at least 25 m.").max(5000, "The circle can be at most 5000 m."),
  mode:    z.enum(GEOFENCE_MODES),
}).refine((v) => v.mode === "off" || (v.lat !== null && v.lng !== null), {
  message: "Set the office location first, then turn the check on.",
  path: ["mode"],
});
export type OfficeLocationInput = z.infer<typeof officeLocationSchema>;

export type OfficeLocation = {
  lat: number | null;
  lng: number | null;
  radiusM: number;
  mode: GeofenceMode;
};

/** Settings row → OfficeLocation, with safe defaults for a workspace that never set one. */
export function parseOfficeLocation(row: {
  office_lat?: number | null; office_lng?: number | null;
  office_radius_m?: number | null; geofence_mode?: string | null;
} | null | undefined): OfficeLocation {
  const mode = (GEOFENCE_MODES as readonly string[]).includes(row?.geofence_mode ?? "")
    ? (row!.geofence_mode as GeofenceMode) : "off";
  return {
    lat: row?.office_lat ?? null,
    lng: row?.office_lng ?? null,
    radiusM: row?.office_radius_m ?? DEFAULT_RADIUS_M,
    mode,
  };
}

/**
 * mark_self_attendance's refusal → the route's reply. The database sets the hint:
 * outside_office / no_location (geofence, 403) and presence_code (office code, 400). A login
 * with no company (28000) is 403. Anything else stays the old 400 with the database message.
 */
export function markErrorReply(err: { message?: string; code?: string; hint?: string | null }): {
  status: number; body: { error: string; code?: string };
} {
  const message = err.message || "Attendance could not be marked. Try again.";
  if (err.hint === "outside_office" || err.hint === "no_location") {
    return { status: 403, body: { error: message, code: err.hint === "outside_office" ? "OUTSIDE_OFFICE" : "NO_LOCATION" } };
  }
  if (err.message === "PRESENCE_CODE_LOCKED") {
    return { status: 429, body: { error: err.hint || "Too many wrong office codes. Try again in 15 minutes.", code: "PRESENCE_CODE_LOCKED" } };
  }
  if (err.hint === "presence_code") return { status: 400, body: { error: message, code: "PRESENCE_CODE_WRONG" } };
  if (err.code === "28000") return { status: 403, body: { error: message, code: "NO_COMPANY" } };
  return { status: 400, body: { error: message } };
}
