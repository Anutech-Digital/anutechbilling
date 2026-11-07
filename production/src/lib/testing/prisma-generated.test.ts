import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PRISMA_GENERATED, PRODUCTION_ROOT, isPrismaGenerated } from "./prisma-generated";

/* R-2564: the shared skip must be exactly the Prisma generator output — never wider. */
describe("PRISMA_GENERATED (the one folder whole-src scans skip)", () => {
  it("is the schema's generator output folder", () => {
    const schema = fs.readFileSync(path.join(PRODUCTION_ROOT, "prisma", "schema.prisma"), "utf8");
    const out = schema.match(/^\s*output\s*=\s*"([^"]+)"/m)?.[1];
    expect(out && path.resolve(PRODUCTION_ROOT, "prisma", out)).toBe(PRISMA_GENERATED);
  });

  it("matches only that folder — not its parent, a sibling or a look-alike name", () => {
    expect(isPrismaGenerated(PRISMA_GENERATED)).toBe(true);
    expect(isPrismaGenerated(path.join(PRISMA_GENERATED, "models"))).toBe(false);
    expect(isPrismaGenerated(path.dirname(PRISMA_GENERATED))).toBe(false);
    expect(isPrismaGenerated(path.join(PRODUCTION_ROOT, "src", "lib", "generated"))).toBe(false);
    expect(isPrismaGenerated(path.join(PRODUCTION_ROOT, "src", "server", "db", "generated-x"))).toBe(false);
  });
});
