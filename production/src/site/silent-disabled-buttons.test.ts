/**
 * No SILENTLY disabled buttons on the public site, the checkout and the customer pages.
 *
 * 29 Sep 2026: the owner pressed "Start my 15-day free trial" and nothing happened. The
 * button was `disabled={!detailsOk}` because an optional-looking field was blank, and
 * `.btn` had no disabled style, so it looked exactly like an enabled button. Nothing
 * said what was missing. The same shape was then found on checkout's Pay button (terms
 * box) and the quote-accept Confirm button (name only in a hover tooltip, which a phone
 * never shows).
 *
 * The rule: a button may be disabled while something is IN PROGRESS (paying, sending…),
 * because its own label says so. A button that is disabled because the buyer has not
 * done something yet must instead respond to the press and say what to do (AGENTS.md §7).
 * Any other `disabled={…}` on a button fails this test until it is either changed to
 * respond, or listed in ALLOWED with the place its explanation is visible.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const AREAS = ["src/app/(marketing)", "src/app/(public)", "src/site"];

/** Identifiers that mean "work is in progress" — the label says so while they are true. */
const IN_PROGRESS = new Set(["paying", "sending", "submitting", "accepting", "busy", "loading", "state", "submitState"]);
const IN_PROGRESS_STRINGS = new Set(["busy", "sending"]);

/**
 * Reviewed validation gates, each with where the reason is visible WITHOUT pressing.
 * Key: "<file>|<expression>".
 */
const ALLOWED: Record<string, string> = {
  "src/app/(marketing)/checkout/page.tsx|paying || trialMixed":
    "trialMixed shows its own amber alert with a Back-to-cart button right above",
  "src/app/(marketing)/checkout/page.tsx|trialMixed":
    "same trialMixed alert, above the Continue button",
  "src/app/(public)/buy/workspace/buy-workspace-client.tsx|seats <= 1":
    "the minus of a seat stepper already showing 1 — the number is the explanation",
  "src/app/(public)/buy/workspace/buy-workspace-client.tsx|validatingCoupon || couponInput.trim().length < 2":
    "Apply beside an empty coupon box",
  "src/site/components/agent/AgentChat.tsx|busy || !input.trim()":
    "Send beside an empty message box",
  "src/site/components/email/LicenceCalculator.tsx|!monthlyAvailable":
    "the line below says \"This edition is priced for annual commitment only\"",
  "src/site/components/ssl/CertCards.tsx|c.cta === \"Included\"":
    "the button's own label reads \"Included\"",
  "src/app/(marketing)/cart/page.tsx|locked":
    "a single-unit line's quantity stepper, locked at 1 — singleUnitNote() prints why under it",
  "src/site/components/cart/CartDrawer.tsx|locked":
    "same locked stepper in the cart drawer, with singleUnitNote() beside it",
  "src/site/components/quote/QuoteBuilder.tsx|off":
    "Flexible monthly while an annual-only plan is picked — #annual-only-note right below names the plan and says to remove it (aria-describedby)",
  "src/site/components/quote/QuoteBuilder.tsx|locked":
    "an annual-only row's checkbox + name on a monthly quote — the row's own price column reads \"Annual only\" (aria-describedby)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".tsx") && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/** Every `disabled={…}` on a <button> or <Button>, with its expression (braces balanced). */
function disabledGates(src: string): string[] {
  const found: string[] = [];
  const re = /\bdisabled=\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tagStart = src.lastIndexOf("<", m.index);
    const tag = /^<\s*([A-Za-z]+)/.exec(src.slice(tagStart))?.[1];
    if (tag !== "button" && tag !== "Button") continue;
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    found.push(src.slice(re.lastIndex, i - 1).replace(/\s+/g, " ").trim());
  }
  return found;
}

function onlyInProgress(expr: string): boolean {
  const strings = [...expr.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  if (strings.some((s) => !IN_PROGRESS_STRINGS.has(s))) return false;
  const idents = expr.replace(/"[^"]*"/g, "").match(/[A-Za-z_]\w*/g) ?? [];
  return idents.length > 0 && idents.every((id) => IN_PROGRESS.has(id));
}

const files = AREAS.flatMap((a) => walk(join(ROOT, a)));
const gates = files.flatMap((f) => {
  const rel = relative(ROOT, f).split(sep).join("/");
  return disabledGates(readFileSync(f, "utf8")).map((expr) => ({ rel, expr }));
});

describe("no silently disabled buttons (site, checkout, customer pages)", () => {
  it("guard: the scan found the pages and the buttons it is meant to check", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(gates.length).toBeGreaterThan(10);
  });

  it("every disabled button is either in progress, or a reviewed gate whose reason is on screen", () => {
    const silent = gates
      .filter((g) => !onlyInProgress(g.expr) && !ALLOWED[`${g.rel}|${g.expr}`])
      .map((g) => `${g.rel}: disabled={${g.expr}}`);
    expect(silent, "Make the button respond with what to do, or add it to ALLOWED with where its reason shows").toEqual([]);
  });

  it("no ALLOWED entry is stale (each still exists)", () => {
    const present = new Set(gates.map((g) => `${g.rel}|${g.expr}`));
    expect(Object.keys(ALLOWED).filter((k) => !present.has(k))).toEqual([]);
  });

  it("the site gives a disabled .btn a disabled look", () => {
    const css = readFileSync(join(ROOT, "src/site/site.css"), "utf8");
    expect(css).toMatch(/\.anutech-site \.btn:disabled\s*\{[^}]*opacity:\s*0?\.\d/);
  });

  it("the three buttons found on 29 Sep respond to a press instead of being disabled", () => {
    const checkout = readFileSync(join(ROOT, "src/app/(marketing)/checkout/page.tsx"), "utf8");
    expect(checkout).toMatch(/onClick=\{\(\) => proceed\(\(\) => void startTrial\(\)\)\}/);
    expect(checkout).toMatch(/onClick=\{\(\) => proceed\(\(\) => setStep\("payment"\)\)\}/);
    expect(checkout).toMatch(/if \(!agreed\) \{ setAgreeNudge\(true\); return; \}/);
    const accept = readFileSync(join(ROOT, "src/app/(public)/quote/[id]/accept/quote-accept-view.tsx"), "utf8");
    expect(accept).toMatch(/if \(!signerName\.trim\(\)\) \{\s*setNameNudge\(true\);/);
  });
});
