// @vitest-environment jsdom
/**
 * A coloured button must not go pale on hover.
 *
 * ─── THE BUG ────────────────────────────────────────────────────────────────
 * Reported by Abhishek, 18 Sep 2026, on "Activate Subscription & Auto-Sync Ledger":
 * "when i hover on this button it text and box getting fade".
 *
 * `<Button>` with no `variant` is the QUIET one:
 *
 *     bg-paper text-ink border border-hairline hover:bg-paper-2
 *
 * Ten call sites tried to make it the loud one by passing
 * `className="bg-primary text-white"`. That works at rest — Tailwind's later utility
 * wins — but `hover:bg-paper-2` is still in the class list and still fires. So the
 * moment the pointer lands, the fill drops to near-white while the text stays white:
 * the button appears to fade out, and its label very nearly disappears. On the main
 * submit button of the subscription dialog.
 *
 * ─── WHY A TEST AND NOT JUST A FIX ──────────────────────────────────────────
 * The fix is to pass `variant="primary"`, which is the same colour with the matching
 * hover. But nothing stopped anyone writing `className="bg-primary"` in the first
 * place, and nothing would stop the next person — the result LOOKS right in a
 * screenshot, because a screenshot is not hovering. This test fails the moment a
 * button carries a background utility whose variant will repaint it on hover.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { Button, IconButton } from "./button";
import { Checkbox } from "./checkbox";
import { Switch } from "./switch";

afterEach(cleanup);

const SRC = path.join(process.cwd(), "src");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

/**
 * Every `<Button …>` opening tag in the tree, with the file and line it sits on.
 * Deliberately a source scan: the defect is a CLASS COMBINATION, so it is visible in
 * the markup and invisible in a rendered snapshot, which is exactly why it shipped.
 */
function buttonTags(): Array<{ file: string; line: number; tag: string }> {
  const found: Array<{ file: string; line: number; tag: string }> = [];
  for (const file of tsxFiles(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/<Button\b([^>]*?)\/?>/gs)) {
      found.push({
        file: path.relative(process.cwd(), file).replace(/\\/g, "/"),
        line: text.slice(0, m.index).split("\n").length,
        tag: m[1],
      });
    }
  }
  return found;
}

