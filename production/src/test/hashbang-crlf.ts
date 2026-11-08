/**
 * R-2553 (7 Nov 2026): a Vitest-only fix for `#!` scripts checked out with Windows line endings.
 *
 * Vite 5.4's SSR transform skips a hashbang with `/^#!.*\n/` before it hoists the imports. `.`
 * stops at `\r`, so on a CRLF checkout (git `text=auto` on Windows) the match fails, the
 * `__vite_ssr_import__` lines go ABOVE `#!/usr/bin/env node`, and the module dies at import with
 * "SyntaxError: Invalid or unexpected token". Every test that imports a `#!` ops script
 * (staging-smoke, staging-train, r2518-group-merged-sale, card-tests …) was red on the laptop
 * while green on CI (Linux, LF).
 *
 * The fix turns the hashbang line into a `//` comment before Vite's transform — same length,
 * same line count, so line numbers in errors stay right. Node itself still sees the real file.
 */
/** `#!…` on the first line → `//#!…`; anything else is returned unchanged. */
export function commentOutHashbang(code: string): string {
  return code.startsWith("#!") ? `//${code}` : code;
}

/** A Vite plugin object (typed structurally — vite is not a direct dependency of the app). */
export function hashbangCrlfPlugin() {
  return {
    name: "r2553-hashbang-crlf",
    enforce: "pre" as const,
    transform(code: string) {
      if (!code.startsWith("#!")) return null;
      return { code: commentOutHashbang(code), map: null };
    },
  };
}
