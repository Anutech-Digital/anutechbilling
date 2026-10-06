import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * R-191: the phone card on /customers was one big <Link> with a WhatsApp <a> inside it.
 * HTML forbids <a> inside <a>, so React logged a hydration error on every load (hiding real
 * errors) and on some browsers tapping WhatsApp opened the customer instead.
 *
 * This walks the page's JSX and fails if any link element (<a> or <Link>) has another link
 * element anywhere inside it.
 */
const LINK_TAGS = new Set(["a", "Link"]);

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const t = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return t.getText();
}

function nestedLinks(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node, outer: string | null) => {
    let next = outer;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = tagName(node);
      if (LINK_TAGS.has(name)) {
        if (outer) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          found.push(`<${name}> at line ${line} is inside ${outer}`);
        }
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        next = `<${name}> (line ${line})`;
      }
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sf, null);
  return found;
}

describe("customers page — no link inside a link (R-191)", () => {
  it("has no <a>/<Link> nested in another <a>/<Link>", () => {
    const file = path.join(__dirname, "page.tsx");
    expect(nestedLinks(file)).toEqual([]);
  });
});
