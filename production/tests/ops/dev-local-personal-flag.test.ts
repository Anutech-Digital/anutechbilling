/**
 * R-2396 (G-PERSONAL): `npm run dev:local` turns PERSONAL_SIGNUP_ENABLED on for localhost so the
 * owner can see the personal signup — set in the script's own env block, never let through from
 * .env.local (not on ALLOW). Staging/live (Cloud Run) never run this script, so they stay off.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../scripts/dev-local.mjs", import.meta.url), "utf8");
const allowBlock = /const ALLOW = new Set\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? "";

describe("dev:local opens the personal signup on localhost only (R-2396)", () => {
  it("sets PERSONAL_SIGNUP_ENABLED to 1 (0 in the shell turns it off)", () => {
    expect(src).toMatch(/PERSONAL_SIGNUP_ENABLED:\s*process\.env\.PERSONAL_SIGNUP_ENABLED === "0" \? "0" : "1"/);
  });

  it("is not on ALLOW — a staging/live .env.local value never passes through", () => {
    expect(allowBlock).not.toMatch(/PERSONAL_SIGNUP_ENABLED/);
  });
});
