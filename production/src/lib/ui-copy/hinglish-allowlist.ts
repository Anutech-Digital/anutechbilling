/* R-1731 (decision R-1728, 22 Oct 2026): files that still show Hinglish on screen, each with the
   card that will make it English. The guard in src/app/(app)/today/ui-copy-english.test.ts fails
   when a file NOT listed here shows Hinglish, and also when a listed file has none left — so this
   list only shrinks. When your card cleans a file, delete its line here in the same commit.
   R-1732 = Leads. R-1733 = everything else (quotes, payments, customers, vault, payroll,
   settings, reports, support, referrals, marketing, attendance, API messages).
   R-1733 (22 Oct 2026): both cards are done and the list is EMPTY. Keep it empty: translate new
   screen text instead of listing it here. AI help, AI prompts and keyword matchers are not listed
   here but in HINGLISH_ALLOWED_BY_DESIGN (src/lib/ui-copy/hinglish-scan.ts). */
export const HINGLISH_ALLOWLIST: Readonly<Record<string, "R-1732" | "R-1733">> = {};
