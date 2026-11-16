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
 *      in place, or a local const `Object.freeze([...])` of the REAL Object) — one of those words;
 *   C. the key is the INDEX parameter of an array callback (map, forEach, filter …) whose receiver is
 *      an array literal, a fixed list, or the result of calling an imported function, and — when the
 *      receiver is a local name — that name is only ever READ (never assigned, never a member
 *      assigned, never handed on): a number the engine passes, not a replaced `map` handing out words;
 *   D. the object is a DATA MAP. In help files: only a local const `Object.create(null)` of the REAL
 *      Object (no prototype, so "constructor" / "__proto__" read nothing), or an array / string
 *      literal, or what a local never-reassigned function returns. In files outside help-tools a
 *      literal object / Object.fromEntries(...) also counts (their keys come from the app, and
 *      `__proto__` is refused in them);
 *   E. (files OUTSIDE help-tools only) an explicit entry on FOLLOWED_COMPUTED_SITES: file, enclosing
 *      function, object text, what the object is declared as AND what the key is declared as.
 * `Object` only counts when it is the global: a local declaration of it (or of any global the guard
 * reasons about — GUARDED_GLOBALS) is refused outright. Everything else — a parameter, an `any`, a
 * function, a key built by `join` / `+` — fails.
 */
interface ComputedSite { file: string; fn: string; object: string; decl: string; key: string; why: string }
export const FOLLOWED_COMPUTED_SITES: readonly ComputedSite[] = [
  { file: "src/lib/company/summary.ts", fn: "openTicketCount", object: "counts", decl: "param Readonly<Record<string, number>> | null | undefined", key: "param#1 of OPEN_TICKET_STATUSES.reduce", why: "the key runs over OPEN_TICKET_STATUSES, three fixed status words" },
  { file: "src/lib/auth/roles.ts", fn: "can", object: "PERMISSIONS[role]", decl: "element of PERMISSIONS", key: "param#1 of can", why: "role has just passed isUserRole() and permission is keyof Permissions — both closed sets" },
  { file: "src/lib/utils.ts", fn: "gstinChecksum", object: "first14", decl: "param string", key: "let in for-statement", why: "the key is the loop counter over the string's own length (a number)" },
];
const ITERATION_METHODS = new Set(["map", "forEach", "filter", "some", "every", "find", "findIndex", "flatMap"]);
/** Methods a trusted local array may be asked for: none of them changes it. */
const READ_METHODS = new Set([...ITERATION_METHODS, "slice", "indexOf", "includes", "join", "at", "concat", "reduce"]);
/** Globals the guard's rules lean on (or whose shadowing would hide an ambient power): never declared locally. */
export const GUARDED_GLOBALS = new Set([
  "Object", "Array", "Reflect", "JSON", "Symbol", "Function", "globalThis", "Math", "Number", "String", "Boolean", "Promise",
  "Map", "Set", "WeakMap", "WeakSet", "Date", "Error", "Buffer", "crypto", "console", "Proxy", "Intl", "undefined", "NaN", "Infinity",
]);

/** What the checker says about names in ONE file: no lib, no module resolution — "local" means declared in this very file. */
export interface Syms {
  isLocalName(id: ts.Identifier): boolean;
  declOf(id: ts.Identifier): ts.Declaration | undefined;
  /** Every identifier in the file that names the same thing (the declaration's own name included). */
  usesOf(id: ts.Identifier): ts.Identifier[];
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
    usesOf: (id) => {
      const s = symbolOf(id);
      const out: ts.Identifier[] = [];
      const walk = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && s && symbolOf(n) === s) out.push(n);
        ts.forEachChild(n, walk);
      };
      walk(sf);
      return out;
    },
  };
}

