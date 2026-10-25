/** R-1896 — the middleware reads access_ends_on, and survives a database without it. */
import { describe, it, expect, vi } from "vitest";
import { readSessionUser, isMissingColumnError, SESSION_USER_COLUMNS, SESSION_USER_COLUMNS_LEGACY } from "./session-user";
import { isDeactivated } from "./deactivated";

describe("readSessionUser", () => {
  it("reads access_ends_on, so an ex-employee's session is ended the day after the last day", async () => {
    const read = vi.fn(async () => ({ data: { role: "sales", is_active: true, access_ends_on: "2026-10-15" }, error: null }));
    const { data } = await readSessionUser(read);
    expect(read).toHaveBeenCalledWith(SESSION_USER_COLUMNS);
    expect(isDeactivated(data, new Date("2026-10-16T06:00:00Z"))).toBe(true);
  });

  it("column not there yet (code before migration) → retries with the old columns, keeps the role", async () => {
    const read = vi.fn(async (cols: string) => cols === SESSION_USER_COLUMNS
      ? { data: null, error: { code: "42703", message: "column users.access_ends_on does not exist" } }
      : { data: { role: "sales", is_active: true }, error: null });
    const { data, error } = await readSessionUser(read);
    expect(read).toHaveBeenLastCalledWith(SESSION_USER_COLUMNS_LEGACY);
    expect(error).toBeNull();
    expect(data?.role).toBe("sales");
  });

  it("any other error is returned as is (no silent retry)", async () => {
    const read = vi.fn(async () => ({ data: null, error: { code: "08006", message: "connection failure" } }));
    const { error } = await readSessionUser(read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(error?.code).toBe("08006");
  });

  it("isMissingColumnError", () => {
    expect(isMissingColumnError({ code: "PGRST204" })).toBe(true);
    expect(isMissingColumnError({ message: "Could not find the 'access_ends_on' column of 'users'" })).toBe(true);
    expect(isMissingColumnError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
  });
});
