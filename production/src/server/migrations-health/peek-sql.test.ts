import { describe, it, expect } from "vitest";
import { buildPeekSql, missingKeys } from "./peek-sql";
import { MIGRATION_PEEKS } from "./peeks.generated";

/* R-1721: one read-only query, one boolean per migration, built only from the build-time list. */
describe("peek SQL", () => {
  const p = [{ key: "a", peek: "true" }, { key: "b", peek: "to_regclass('public.b') is not null" }];

  it("is one select returning a boolean array, peeks in list order", () => {
    expect(buildPeekSql(p)).toBe("select array[(true), (to_regclass('public.b') is not null)]::boolean[] as r");
  });

  it("missing = keys whose value is not exactly true (short array counts as missing)", () => {
    expect(missingKeys(p, [true, true])).toEqual([]);
    expect(missingKeys(p, [false, true])).toEqual(["a"]);
    expect(missingKeys(p, [true])).toEqual(["b"]);
  });

  it("the generated list is not empty and its keys are unique", () => {
    expect(MIGRATION_PEEKS.length).toBeGreaterThan(100);
    expect(new Set(MIGRATION_PEEKS.map((x) => x.key)).size).toBe(MIGRATION_PEEKS.length);
  });

  it("refuses a peek that could end the statement or start another", () => {
    expect(() => buildPeekSql([{ key: "x", peek: "true); drop table t; --" }])).toThrow(/x/);
  });
});