/** A name that declares something at run time: variable, parameter, function, class, import, enum, binding. */
function declaredName(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isTypeParameterDeclaration(p)) return false;
  return (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p)
    || ts.isClassExpression(p) || ts.isBindingElement(p) || ts.isEnumDeclaration(p) || ts.isModuleDeclaration(p) || ts.isImportClause(p)
    || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p)) && p.name === n
    || (ts.isImportSpecifier(p) && p.name === n && !(p.isTypeOnly || p.parent.parent.isTypeOnly));
}
/** R-2882 (review of R-2882 BLOCK 1): no file declares its own Object / Array / Reflect / JSON / Function … — a look-alike would make `Object.create(null)` or `Object.freeze` mean anything. */
export function shadowedGlobalProblems(sf: ts.SourceFile, at: (n: ts.Node) => string): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && GUARDED_GLOBALS.has(n.text) && declaredName(n)) out.push(`${at(n)}: declares ${n.text}, which shadows the global the guard's rules rely on`);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
  return x;
}
const isConstDecl = (d: ts.Declaration): d is ts.VariableDeclaration => ts.isVariableDeclaration(d) && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) !== 0;
/** `Object.<name>` — the callee of Object.freeze(...), Object.create(...), Object.fromEntries(...); `Object` must be the GLOBAL. */
function isObjectMember(sy: Syms, callee: ts.Expression, name: string): boolean {
  const x = unwrapExpr(callee);
  return ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "Object" && !sy.isLocalName(x.expression) && x.name.text === name;
}
const isStringList = (e: ts.Expression): boolean => {
  const x = unwrapExpr(e);
  return ts.isArrayLiteralExpression(x) && x.elements.every((el) => ts.isStringLiteralLike(el) && !FORBIDDEN_MEMBERS.has(el.text) && !REFLECT_MEMBERS.has(el.text));
};

/** The node that stands for `n` once parentheses, `as`, `!` and `satisfies` are looked through, and its parent. */
function through(n: ts.Node): { node: ts.Node; parent: ts.Node } {
  let node = n;
  while (node.parent && (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isNonNullExpression(node.parent) || ts.isSatisfiesExpression(node.parent) || ts.isTypeAssertionExpression(node.parent))) node = node.parent;
  return { node, parent: node.parent };
}
const ASSIGN_OPS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);
/** Is `n` written to: an assignment target (also inside a destructuring pattern), ++ / --, delete, or a for-in / for-of target? */
function isWriteTarget(n: ts.Node): boolean {
  const { node, parent } = through(n);
  if (ts.isBinaryExpression(parent) && parent.left === node && ASSIGN_OPS.has(parent.operatorToken.kind)) return true;
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  if (ts.isDeleteExpression(parent)) return true;
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) return true;
  // inside an assignment pattern: [x] = …, { a: x } = …
  for (let p: ts.Node = node; p.parent; p = p.parent) {
    if (ts.isArrayLiteralExpression(p.parent) || ts.isObjectLiteralExpression(p.parent) || ts.isPropertyAssignment(p.parent) || ts.isShorthandPropertyAssignment(p.parent) || ts.isSpreadElement(p.parent) || ts.isSpreadAssignment(p.parent)) continue;
    return ts.isBinaryExpression(p.parent) && p.parent.left === p && ASSIGN_OPS.has(p.parent.operatorToken.kind) && p !== node;
  }
  return false;
}

/**
 * R-2882 (BLOCK 2): a local name the guard trusts — an array whose `.map` hands out the index, a
 * function that returns a data map — must be only READ in the file: never assigned (also through
 * `(f as any) = …`), no member assigned or deleted, only non-mutating methods called, and never
 * handed on (passed to a call, returned, aliased) where it could be rewritten. `callee: true` is for a
 * function name, whose only allowed use is being called.
 */
function onlyRead(sy: Syms, id: ts.Identifier, callee = false): boolean {
  const d = sy.declOf(id);
  if (!d) return false;
  for (const u of sy.usesOf(id)) {
    if ((ts.isVariableDeclaration(d) || ts.isFunctionDeclaration(d)) && d.name === u) continue;
    if (isWriteTarget(u)) return false;
    const { node, parent } = through(u);
    if (callee) { if (ts.isCallExpression(parent) && parent.expression === node) continue; return false; }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (isWriteTarget(parent)) return false;
      const call = through(parent).parent;
      const called = ts.isCallExpression(call) && unwrapExpr(call.expression) === parent;
      if (called ? !READ_METHODS.has(parent.name.text) : parent.name.text !== "length") return false;
      continue;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === node) { if (isWriteTarget(parent)) return false; continue; }
    if (ts.isForOfStatement(parent) && parent.expression === node) continue;
    if (ts.isSpreadElement(parent)) continue;
    return false;
  }
  return true;
}

/** A fixed list of string literals: written in place, or a local const `Object.freeze([...])`. */
function closedList(sy: Syms, e: ts.Expression): boolean {
  const x = unwrapExpr(e);
  if (isStringList(x)) return true;
  if (!ts.isIdentifier(x)) return false;
  const d = sy.declOf(x);
  if (!d || !isConstDecl(d) || !d.initializer) return false;
  const init = unwrapExpr(d.initializer);
  return ts.isCallExpression(init) && isObjectMember(sy, init.expression, "freeze") && init.arguments.length === 1 && isStringList(init.arguments[0]);
}

