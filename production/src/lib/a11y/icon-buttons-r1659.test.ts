/**
 * R-1659 (24 Oct 2026) — an icon-only button must have a name a screen reader can say.
 *
 * The Razorpay and WhatsApp setup dialogs had a Copy button next to the webhook URL whose only
 * child was <Icon name="copy">, so a screen reader announced just "button". This scans every
 * .tsx in the integrations folder, element by element (attributes span lines — a line grep
 * lies, accessibility-review §0b), and fails on a <Button>/<button> whose children are only
 * <Icon …/> and which carries no aria-label / aria-labelledby.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src/components/features/integrations");

/** End index (exclusive) of the opening tag starting at `i` ("<Button"), skipping {…} and "…". */
function openTagEnd(src: string, i: number): { end: number; selfClosing: boolean } {
  let depth = 0;
  let quote: string | null = null;
  for (let k = i + 1; k < src.length; k++) {
    const ch = src[k];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (depth === 0 && (ch === '"' || ch === "'")) { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return { end: k + 1, selfClosing: src[k - 1] === "/" };
  }
  return { end: src.length, selfClosing: false };
}

/** file:line of every icon-only button with no accessible name. */
export function unnamedIconButtons(file: string, src: string): string[] {
  const out: string[] = [];
  const re = /<(Button|button)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tag = m[1];
    const { end, selfClosing } = openTagEnd(src, m.index);
    if (selfClosing) continue;
    const close = src.indexOf(`</${tag}>`, end);
    if (close < 0) continue;
    const attrs = src.slice(m.index, end);
    const children = src.slice(end, close).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").trim();
    const iconOnly = /^(<Icon\b[^>]*\/>\s*)+$/.test(children);
    if (iconOnly && !/aria-label(ledby)?=/.test(attrs)) {
      out.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  return out;
}

describe("R-1659 — icon-only buttons in integrations have a name", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx") && !f.includes(".test."));

  it("the scan sees the dialogs (denominator)", () => {
    expect(files).toEqual(expect.arrayContaining(["razorpay-configure-dialog.tsx", "whatsapp-configure-dialog.tsx"]));
  });

  it("detector catches an unnamed icon button and passes a named one", () => {
    const bad = `<Button size="sm" onClick={() => a && b(">")}>\n  <Icon name="copy" size={12} />\n</Button>`;
    const good = `<Button aria-label="Copy webhook URL" onClick={() => x}>\n  <Icon name="copy" />\n</Button>`;
    const text = `<Button onClick={() => x}><Icon name="copy" /> Copy</Button>`;
    expect(unnamedIconButtons("x.tsx", bad)).toEqual(["x.tsx:1"]);
    expect(unnamedIconButtons("x.tsx", good)).toEqual([]);
    expect(unnamedIconButtons("x.tsx", text)).toEqual([]);
  });

  it("zero unnamed icon-only buttons", () => {
    const hits = files.flatMap((f) => unnamedIconButtons(f, readFileSync(join(DIR, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
