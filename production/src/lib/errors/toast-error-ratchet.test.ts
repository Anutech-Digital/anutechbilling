/**
 * §24 ka RATCHET — nange error-toast ki ginti ab sirf GHAT sakti hai.
 *
 * CLAUDE.md §24: har rok par teen cheezein — kya hua, kyun, aage kya (button
 * ke saath). docs/UX-AUDIT.md ne 12 Aug ko naapa tha ki ye 1-of-278 tha aur
 * likha tha "add it to the definition of done … enforce it on new code" —
 * kisi ne enforce nahi kiya, aur 1 Sep ke audit tak 20 din me sirf 1 site
 * sudhri jabki 27 NAYI nangi sites jud gayin. Niyam jo machine nahi
 * pakadti, wo niyam nahi hota.
 *
 * Ye test wahi machine hai: `toast.error(...)` jiske call me na
 * `description:` ho na `action:`, wo "nanga" hai. Aaj ki naapi hui ginti
 * neeche BASELINE hai. Naya nanga toast jodoge to ginti badhegi aur ye test
 * laal ho jayega — fix: `description` (kyun) + `action` (aage kya) do, ya
 * `toastError()` helper ke `hints` istemal karo (lib/errors/toast-error.ts).
 * Purana koi sudhaaro to BASELINE utna hi NEECHE karo — wapas upar jane ka
 * darwaza band rahe.
 */
import { describe, it, expect } from "vitest";
import { join } from "path";
import { readFileSync } from "fs";
const { countRaw } = require("../../../scripts/count-raw-toast-errors.cjs");

/** Naapa hua: 1 Sep 2026 — kul 481 me se 450 nange. 6 Oct (R-266): 16 query files toastError par — 403. R-283: agle 8 — 366. R-284: 6 more — 344. R-299: 5 heaviest files — 298. */
const BASELINE = 298;

describe("§24 ratchet — error-toast me 'aage kya' ki disha", () => {
  it(`nange toast.error ${BASELINE} se zyada nahi ho sakte (aaj: dekho fail-message)`, () => {
    const { total, raw } = countRaw(join(process.cwd(), "src"));
    // Denominator pehle — khaali scan chup-chaap pass na ho (khaali-loop sabak).
    expect(total).toBeGreaterThan(100);
    expect(
      raw,
      `Nange toast.error ${raw} ho gaye (seema ${BASELINE}). Naya error-toast §24 nibhaye: ` +
      `description (kyun) + action (button) — ya toastError() ke hints. ` +
      `Kaunsi files sabse bhaari: node scripts/count-raw-toast-errors.cjs`,
    ).toBeLessThanOrEqual(BASELINE);
  });
});

/* R-266 — the first 16 query modules: their mutation onError hands the error to
   toastError() (which translates raw Postgres text and keeps good business messages),
   never `toast.error(err.message)` straight onto the screen. Per-file and at ZERO,
   so a new raw site in these files is caught even while the global count is falling. */
const R266_FILES = [
  "assessments", "attendance-biometric", "backups", "balance-sheet", "business-loans",
  "compliance", "contacts", "credit-notes", "customers", "debit-notes", "emi",
  "employee-loans", "expense-claims", "expenses", "imported-contacts", "inbound-emails",
  // R-283 — the next 8
  "inbound-purchases", "items", "payroll", "prepaid-advances", "purchase-orders",
  "referral-commissions", "referral-partners", "reimbursements",
] as const;

describe("R-266 — no raw error text toasted from these query modules", () => {
  it.each(R266_FILES)("src/lib/queries/%s.ts", (name) => {
    const src = readFileSync(join(process.cwd(), "src/lib/queries", `${name}.ts`), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/toast\.error\(\s*\(?\s*\w+\s+as\s+Error\s*\)?\s*\.message/);
    expect(src).not.toMatch(/toast\.error\(\s*\w+\.message/);
  });
});

/* R-284 — the next 6 query modules, same zero rule. Also bans raw `.message` pasted into a
   toast description (tds-receivable's 26AS bulk verify did that). */
const R284_FILES = ["subscriptions", "tasks", "tds-receivable", "vendor-bills", "vendors", "whatsapp"] as const;

describe("R-284 — no raw error text toasted from these query modules", () => {
  it.each(R284_FILES)("src/lib/queries/%s.ts", (name) => {
    const src = readFileSync(join(process.cwd(), "src/lib/queries", `${name}.ts`), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/toast\.error\(\s*\(?\s*\w+\s+as\s+Error\s*\)?\s*\.message/);
    expect(src).not.toMatch(/toast\.error\(\s*\w+\.message/);
    expect(src).not.toMatch(/description:\s*`\$\{\(?\s*\w+(\s+as\s+Error)?\s*\)?\.message/);
  });
});

/* R-299 — the five heaviest files (46 bare toasts): campaign composer, Google subs import,
   Contacts page, My attendance, Personal vault. Every toast.error here carries a why/next
   step (description or action) or goes through toastError(), and none pastes a raw
   `.message` onto the screen. Per-file at ZERO, so a new bare toast is caught here first. */
const R299_FILES = [
  "src/components/features/campaigns/campaign-composer-dialog.tsx",
  "src/components/features/subscriptions/import-google-subs-dialog.tsx",
  "src/app/(app)/contacts/page.tsx",
  "src/lib/queries/my-attendance.ts",
  "src/lib/queries/personal-vault.ts",
] as const;

describe("R-299 — no bare or raw error toasts in the five heaviest files", () => {
  const { rawByFile } = countRaw(join(process.cwd(), "src")) as { rawByFile: Map<string, number> };
  it.each(R299_FILES)("%s", (file) => {
    const abs = join(process.cwd(), file);
    expect(rawByFile.get(abs) ?? 0, `${file}: bare toast.error (no description/action)`).toBe(0);
    const src = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/toast\.error\(\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message/);
    expect(src).not.toMatch(/toast\.error\(\s*\w+\.message/);
  });
});
