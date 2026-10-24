// R-1460 (16 Oct 2026, Pawan via staging AI Help): React logged a style warning on
// /hosting — a shorthand (padding / margin / font …) and one of its longhands
// (paddingBottom / marginTop / fontWeight …) on the same element. React warns when
// one of them changes on a re-render, and the page re-renders as soon as it measures
// the window width, so every style here must use ONE form per property family:
//   1. no style object sets a shorthand together with its own longhand, and
//   2. a `cond ? {…} : {…}` style never uses the shorthand in one branch and the
//      longhand in the other (the plan-cards row swapped `{ margin, padding }` on a
//      phone for `{ marginTop }` on a desktop).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const FILE = join(__dirname, "HostingLanding.tsx");

const FAMILIES: Record<string, RegExp> = {
  padding: /^padding(Top|Bottom|Left|Right|Inline|Block)/,
  margin: /^margin(Top|Bottom|Left|Right|Inline|Block)/,
  border: /^border(Top|Bottom|Left|Right)(Width|Style|Color)?$|^border(Width|Style|Color)$/,
  borderRadius: /^border(Top|Bottom)(Left|Right)Radius$/,
  background: /^background(Color|Image|Position|Size|Repeat)$/,
  font: /^font(Family|Size|Weight|Style|Variant)$|^lineHeight$/,
  flex: /^flex(Grow|Shrink|Basis)$/,
  gap: /^(rowGap|columnGap)$/,
  overflow: /^overflow[XY]$/,
};

function keysOf(o: ts.ObjectLiteralExpression): string[] {
  const out: string[] = [];
  for (const p of o.properties) {
    if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out.push(p.name.text);
  }
  return out;
}

/** "shorthand" or "longhand" use of each family in one set of keys. */
function forms(keys: string[]): Map<string, Set<"shorthand" | "longhand">> {
  const m = new Map<string, Set<"shorthand" | "longhand">>();
  for (const [sh, re] of Object.entries(FAMILIES)) {
    const s = new Set<"shorthand" | "longhand">();
    if (keys.includes(sh)) s.add("shorthand");
    if (keys.some((k) => re.test(k))) s.add("longhand");
    if (s.size) m.set(sh, s);
  }
  return m;
}

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x)) x = x.expression;
  return x;
}

function scan(): { mixed: string[]; swapped: string[] } {
  const src = ts.createSourceFile(FILE, readFileSync(FILE, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const line = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const mixed: string[] = [];
  const swapped: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const [fam, s] of forms(keysOf(n))) if (s.size === 2) mixed.push(`line ${line(n)}: ${fam}`);
    }
    if (ts.isConditionalExpression(n)) {
      const a = unwrap(n.whenTrue), b = unwrap(n.whenFalse);
      if (ts.isObjectLiteralExpression(a) && ts.isObjectLiteralExpression(b)) {
        const fa = forms(keysOf(a)), fb = forms(keysOf(b));
        for (const [fam, sa] of fa) {
          const sb = fb.get(fam);
          if (sb && [...sa].some((f) => !sb.has(f))) swapped.push(`line ${line(n)}: ${fam}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return { mixed, swapped };
}

describe("HostingLanding styles use one form per property (R-1460)", () => {
  it("no style object mixes a shorthand with its own longhand", () => {
    expect(scan().mixed).toEqual([]);
  });

  it("no phone/desktop style swaps a shorthand for its longhand", () => {
    expect(scan().swapped).toEqual([]);
  });
});
