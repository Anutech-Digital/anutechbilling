import { describe, it, expect } from "vitest";
import { istTimeToIso, isoToIstHhmm, buildCorrection } from "./ist-time";

describe("istTimeToIso", () => {
  it("converts IST wall time to UTC instant", () => {
    expect(istTimeToIso("2026-10-09", "09:30")).toBe("2026-10-09T04:00:00.000Z");
  });
  it("early morning IST falls on the previous UTC day", () => {
    expect(istTimeToIso("2026-10-09", "02:00")).toBe("2026-10-08T20:30:00.000Z");
  });
  it("rejects bad input", () => {
    expect(istTimeToIso("2026-10-09", "24:00")).toBeNull();
    expect(istTimeToIso("2026-10-09", "9:30")).toBeNull();
    expect(istTimeToIso("09-10-2026", "09:30")).toBeNull();
    expect(istTimeToIso("2026-10-09", "")).toBeNull();
  });
});

describe("isoToIstHhmm", () => {
  it("round-trips", () => {
    expect(isoToIstHhmm("2026-10-09T04:00:00.000Z")).toBe("09:30");
    expect(isoToIstHhmm("2026-10-08T20:30:00Z")).toBe("02:00");
  });
  it("empty for null", () => {
    expect(isoToIstHhmm(null)).toBe("");
  });
});

describe("buildCorrection", () => {
  it("needs a note", () => {
    expect(buildCorrection("save", "2026-10-09", "09:30", "", " a ")).toEqual({ ok: false, error: "Write a short note (why)." });
    expect(buildCorrection("absent", "2026-10-09", "", "", "")).toMatchObject({ ok: false });
  });
  it("absent sends both null", () => {
    expect(buildCorrection("absent", "2026-10-09", "09:30", "18:00", "On leave")).toEqual({ ok: true, checkIn: null, checkOut: null });
  });
  it("save needs check in; check out optional", () => {
    expect(buildCorrection("save", "2026-10-09", "", "18:00", "Missed punch")).toMatchObject({ ok: false });
    expect(buildCorrection("save", "2026-10-09", "09:30", "", "Missed punch"))
      .toEqual({ ok: true, checkIn: "2026-10-09T04:00:00.000Z", checkOut: null });
  });
  it("check out must be after check in", () => {
    expect(buildCorrection("save", "2026-10-09", "18:00", "09:00", "Wrong")).toMatchObject({ ok: false });
    expect(buildCorrection("save", "2026-10-09", "09:00", "18:00", "Forgot checkout"))
      .toEqual({ ok: true, checkIn: "2026-10-09T03:30:00.000Z", checkOut: "2026-10-09T12:30:00.000Z" });
  });
});
