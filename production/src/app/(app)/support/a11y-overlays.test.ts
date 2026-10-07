/**
 * R-289 — Support page, image viewer, Coupons, Online promos: no hand-made overlay without a
 * focus trap, no unnamed control, no icon-only button a screen reader reads as just "button".
 * Same counter as `node scripts/a11y-count.mjs` (a heuristic over source).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

type Hits = Record<string, number[]>;

const FILES = [
  "src/app/(app)/support/page.tsx",
  "src/components/shared/image-viewer.tsx",
  "src/app/(app)/coupons/page.tsx",
  "src/app/(app)/online-promos/page.tsx",
];
const KINDS = ["input-no-name", "label-no-for", "modal-no-trap"];

/** The counter's own scan(), run in plain node (its shebang line is not importable here). The
    trailing arg fills process.argv[1], which scripts/areas.mjs reads at import. */
function scan(raw: string, path = ""): Hits {
  const url = pathToFileURL(join(process.cwd(), "scripts", "a11y-count.mjs")).href;
  const code =
    `import { scan } from ${JSON.stringify(url)};\n` +
    `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => ` +
    `console.log(JSON.stringify(scan(s, ${JSON.stringify(path)}))));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code, "scan-stdin"], { input: raw, encoding: "utf8" });
  return JSON.parse(out) as Hits;
}

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

/** Opening JSX tag at i, up to its own `>` (brace-aware, so `() => x` inside props is skipped). */
function tagAt(src: string, i: number): string {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

/** Icon-only buttons with no aria-label: `<Button icon=… />` and `<button …><Icon …/></button>`. */
function unnamedIconButtons(src: string): number[] {
  const out: number[] = [];
  const line = (i: number) => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(/<Button\b/g)) {
    const tag = tagAt(src, m.index!);
    if (tag.endsWith("/>") && /\bicon=/.test(tag) && !/aria-label=/.test(tag)) out.push(line(m.index!));
  }
  for (const m of src.matchAll(/<button\b/g)) {
    const tag = tagAt(src, m.index!);
    const close = src.indexOf("</button>", m.index! + tag.length);
    const body = close > 0 ? src.slice(m.index! + tag.length, close) : "";
    const onlyIcon = body.replace(/<Icon\b[^>]*\/>/g, "").trim() === "";
    if (onlyIcon && !/aria-label=/.test(tag)) out.push(line(m.index!));
  }
  return out;
}

describe("R-289 — overlays trap focus, icon buttons have names", () => {
  it.each(FILES)("%s: no trap-less overlay, unnamed control or untied label", (f) => {
    const hits = scan(read(f), `production/${f}`);
    const bad = KINDS.flatMap((k) => (hits[k] ?? []).map((l) => `${k}:${l}`));
    expect(bad).toEqual([]);
  });

  it.each(FILES)("%s: every icon-only button has an aria-label", (f) => {
    expect(unnamedIconButtons(read(f))).toEqual([]);
  });

  it("the counter still flags a hand-made overlay, but not a Radix primitive's own tag", () => {
    const handMade = `<div className="fixed inset-0 bg-black/50" onClick={close}><div>hi</div></div>`;
    const radix = `<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/95" />`;
    const radixContent = `<DialogPrimitive.Content\n  onKeyDown={onKey}\n  className="fixed inset-0 z-[1] flex"\n>`;
    expect(scan(handMade, "x.tsx")["modal-no-trap"]).toHaveLength(1);
    expect(scan(radix, "x.tsx")["modal-no-trap"]).toHaveLength(0);
    expect(scan(radixContent, "x.tsx")["modal-no-trap"]).toHaveLength(0);
    // A hand-made overlay INSIDE a Radix dialog's children is still a hand-made overlay.
    const nested = `<DialogPrimitive.Content className="p-4">\n  <div className="fixed inset-0" />\n</DialogPrimitive.Content>`;
    expect(scan(nested, "x.tsx")["modal-no-trap"]).toHaveLength(1);
  });
});
