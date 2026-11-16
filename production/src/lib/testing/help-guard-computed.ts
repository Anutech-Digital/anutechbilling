/**
 * Help AI guard — computed member reads judged by DECLARATION (R-2882 / H-01c).
 *
 * Used by src/lib/security/help-tools-guard.test.ts (the guard test). It lives here, not in the test
 * file, only to keep that file under the repo's max-lines budget. Pure TypeScript-compiler code over
 * one source file at a time; nothing in the app imports it.
 */
import ts from "typescript";

/** Member names that lead to Function or the prototype chain — refused in every form (finding 1). */
export const FORBIDDEN_MEMBERS = new Set([
  "constructor", "__proto__", "prototype", "caller", "callee",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);

/** A declaration that leaves nothing at run time (so it cannot make a name "local"). */
export function isErasedDeclaration(d: ts.Declaration): boolean {
  if (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isTypeParameterDeclaration(d)) return true;
  if (ts.isImportSpecifier(d)) return d.isTypeOnly || d.parent.parent.isTypeOnly;
  if (ts.isImportClause(d)) return d.isTypeOnly;
  if (ts.isNamespaceImport(d)) return d.parent.isTypeOnly;
  if (ts.isImportEqualsDeclaration(d)) return d.isTypeOnly;
  return ts.canHaveModifiers(d) && !!ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
}


/**
 * Reflection helpers that read or rewrite the prototype chain or property descriptors (R-2882,
 * review of R-2879 finding 2): refused as a member name in every spelling, and as a string, in
 * every file the help tools reach.
 */
export const REFLECT_MEMBERS = new Set([
  "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties",
]);
/** Strings that name a way to Function / the prototype chain — refused in followed files (finding 2). */
export const FOLLOWED_FORBIDDEN_STRINGS = new Set(["constructor", "__proto__", "prototype", ...REFLECT_MEMBERS]);
/**
 * zod internals: a help file other than types.ts may not read them — `tool.input._def.unknownKeys =
 * "passthrough"` turns strictness off (R-2882, review of R-2879 finding 4). types.ts walks the schema
 * with them at registration and again before every parse.
 */
export const SCHEMA_INTERNALS = new Set(["_def", "_cached", "unknownKeys"]);

/**
 * R-2882 (review of R-2879 findings 1 and 2): `obj[expr]` with a computed key is judged by what the
 * key and the object are DECLARED as, resolved by the TypeScript checker — never by the text, which
 * let any `builder[m]` in reader.ts through whatever `builder` and `m` were. A computed read passes
 * when ONE of these holds:
 *   B. the key is a `const` loop variable of a for-of over a fixed list of string literals (written
 *      in place, or a local const `Object.freeze([...])`) — the key can only be one of those words;
 *   C. the key is the INDEX parameter of an array callback (map, forEach, filter …) whose receiver is
 *      an array literal, a fixed list, or the result of calling an imported function — a number;
 *   D. the object is a plain DATA MAP: a local const written as an object / array / string literal,
 *      Object.create(null), Object.fromEntries(...), or built by a local function that returns one.
 *      Reading such an object by any key gives a value or an Object.prototype member, never Function —
 *      and the next step (`.constructor`, another computed read of a non-map) is refused by the rules
 *      above and below.
 *   E. (files OUTSIDE help-tools only) an explicit entry on FOLLOWED_COMPUTED_SITES: file, enclosing
 *      function, object text and what the object is declared as must all still match.
 * Everything else — a parameter, an `any`, a function, a computed key built by `join` / `+` — fails.
 */
interface ComputedSite { file: string; fn: string; object: string; decl: string; why: string }
export const FOLLOWED_COMPUTED_SITES: readonly ComputedSite[] = [
  { file: "src/lib/company/summary.ts", fn: "openTicketCount", object: "counts", decl: "param Readonly<Record<string, number>> | null | undefined", why: "the key runs over OPEN_TICKET_STATUSES, three fixed status words" },
  { file: "src/lib/auth/roles.ts", fn: "can", object: "PERMISSIONS[role]", decl: "element of PERMISSIONS", why: "role has just passed isUserRole() and permission is keyof Permissions — both closed sets" },
  { file: "src/lib/utils.ts", fn: "gstinChecksum", object: "first14", decl: "param string", why: "the key is the loop counter over the string's own length (a number)" },
];
const ITERATION_METHODS = new Set(["map", "forEach", "filter", "some", "every", "find", "findIndex", "flatMap"]);

/** What the checker says about names in ONE file: no lib, no module resolution — "local" means declared in this very file. */
export interface Syms {
  isLocalName(id: ts.Identifier): boolean;
  declOf(id: ts.Identifier): ts.Declaration | undefined;
}
export function symbolsFor(sf: ts.SourceFile): Syms {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sf.fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === sf.fileName,
    readFile: () => undefined,
  };
  const checker = ts.createProgram({ rootNames: [sf.fileName], options: { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve }, host }).getTypeChecker();
  const symbolOf = (id: ts.Identifier) => (ts.isShorthandPropertyAssignment(id.parent) ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id));
  return {
    /* A type-only import / interface / type alias is erased: at run time the name is the GLOBAL of that name. */
    isLocalName: (id) => !!symbolOf(id) && (symbolOf(id)!.declarations ?? []).some((d) => d.getSourceFile() === sf && !isErasedDeclaration(d)),
    declOf: (id) => (symbolOf(id)?.declarations ?? []).find((d) => d.getSourceFile() === sf && !isErasedDeclaration(d)),
  };
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
  return x;
}
const isConstDecl = (d: ts.Declaration): d is ts.VariableDeclaration => ts.isVariableDeclaration(d) && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) !== 0;
/** `Object.<name>` — the callee of Object.freeze(...), Object.create(...), Object.fromEntries(...). */
function isObjectMember(callee: ts.Expression, name: string): boolean {
  const x = unwrapExpr(callee);
  return ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "Object" && x.name.text === name;
}
const isStringList = (e: ts.Expression): boolean => {
  const x = unwrapExpr(e);
  return ts.isArrayLiteralExpression(x) && x.elements.every((el) => ts.isStringLiteralLike(el) && !FORBIDDEN_MEMBERS.has(el.text) && !REFLECT_MEMBERS.has(el.text));
};

