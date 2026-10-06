// R-281: the Local test login section shows only on dev:local in a localhost tab.
import { describe, it, expect } from "vitest";
import { localTestLoginVisible } from "./local-test-login";

describe("localTestLoginVisible", () => {
  it("shows on dev:local at localhost / 127.0.0.1 / [::1]", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]"]) expect(localTestLoginVisible("local", "development", h)).toBe(true);
  });
  it("hides on staging, live, a production build, or another host", () => {
    expect(localTestLoginVisible("staging", "development", "localhost")).toBe(false);
    expect(localTestLoginVisible("", "production", "reselleros.anutech.in")).toBe(false);
    expect(localTestLoginVisible("local", "production", "localhost")).toBe(false);
    expect(localTestLoginVisible("local", "development", "192.168.1.5")).toBe(false);
    expect(localTestLoginVisible(undefined, "development", "localhost")).toBe(false);
  });
});
