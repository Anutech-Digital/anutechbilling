/** R-722: the pure pieces of "a deactivated member gets nothing". */
import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import { clearLoginCookies, isActiveOwner, isDeactivated, isLoginCookie } from "./deactivated";

describe("isDeactivated", () => {
  it("only an explicit is_active = false counts", () => {
    expect(isDeactivated({ is_active: false })).toBe(true);
    expect(isDeactivated({ is_active: true })).toBe(false);
    // no users row (new signup on /welcome, apprentice) or a failed lookup: other gates decide
    expect(isDeactivated(null)).toBe(false);
    expect(isDeactivated(undefined)).toBe(false);
    expect(isDeactivated({})).toBe(false);
  });
});

describe("isDeactivated — R-1896 login end date (employee exit)", () => {
  it("works through access_ends_on (IST), off from the next day", () => {
    const row = { is_active: true, access_ends_on: "2026-10-15" };
    expect(isDeactivated(row, new Date("2026-10-14T06:00:00Z"))).toBe(false);
    expect(isDeactivated(row, new Date("2026-10-15T06:00:00Z"))).toBe(false);
    expect(isDeactivated(row, new Date("2026-10-16T06:00:00Z"))).toBe(true);
  });
  it("no end date → unchanged", () => {
    expect(isDeactivated({ is_active: true, access_ends_on: null }, new Date("2026-10-16T06:00:00Z"))).toBe(false);
  });
  it("uses the IST day — 15 Oct 23:00 UTC is already 16 Oct in India", () => {
    const row = { is_active: true, access_ends_on: "2026-10-15" };
    expect(isDeactivated(row, new Date("2026-10-15T23:00:00Z"))).toBe(true);
    expect(isDeactivated(row, new Date("2026-10-15T12:00:00Z"))).toBe(false);
  });
});

describe("isActiveOwner", () => {
  it("owner + active only", () => {
    expect(isActiveOwner({ role: "owner", is_active: true })).toBe(true);
    expect(isActiveOwner({ role: "owner", is_active: false })).toBe(false);
    expect(isActiveOwner({ role: "manager", is_active: true })).toBe(false);
    expect(isActiveOwner(null)).toBe(false);
  });
});

describe("login cookies", () => {
  it("recognises Auth.js (plain, __Secure-, chunked) and GoTrue cookies, nothing else", () => {
    for (const n of ["authjs.session-token", "__Secure-authjs.session-token", "__Secure-authjs.session-token.0",
      "authjs.csrf-token", "__Host-authjs.csrf-token", "sb-abc-auth-token", "next-auth.session-token"]) {
      expect(isLoginCookie(n)).toBe(true);
    }
    for (const n of ["theme", "ros_demo", "NEXT_LOCALE", "authjs"]) expect(isLoginCookie(n)).toBe(false);
  });

  it("clearLoginCookies expires only the login cookies", () => {
    const res = clearLoginCookies(NextResponse.next(), ["__Secure-authjs.session-token", "theme", "sb-x-auth-token"]);
    const set = res.headers.getSetCookie();
    expect(set.map((c) => c.split("=")[0]).sort()).toEqual(["__Secure-authjs.session-token", "sb-x-auth-token"]);
    expect(set.every((c) => /max-age=0/i.test(c))).toBe(true);
    expect(set.find((c) => c.startsWith("__Secure-"))).toMatch(/secure/i);
  });
});
