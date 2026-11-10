/**
 * No write path may fall back to the seed tenant (R-001).
 *
 * The unit tests beside this prove `requireTenantId` refuses. They cannot prove that
 * nobody writes a NEW default somewhere else — and that is how this bug survived from
 * whenever it was written until Pardeep found it on 25 Sep 2026: the constant looked
 * like sensible dev convenience, and a default reads as harmless in review.
 *
 * So this scans the source instead, the same approach as
 * `lib/email/no-hardcoded-recipient.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { listSourceFiles } from "@/lib/testing/walk-source"; // R-2649: shared walk, no stat per entry
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared fresh read cache

const SEED_TENANT = "11111111-1111-1111-1111-111111111111";

/**
 * Files allowed to mention it, each for a stated reason. An allow-list of two is
 * reviewable; a relaxed pattern is not.
 */
const ALLOWED = new Set([
  // Seeded fixtures are what this constant IS. A test naming it is not a write path.
  "src/lib/email/send.test.ts",
  "src/lib/queries/require-tenant.ts",       // names it in the comment explaining the fix
  "src/lib/queries/require-tenant.test.ts",  // asserts no failure path ever returns it
  "src/lib/queries/no-seed-tenant.test.ts",  // this file
  "src/lib/queries/customers.ts",            // names it in the R-001 comment, does not use it
  /* leads.ts left this list on 26 Sep 2026: `useCreateLead` now uses requireTenantId. */
]);

/** Every .ts/.tsx under `dir`; node_modules, .next and the generated Prisma client (R-2564: 36 MB, not
    our code) skipped, as the old hand walk did — R-2649: via listSourceFiles, no stat per entry. */
function walk(dir: string): string[] {
  return listSourceFiles(dir, (name) => /\.(ts|tsx)$/.test(name))
    .filter((f) => !f.split(/[\\/]/).some((seg) => seg === "node_modules" || seg === ".next"));
}

describe("the seed tenant is never a fallback", () => {
  /* R-2564: the generated Prisma client is skipped, so its source is scanned instead — a schema
     default (`@default("1111…")`) used to reach the scan through the generated client's inline schema. */
  const files = [...walk("src"), "prisma/schema.prisma"];

  it("scanned a believable number of files", () => {
    // A guard that silently scanned nothing passes forever. L23.
    expect(files.length).toBeGreaterThan(500);
  });

  it("no file outside the allow-list mentions it", () => {
    const offenders = files
      .map((f) => f.split("\\").join("/"))
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => readSource(f).includes(SEED_TENANT));
    expect(offenders).toEqual([]);
  });

  it("customers.ts mentions it only in prose, never as a value", () => {
    /* The distinction that matters: explaining a deleted fallback is documentation,
       assigning it is the bug. An assignment has an `=` or a `:` before it. */
    const src = readFileSync("src/lib/queries/customers.ts", "utf8");
    expect(src).not.toMatch(new RegExp(`[=:]\s*["'\`]${SEED_TENANT}`));
  });

  it("useCreateCustomer resolves its tenant through the guard", () => {
    const src = readFileSync("src/lib/queries/customers.ts", "utf8");
    expect(src).toContain("await requireTenantId(supabase)");
  });

  it("useCreateCustomer no longer fabricates a customer when the insert fails", () => {
    /* It used to build `CUST-<Date.now()>` and put it in the list cache. If that ever
       comes back, the screen shows a customer that does not exist. */
    const src = readFileSync("src/lib/queries/customers.ts", "utf8");
    expect(src).not.toContain("CUST-${Date.now()}");
    expect(src).not.toContain("Dev mode customer insert warning");
  });
});
