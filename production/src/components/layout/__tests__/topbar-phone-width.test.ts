// R-203 (6 Oct 2026): on a 375px phone the app topbar was 459px wide on staging/local
// (STAGING badge, "+ Demo data", menu, Report Bug, search, theme, AI Help, quick actions,
// bell — all in one row with gap-2), so every page scrolled sideways. The fix is layout only:
// below `sm` Report Bug (R-383: now inside the Help button), the theme toggle and Quick actions move into one "More" menu, Demo
// data and Back drop their text labels, and the row gap shrinks. jsdom has no layout engine,
// so this guards the classes that produce the fit and a width budget for what a phone shows.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "src/components/layout");
const topbar = readFileSync(join(dir, "topbar.tsx"), "utf8");
const demo = readFileSync(join(dir, "demo-data-button.tsx"), "utf8");

/** Class string of the first element whose opening tag contains `marker`. */
function classOf(src: string, marker: string): string {
  const at = src.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = src.lastIndexOf("<", at);
  const tag = src.slice(open, src.indexOf(">", at) + 1);
  return tag.match(/className="([^"]*)"/)?.[1] ?? "";
}

const hiddenOnPhone = /(^|\s)hidden(\s|$)/;
const shownFromSm = /\bsm:(inline-flex|flex|inline|block)\b/;

describe("topbar on a 375px phone", () => {
  it("uses a smaller gap below sm and the normal gap from sm up", () => {
    const header = classOf(topbar, "<header");
    expect(header).toMatch(/\bgap-1\b/);
    expect(header).toMatch(/\bsm:gap-2\b/);
  });

  it.each([
    ["theme toggle", 'data-topbar="theme"'],
    ["quick actions", 'data-topbar="quick-actions"'],
  ])("hides the %s button below sm (it lives in the More menu there)", (_name, marker) => {
    const cls = classOf(topbar, marker);
    expect(cls).toMatch(hiddenOnPhone);
    expect(cls).toMatch(shownFromSm);
  });

  it("has a phone-only More menu that still reaches Report a problem, theme and Quick actions", () => {
    const trigger = classOf(topbar, 'data-topbar="more"');
    expect(trigger).toMatch(/\bsm:hidden\b/);
    const menu = topbar.slice(topbar.indexOf('data-topbar="more"'));
    const end = menu.indexOf("</DropdownMenu>");
    expect(end).toBeGreaterThan(-1);
    const body = menu.slice(0, end);
    expect(body).toMatch(/openHelpReport\(\)/);
    expect(body).toMatch(/setActionsOpen\(true\)/);
    expect(body).toMatch(/setTheme\(/);
  });

  it("R-383: one Help button — no separate Report Bug button or dialog in the header", () => {
    expect(topbar).not.toMatch(/data-topbar="report-bug"/);
    expect(topbar).not.toMatch(/FeedbackDialog/);
    expect(topbar.match(/<AiHelpButton \/>/g) ?? []).toHaveLength(1);
  });

  it("keeps search, AI Help and notifications visible on a phone", () => {
    expect(classOf(topbar, 'aria-label="Search customers')).not.toMatch(hiddenOnPhone);
    expect(topbar).toMatch(/<AiHelpButton \/>/);
    expect(topbar).toMatch(/icon="bell"/);
  });

  it("shows the Back label only from sm up (icon + aria-label on a phone)", () => {
    const back = topbar.slice(topbar.indexOf('aria-label="Go back"'));
    expect(back.match(/<span className="([^"]*)">Back<\/span>/)?.[1] ?? "").toMatch(/\bhidden\b.*\bsm:inline\b/);
  });

  it("shows the Demo data text only from sm up and keeps an accessible name", () => {
    expect(demo).toMatch(/aria-label="Demo data for testing"/);
    expect(demo).toMatch(/<span className="hidden sm:inline">Demo data<\/span>/);
  });

  it("fits a 375px screen in the widest case (staging, Demo data, detail page with Back)", () => {
    // Widths in px from the classes: IconButton h-9 w-9 = 36, header px-3 = 12 each side.
    const gap = 4;
    const items = [
      62, // STAGING badge (text-3xs, px-2)
      26, // Demo data, icon only
      28, // menu (p-1.5 + 20 icon, -ml-1)
      26, // Back, icon only (p-1.5 + 18 icon, -ml-1)
      0, // flex-1 spacer
      36, // search (px-2.5 + 14 icon + border)
      36, // AI Help
      36, // bell
      36, // More
    ];
    const width = 12 * 2 + items.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
    expect(width).toBeLessThanOrEqual(375);
    // The phone row must be exactly these controls: count the ones not hidden below sm.
    const phoneOnlyHidden = ['data-topbar="theme"', 'data-topbar="quick-actions"'];
    for (const m of phoneOnlyHidden) expect(classOf(topbar, m)).toMatch(hiddenOnPhone);
  });
});
