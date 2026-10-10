/**
 * The served theme IS the theme this app renders: every token in tokens.ts equals the same custom
 * property in src/app/globals.css (`:root` for light, `.dark` for dark). Change a colour in one
 * without the other and this fails — so /api/public/theme can never describe a brand ResellerOS
 * itself doesn't show (10 Oct 2026).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_THEME, THEME_TOKEN_NAMES } from "./tokens";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block in globals.css`).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\/\*.*?\*\//g, "").trim();
  return out;
}

describe("APP_THEME mirrors globals.css", () => {
  it.each([["light", ":root"], ["dark", ".dark"]] as const)("%s tokens equal %s", (mode, selector) => {
    const vars = block(selector);
    for (const name of THEME_TOKEN_NAMES) expect(`${name}: ${APP_THEME[mode][name]}`).toBe(`${name}: ${vars[name]}`);
  });
  it("the accent's 600 step is the accent, #C2410C", () => {
    expect(APP_THEME.accentScale["600"]).toBe("194 65 12");
  });
});
