import { describe, it, expect } from "vitest";
import {
  accuracyM, coord, describeDistance, distanceM, insideOffice, markErrorReply,
  officeLocationSchema, parseOfficeLocation,
} from "./geofence";

/* R-438 — must agree with the SQL test (supabase/tests/attendance_geofence.test.sql). */
const office = { lat: 28.6139, lng: 77.2090, radiusM: 150 };

describe("R-438 geofence arithmetic", () => {
  it("0.0051° east in Delhi is ~498 m (same as attendance_distance_m)", () => {
    expect(Math.round(distanceM(28.6139, 77.2090, 28.6139, 77.2141))).toBe(498);
  });
  it("inside / outside the 150 m circle", () => {
    expect(insideOffice(office, { lat: 28.61395, lng: 77.20905, accuracyM: 15 }).inside).toBe(true);
    expect(insideOffice(office, { lat: 28.6139, lng: 77.2141, accuracyM: 10 }).inside).toBe(false);
  });
  it("a weak fix widens the circle by at most 100 m", () => {
    expect(insideOffice(office, { lat: 28.6139, lng: 77.21105, accuracyM: 80 }).inside).toBe(true);   // ~200 m
    expect(insideOffice(office, { lat: 28.6139, lng: 77.2141, accuracyM: 5000 }).inside).toBe(false);  // ~498 m, capped at +100
  });
  it("distance words match the SQL refusal ('about 500 m')", () => {
    expect(describeDistance(498)).toBe("500 m");
    expect(describeDistance(37)).toBe("40 m");
    expect(describeDistance(2349)).toBe("2.3 km");
  });
});

describe("R-438 request input", () => {
  it("coordinates outside the globe or not numbers are treated as no location", () => {
    expect(coord(28.6, 90)).toBe(28.6);
    expect(coord(91, 90)).toBeNull();
    expect(coord("28.6", 90)).toBeNull();
    expect(coord(Number.NaN, 180)).toBeNull();
    expect(accuracyM(-1)).toBeNull();
    expect(accuracyM(25)).toBe(25);
  });
});

describe("R-438 what the owner may save", () => {
  it("a location with any mode", () => {
    expect(officeLocationSchema.safeParse({ lat: 28.6, lng: 77.2, radiusM: 150, mode: "block" }).success).toBe(true);
  });
  it("turning it on without a location is refused; off without one is fine", () => {
    expect(officeLocationSchema.safeParse({ lat: null, lng: null, radiusM: 150, mode: "flag" }).success).toBe(false);
    expect(officeLocationSchema.safeParse({ lat: null, lng: null, radiusM: 150, mode: "off" }).success).toBe(true);
  });
  it("radius 25–5000 m, whole metres", () => {
    expect(officeLocationSchema.safeParse({ lat: 1, lng: 1, radiusM: 10, mode: "flag" }).success).toBe(false);
    expect(officeLocationSchema.safeParse({ lat: 1, lng: 1, radiusM: 150.5, mode: "flag" }).success).toBe(false);
  });
  it("a workspace that never set it reads as off, 150 m", () => {
    expect(parseOfficeLocation(null)).toEqual({ lat: null, lng: null, radiusM: 150, mode: "off" });
    expect(parseOfficeLocation({ office_lat: 1, office_lng: 2, office_radius_m: 300, geofence_mode: "block" }))
      .toEqual({ lat: 1, lng: 2, radiusM: 300, mode: "block" });
    expect(parseOfficeLocation({ geofence_mode: "weird" }).mode).toBe("off");
  });
});

describe("R-438 database refusal → reply", () => {
  it("outside the office → 403 with the database's distance message", () => {
    const r = markErrorReply({ message: "You are about 500 m from the office — attendance can only be marked within 150 m of it.", code: "P0001", hint: "outside_office" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: expect.stringContaining("about 500 m"), code: "OUTSIDE_OFFICE" });
  });
  it("no location → 403 NO_LOCATION; office code → 400; locked → 429; no company → 403", () => {
    expect(markErrorReply({ message: "x", hint: "no_location" })).toMatchObject({ status: 403, body: { code: "NO_LOCATION" } });
    expect(markErrorReply({ message: "x", hint: "presence_code" })).toMatchObject({ status: 400, body: { code: "PRESENCE_CODE_WRONG" } });
    expect(markErrorReply({ message: "PRESENCE_CODE_LOCKED", hint: "Try after 10:15 IST." })).toMatchObject({ status: 429, body: { error: "Try after 10:15 IST." } });
    expect(markErrorReply({ message: "No company", code: "28000" })).toMatchObject({ status: 403, body: { code: "NO_COMPANY" } });
  });
  it("any other error keeps the old 400 + message", () => {
    expect(markErrorReply({ message: "Pehle apna employee link karo." })).toEqual({ status: 400, body: { error: "Pehle apna employee link karo." } });
  });
});