/** A fixed list of string literals: written in place, or a local const `Object.freeze([...])`. */
function closedList(sy: Syms, e: ts.Expression): boolean {
  const x = unwrapExpr(e);
  if (isStringList(x)) return true;
  if (!ts.isIdentifier(x)) return false;
  const d = sy.declOf(x);
  if (!d || !isConstDecl(d) || !d.initializer) return false;
  const init = unwrapExpr(d.initializer);
  return ts.isCallExpression(init) && isObjectMember(init.expression, "freeze") && init.arguments.length === 1 && isStringList(init.arguments[0]);
}

/** B — a `const` for-of variable over a closed list of names. */
function isClosedLoopVar(sy: Syms, id: ts.Identifier): boolean {
  const d = sy.declOf(id);
  if (!d || !isConstDecl(d) || !ts.isVariableDeclarationList(d.parent)) return false;
  const loop = d.parent.parent;
  return ts.isForOfStatement(loop) && loop.initializer === d.parent && !loop.awaitModifier && closedList(sy, loop.expression);
}

/** Is `e` an array we can trust to be an array: a literal, a fixed list, or built from an imported function (never a local object with its own `map`)? */
function trustedArray(sy: Syms, e: ts.Expression, depth = 0): boolean {
  if (depth > 6) return false;
  const x = unwrapExpr(e);
  if (ts.isArrayLiteralExpression(x)) return true;
  if (ts.isAwaitExpression(x)) return trustedArray(sy, x.expression, depth + 1);
  if (ts.isCallExpression(x)) {
    const callee = unwrapExpr(x.expression);
    return trustedArray(sy, ts.isPropertyAccessExpression(callee) ? callee.expression : callee, depth + 1);
  }
  if (ts.isPropertyAccessExpression(x)) return trustedArray(sy, x.expression, depth + 1);
  if (!ts.isIdentifier(x)) return false;
  const d = sy.declOf(x);
  if (!d) return false;
  if (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)) return true;
  if (isConstDecl(d) && d.initializer) return closedList(sy, x) || trustedArray(sy, d.initializer, depth + 1);
  return false;
}

