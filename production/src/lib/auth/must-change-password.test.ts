/**
 * R-391: the must-change-password flag and the redirect target.
 */
import { describe, it, expect } from "vitest";
import { changePasswordUrl, mustChangePassword, safeNextPath } from "./must-change-password";

describe("mustChangePassword", () => {
  it("true only for app_metadata.must_change_password === true", () => {
    expect(mustChangePassword({ app_metadata: { must_change_password: true } })).toBe(true);
    expect(mustChangePassword({ app_metadata: { must_change_password: null } })).toBe(false);
    expect(mustChangePassword({ app_metadata: { must_change_password: "true" } })).toBe(false);
    expect(mustChangePassword({ app_metadata: {} })).toBe(false);
  });
  it("ignores user_metadata — the member can write that one themselves", () => {
    expect(mustChangePassword({ user_metadata: { must_change_password: true } })).toBe(false);
  });
  it("false for no user and for R-161's middleware user ({ id, email })", () => {
    expect(mustChangePassword(null)).toBe(false);
    expect(mustChangePassword({ id: "x", email: "a@b.c" })).toBe(false);
  });
});

describe("safeNextPath / changePasswordUrl", () => {
  it("keeps an in-app path with its query", () => {
    expect(safeNextPath("/payments?customer=abc")).toBe("/payments?customer=abc");
    expect(changePasswordUrl("/leads?x=1")).toBe("/change-password?next=%2Fleads%3Fx%3D1");
  });
  it("refuses open redirects and loops", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/change-password?next=/x", null, ""]) {
      expect(safeNextPath(bad)).toBe("/dashboard");
    }
    expect(changePasswordUrl("//evil.example")).toBe("/change-password");
  });
});
