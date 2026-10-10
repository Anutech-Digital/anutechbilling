import { describe, it, expect } from "vitest";
import { presenceCode, currentWindow, PRESENCE_WINDOW_SEC } from "./presence";

/* R-440: the same vectors are asserted against public.presence_code_at() in
   supabase/tests/attendance_presence_code.test.sql. If either side changes, the kiosk would
   show a code that self check-in refuses — change both together. */
describe("presenceCode (kiosk) matches the database twin presence_code_at", () => {
  it.each([
    ["r440-test-seed", 0, "686024"],
    ["r440-test-seed", 39000000, "472419"],
    ["r440-test-seed", 39000001, "526338"],
    ["x".repeat(100), 12345, "363347"],
  ])("presenceCode(%s, %i) = %s", (secret, window, code) => {
    expect(presenceCode(secret, window)).toBe(code);
  });

  it("uses the same 45-second window as the database", () => {
    expect(PRESENCE_WINDOW_SEC).toBe(45);
    expect(currentWindow(45_000 * 7 + 44_999)).toBe(7);
  });
});