/** C — the index parameter of an array callback (a number the engine passes). */
function isEngineIndex(sy: Syms, id: ts.Identifier): boolean {
  const d = sy.declOf(id);
  if (!d || !ts.isParameter(d)) return false;
  const fn = d.parent;
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters.indexOf(d) !== 1) return false;
  const call = fn.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== fn || !ts.isPropertyAccessExpression(call.expression) || !ITERATION_METHODS.has(call.expression.name.text)) return false;
  return trustedArray(sy, call.expression.expression);
}

/** D — a plain data map (see computedReadProblem). */
function dataMap(sy: Syms, e: ts.Expression, depth = 0): boolean {
  if (depth > 5) return false;
  const x = unwrapExpr(e);
  if (ts.isConditionalExpression(x)) return dataMap(sy, x.whenTrue, depth + 1) && dataMap(sy, x.whenFalse, depth + 1);
  if (ts.isObjectLiteralExpression(x) || ts.isArrayLiteralExpression(x) || ts.isStringLiteralLike(x) || ts.isTemplateExpression(x)) return true;
  if (ts.isCallExpression(x)) {
    if (isObjectMember(x.expression, "create")) return x.arguments.length === 1 && x.arguments[0].kind === ts.SyntaxKind.NullKeyword;
    if (isObjectMember(x.expression, "fromEntries")) return true;
    if (isObjectMember(x.expression, "freeze")) return x.arguments.length >= 1 && dataMap(sy, x.arguments[0], depth + 1);
    const callee = unwrapExpr(x.expression);
    const d = ts.isIdentifier(callee) ? sy.declOf(callee) : undefined;
    if (!d || !ts.isFunctionDeclaration(d) || !d.body) return false;
    // a local function whose every `return` hands back a data map (its own nested functions do not count)
    const rets: ts.ReturnStatement[] = [];
    const collect = (n: ts.Node): void => {
      if (ts.isReturnStatement(n)) rets.push(n);
      if (ts.isFunctionLike(n) && n !== d) return;
      ts.forEachChild(n, collect);
    };
    collect(d.body);
    return rets.length > 0 && rets.every((r) => !!r.expression && dataMap(sy, r.expression, depth + 1));
  }
  if (ts.isIdentifier(x)) {
    const d = sy.declOf(x);
    return !!d && isConstDecl(d) && !!d.initializer && dataMap(sy, d.initializer, depth + 1);
  }
  return false;
}

/** The function a node sits in, by name ("<module>" at the top). */
function enclosingFn(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  }
  return "<module>";
}
/** What an object expression is declared as, in the words FOLLOWED_COMPUTED_SITES uses. */
function describeObject(sy: Syms, sf: ts.SourceFile, e: ts.Expression): string {
  const x = unwrapExpr(e);
  if (ts.isElementAccessExpression(x)) return `element of ${unwrapExpr(x.expression).getText(sf)}`;
  const d = ts.isIdentifier(x) ? sy.declOf(x) : undefined;
  if (d && ts.isParameter(d)) return `param ${d.type ? d.type.getText(sf) : "-"}`;
  if (d && isConstDecl(d)) return "const";
  return ts.SyntaxKind[x.kind];
}

/**
 * Why `obj[expr]` is not allowed, or null when it is (rules B-E above). `used` collects the
 * FOLLOWED_COMPUTED_SITES entries that matched, so an entry nobody uses is reported.
 */
export function computedReadProblem(f: string, sf: ts.SourceFile, n: ts.ElementAccessExpression, sy: Syms, help: boolean, used?: Set<string>): string | null {
  const key = unwrapExpr(n.argumentExpression);
  if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return null; // a literal name: judged by the member rules
  if (ts.isIdentifier(key) && (isClosedLoopVar(sy, key) || isEngineIndex(sy, key))) return null;
  if (dataMap(sy, n.expression)) return null;
  if (!help) {
    const obj = unwrapExpr(n.expression).getText(sf);
    const decl = describeObject(sy, sf, n.expression);
    const fn = enclosingFn(n);
    const site = FOLLOWED_COMPUTED_SITES.find((s) => s.file === f && s.fn === fn && s.object === obj && s.decl === decl);
    if (site) { used?.add(`${site.file}|${site.fn}|${site.object}`); return null; }
  }
  return `${n.getText(sf).slice(0, 60)} — a computed member read the guard cannot tie to a declaration (a loop variable over a fixed list of names, an array callback's index, a plain data map${help ? "" : ", or an entry on FOLLOWED_COMPUTED_SITES"})`;
}