describe("Button — a custom background must bring its own hover", () => {
  it("has buttons to check at all", () => {
    // Guards the scan itself: a regex that silently matches nothing would make every
    // assertion below pass forever.
    expect(buttonTags().length).toBeGreaterThan(50);
  });

  it("no <Button> paints a background without saying which variant it is", () => {
    /* `bg-transparent` is exempt — it removes a fill rather than adding one, so the
       variant's hover still reads correctly over it. Anything that sets a real colour
       has to either declare its variant or bring its own `hover:bg-*`. */
    const offenders = buttonTags()
      .filter((b) => !/\bvariant=/.test(b.tag))
      .filter((b) => {
        const cls = /className="([^"]*)"/.exec(b.tag)?.[1] ?? "";
        const paints = /(^|\s)!?bg-(?!transparent)/.test(cls);
        const bringsOwnHover = /hover:!?bg-/.test(cls);
        return paints && !bringsOwnHover;
      })
      .map((b) => `${b.file}:${b.line}`);

    expect(
      offenders,
      `These buttons set a background but leave the DEFAULT variant's "hover:bg-paper-2" in place, `
      + `so they fade to near-white on hover with their text still white. `
      + `Pass variant="primary" (or "danger") instead of className="bg-primary text-white", `
      + `or add an explicit hover:bg-* of your own:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("the variant that replaces className=\"bg-primary text-white\"", () => {
  it("is the same colour at rest, and keeps it on hover", () => {
    render(<Button variant="primary">Activate</Button>);
    const cls = screen.getByRole("button").className;

    /* bg-primary and bg-amber are the same token — tailwind.config maps
       primary.DEFAULT to hsl(var(--amber)). So nothing about the button LOOKS
       different; only the hover is now correct. */
    expect(cls).toContain("bg-amber");
    expect(cls).toContain("hover:bg-amber/90");
    expect(cls).not.toContain("hover:bg-paper-2");
  });

  it("shows what the default variant would have done instead", () => {
    render(<Button className="bg-primary text-white">Activate</Button>);
    const cls = screen.getByRole("button").className;

    // Both fills are present; on hover the paper one wins and the button goes pale
    // while the text stays white. This is the reported defect, pinned.
    expect(cls).toContain("bg-primary");
    expect(cls).toContain("hover:bg-paper-2");
  });
});

/* ─── R-269: a finger needs a 40px target ─────────────────────────────────────
 * Audit 6 Oct: Button sm is h-8 (32px, 368 call sites), IconButton sm h-7 (28px),
 * the DataTable row checkbox 16px, the switch 20px tall. Fine for a mouse, a miss
 * for a thumb. On a touch screen (pointer: coarse) each control must offer at least
 * 40px; with a mouse nothing may change. jsdom cannot evaluate the media query, so
 * these tests pin the classes that carry it: every touch rule sits behind
 * `[@media(pointer:coarse)]:`, and the desktop size classes are still there. */
const COARSE = "[@media(pointer:coarse)]:";

describe("touch hit area (R-269)", () => {
  it("Button sm stays h-8 for a mouse but is at least 40px tall under a finger", () => {
    render(<Button size="sm">Save</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("h-8");
    expect(cls).toContain(`${COARSE}min-h-10`);
  });

  it("every regular size gets the touch minimum; a link-styled button does not grow", () => {
    for (const size of ["sm", "md", "lg", "icon"] as const) {
      cleanup();
      render(<Button size={size} aria-label="x">x</Button>);
      expect(screen.getByRole("button").className).toContain(`${COARSE}min-h-10`);
    }
    cleanup();
    render(<Button variant="link">Open</Button>);
    expect(screen.getByRole("button").className).not.toContain(`${COARSE}min-h-10`);
  });

  it("IconButton sm keeps h-7 w-7 for a mouse and is 40x40 under a finger", () => {
    render(<IconButton size="sm" icon="x" aria-label="Close" />);
    const cls = screen.getByRole("button", { name: "Close" }).className;
    expect(cls).toContain("h-7");
    expect(cls).toContain("w-7");
    expect(cls).toContain(`${COARSE}min-h-10`);
    expect(cls).toContain(`${COARSE}min-w-10`);
  });

  it("Checkbox keeps its 16px box but gets an invisible 40px target under a finger", () => {
    render(<Checkbox aria-label="Select row" />);
    const cls = screen.getByRole("checkbox", { name: "Select row" }).className;
    expect(cls).toContain("h-4");
    expect(cls).toContain("w-4");
    expect(cls).toContain("relative");
    expect(cls).toContain(`${COARSE}after:h-10`);
    expect(cls).toContain(`${COARSE}after:w-10`);
    expect(cls).toContain(`${COARSE}after:absolute`);
  });

  it("Switch keeps its 20px track but gets the same 40px target under a finger", () => {
    render(<Switch aria-label="Notifications" />);
    const cls = screen.getByRole("switch", { name: "Notifications" }).className;
    expect(cls).toContain("h-5");
    expect(cls).toContain("relative");
    expect(cls).toContain(`${COARSE}after:h-10`);
    expect(cls).toContain(`${COARSE}after:w-10`);
  });

  it("no touch rule leaks onto a mouse: every hit-area class is behind pointer:coarse", () => {
    render(<><Checkbox aria-label="c" /><Switch aria-label="s" /><IconButton icon="x" aria-label="i" size="sm" /></>);
    for (const el of [
      screen.getByRole("checkbox", { name: "c" }),
      screen.getByRole("switch", { name: "s" }),
      screen.getByRole("button", { name: "i" }),
    ]) {
      const bare = el.className.split(/\s+/).filter((c) => /^(after:|min-h-10$|min-w-10$)/.test(c));
      expect(bare, el.className).toEqual([]);
    }
  });
});