/** B — a `const` for-of variable over a closed list of names. */
function isClosedLoopVar(sy: Syms, id: ts.Identifier): boolean {
  const d = sy.declOf(id);
  if (!d || !isConstDecl(d) || !ts.isVariableDeclarationList(d.parent)) return false;
  const loop = d.parent.parent;
  return ts.isForOfStatement(loop) && loop.initializer === d.parent && !loop.awaitModifier && closedList(sy, loop.expression);
}

/** Is `e` an array we can trust to be an array: a literal, a fixed list, or built from an imported function — and a local name only if it is never rewritten? */
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
  if (isConstDecl(d) && d.initializer) return closedList(sy, x) || (trustedArray(sy, d.initializer, depth + 1) && onlyRead(sy, x));
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

/** D — a data map (see computedReadProblem). `help`: only a null-prototype map, an array or a string counts. */
function dataMap(sy: Syms, e: ts.Expression, help: boolean, depth = 0): boolean {
  if (depth > 5) return false;
  const x = unwrapExpr(e);
  if (ts.isConditionalExpression(x)) return dataMap(sy, x.whenTrue, help, depth + 1) && dataMap(sy, x.whenFalse, help, depth + 1);
  if (ts.isArrayLiteralExpression(x) || ts.isStringLiteralLike(x) || ts.isTemplateExpression(x)) return true;
  if (ts.isObjectLiteralExpression(x)) return !help;
  if (ts.isCallExpression(x)) {
    if (isObjectMember(sy, x.expression, "create")) return x.arguments.length === 1 && x.arguments[0].kind === ts.SyntaxKind.NullKeyword;
    if (isObjectMember(sy, x.expression, "fromEntries")) return !help;
    if (isObjectMember(sy, x.expression, "freeze")) return x.arguments.length >= 1 && dataMap(sy, x.arguments[0], help, depth + 1);
    const callee = unwrapExpr(x.expression);
    const d = ts.isIdentifier(callee) ? sy.declOf(callee) : undefined;
    if (!d || !ts.isFunctionDeclaration(d) || !d.body || !ts.isIdentifier(callee) || !onlyRead(sy, callee, true)) return false;
    // a local function (never reassigned) whose every `return` hands back a data map (its own nested functions do not count)
    const rets: ts.ReturnStatement[] = [];
    const collect = (n: ts.Node): void => {
      if (ts.isReturnStatement(n)) rets.push(n);
      if (ts.isFunctionLike(n) && n !== d) return;
      ts.forEachChild(n, collect);
    };
    collect(d.body);
    return rets.length > 0 && rets.every((r) => !!r.expression && dataMap(sy, r.expression, help, depth + 1));
  }
  if (ts.isIdentifier(x)) {
    const d = sy.declOf(x);
    return !!d && isConstDecl(d) && !!d.initializer && dataMap(sy, d.initializer, help, depth + 1);
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
/** What the key is declared as: a parameter's position and function, a for-loop `let`, a const … (R-2882 review item 7). */
function describeKey(sy: Syms, sf: ts.SourceFile, e: ts.Expression): string {
  const x = unwrapExpr(e);
  const d = ts.isIdentifier(x) ? sy.declOf(x) : undefined;
  if (d && ts.isParameter(d)) {
    const fn = d.parent;
    const call = (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isCallExpression(fn.parent) ? fn.parent : undefined;
    const label = call ? unwrapExpr(call.expression).getText(sf) : ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text : enclosingFn(d);
    return `param#${fn.parameters.indexOf(d)} of ${label}`;
  }
  if (d && ts.isVariableDeclaration(d)) {
    const list = d.parent;
    if (ts.isVariableDeclarationList(list) && ts.isForStatement(list.parent)) return `${isConstDecl(d) ? "const" : "let"} in for-statement`;
    return isConstDecl(d) ? "const" : "let";
  }
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
  if (dataMap(sy, n.expression, help)) return null;
  if (!help) {
    const obj = unwrapExpr(n.expression).getText(sf);
    const decl = describeObject(sy, sf, n.expression);
    const fn = enclosingFn(n);
    const kd = describeKey(sy, sf, key);
    const site = FOLLOWED_COMPUTED_SITES.find((s) => s.file === f && s.fn === fn && s.object === obj && s.decl === decl && s.key === kd);
    if (site) { used?.add(`${site.file}|${site.fn}|${site.object}`); return null; }
  }
  return `${n.getText(sf).slice(0, 60)} — a computed member read the guard cannot tie to a declaration (a loop variable over a fixed list of names, an array callback's index, a data map${help ? " with no prototype" : ", or an entry on FOLLOWED_COMPUTED_SITES"})`;
}
