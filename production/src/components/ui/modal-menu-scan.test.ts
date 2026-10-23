/**
 * R-1799 — no modal DropdownMenu / ContextMenu anywhere in the app.
 *
 * R-1427 root cause: @radix-ui/react-menu bundles its own react-dismissable-layer (1.1.11)
 * while react-dialog uses another copy (1.1.19). A modal menu sets body pointer-events:none;
 * a Dialog / Sheet / AlertDialog opened from one of its items remembers "none" as the page's
 * normal value and puts it back on Close — the whole page stays frozen until reload.
 * R-457, R-1418 and R-1427 fixed three menus one at a time; nearly every row menu opens an
 * edit / delete / confirm dialog (often through a parent callback, so a same-file check
 * would miss it). Rule: every menu root says modal={false}.
 *
 * Dedupe of Radix (package.json / lockfile) is Pardeep's decision — see the R-1799 card.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(__dirname, "..", "..");

/** Files still owed the fix, with how many modal roots they may keep. Only shrinks.
 *  Both were locked by R-857 when R-1799 ran — fix them in the next card that touches them. */
const PENDING: Record<string, number> = {
  "app/(app)/invoices/page.tsx": 1,
  "app/(app)/quotes/page.tsx": 3,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/** Opening tags of a menu root, e.g. `<DropdownMenu open={x} modal={false}>` (multi-line ok). */
function modalRoots(code: string): string[] {
  const code2 = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const tags = code2.match(/<(DropdownMenu|ContextMenu)(?=[\s>])[^>]*>/g) ?? [];
  return tags.filter((t) => !/\bmodal=\{false\}/.test(t));
}

describe("R-1799: menus are non-modal (dialog opened from a menu must not freeze the page)", () => {
  const files = walk(SRC).map((f) => [relative(SRC, f).split(sep).join("/"), f] as const);
  const found = Object.fromEntries(
    files.map(([rel, abs]) => [rel, modalRoots(readFileSync(abs, "utf8")).length] as const).filter(([, n]) => n > 0),
  );

  it("sees the menus at all (scan is not silently empty)", () => {
    const withMenu = files.filter(([, abs]) => /<DropdownMenu[\s>]/.test(readFileSync(abs, "utf8")));
    expect(withMenu.length).toBeGreaterThan(20);
  });

  it("every DropdownMenu / ContextMenu root sets modal={false}", () => {
    const offenders = Object.entries(found).filter(([rel, n]) => n > (PENDING[rel] ?? 0));
    expect(offenders, "add modal={false} to these menus (R-1427 freeze)").toEqual([]);
  });

  it("PENDING only shrinks — drop an entry once its file is fixed", () => {
    const stale = Object.entries(PENDING).filter(([rel, n]) => (found[rel] ?? 0) < n);
    expect(stale, "lower/remove these PENDING counts").toEqual([]);
  });

  it("the detector catches a modal menu and passes a non-modal one", () => {
    expect(modalRoots("<DropdownMenu>\n<X/></DropdownMenu>")).toHaveLength(1);
    expect(modalRoots("<ContextMenu onOpenChange={f}>")).toHaveLength(1);
    expect(modalRoots("<DropdownMenu\n  modal={false}\n>")).toHaveLength(0);
    expect(modalRoots("<DropdownMenuItem>x</DropdownMenuItem>")).toHaveLength(0);
  });
});
