import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { booksLockRights } from "@/components/features/accounting/books-lock-card";

/* R-1132: the accountant does the month-end close but only the owner could lock the books —
   the control was simply hidden. Pardeep (16 Oct): the accountant may lock too. Opening a lock
   (clearing it or moving it back) stays with the owner. The database decides through
   set_books_lock() (migration 20261017002400); these rules only shape the screen. */
describe("booksLockRights", () => {
  it("owner can lock, move the date either way and unlock", () => {
    expect(booksLockRights("owner", "2026-09-30")).toEqual({ canLock: true, canUnlock: true, minDate: null });
  });

  it("accountant can lock, but only forward from the current lock, and cannot unlock", () => {
    expect(booksLockRights("accountant", "2026-09-30")).toEqual({ canLock: true, canUnlock: false, minDate: "2026-09-30" });
    expect(booksLockRights("accountant", null)).toEqual({ canLock: true, canUnlock: false, minDate: null });
  });

  it("manager, sales, billing and unknown roles cannot lock", () => {
    for (const role of ["manager", "sales", "billing", "support", undefined, null]) {
      expect(booksLockRights(role, null).canLock).toBe(false);
      expect(booksLockRights(role, null).canUnlock).toBe(false);
    }
  });
});

describe("screens use the shared rule and the RPC", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  for (const file of ["src/app/(app)/accounting/close/page.tsx", "src/components/features/accounting/books-lock-card.tsx"]) {
    it(`${file} has no owner-only lock and no direct tenants update`, () => {
      const src = read(file);
      expect(src).not.toMatch(/isOwner/);
      expect(src).not.toMatch(/mutateAsync\(\{\s*books_locked_until/);
      expect(src).toMatch(/booksLockRights\(/);
    });
  }

  it("close page tells a non-locking role who can lock", () => {
    expect(read("src/app/(app)/accounting/close/page.tsx")).toMatch(/Only the owner or accountant can lock/);
  });
});
