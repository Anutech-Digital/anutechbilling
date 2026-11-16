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
 * R-2882 round 3: a computed member read `x[k]` — and a write through one, `x[k] = v` — is judged by
 * NOTHING about what `x` or `k` might be. Two rounds of "is this object trustworthy" reasoning (trusted
 * arrays, data maps, callback indexes) each lost to one more way to rewrite a prototype or a name, so
 * that reasoning is gone. In every file the help tools reach, a computed read passes only when
 *   (a) the key is a numeric literal, or a string literal (never constructor / __proto__ / prototype —
 *       the member rules refuse those words wherever they appear), or
 *   (b) the site is an entry on COMPUTED_READ_ALLOWED, pinned by file + enclosing function + what the
 *       object is declared as + what the key is declared as, with a written reason; an object that the
 *       module exports must say so (`exported: true`) — other files in the graph may not write to an
 *       imported binding (importedWriteProblems), so the export alone does not let them rewrite it.
 * Files under help-tools are never allow-listed: they use literal keys, `switch`, `Map` or `.at()`.
 * `Object` and the other globals the rules lean on may not be declared locally (GUARDED_GLOBALS), and
 * an imported binding may not be written to (member assignment, delete, Object.assign).
 */
interface ComputedSite { file: string; fn: string; object: string; decl: string; key: string; why: string; /** the object is exported from its module — allowed only when written here (importers cannot write to it: importedWriteProblems) */ exported?: true }
export const COMPUTED_READ_ALLOWED: readonly ComputedSite[] = [
  { file: "src/lib/navigation/drilldown.ts", fn: "drillHref", object: "DRILL", decl: "const", key: "param#0 of drillHref", why: "name is the DrillName union of the module's own names; it reads the module's own href table, never model text", exported: true },
  { file: "src/lib/dates/ist.ts", fn: "formatIstDate", object: "MONTHS", decl: "const", key: "BinaryExpression", why: "a month number (arithmetic on a parsed date) indexes the module's own month-name list" },
  { file: "src/lib/dates/ist.ts", fn: "formatMonthLabel", object: "opts.month === \"long\" ? MONTHS_LONG : MONTHS", decl: "ConditionalExpression", key: "BinaryExpression", why: "a month number (arithmetic on a parsed date) indexes the module's own month-name list" },
  { file: "src/lib/company/summary.ts", fn: "openTicketCount", object: "counts", decl: "param Readonly<Record<string, number>> | null | undefined", key: "param#1 of OPEN_TICKET_STATUSES.reduce", why: "the key runs over OPEN_TICKET_STATUSES, three fixed status words, on a counts object the caller passes" },
  { file: "src/lib/subscriptions/folders.ts", fn: "folderCounts", object: "counts", decl: "const", key: "CallExpression", why: "counts keyed by the folder name folderOf() returns (a closed union) on a record built in this function" },
  { file: "src/lib/invoices/kpis.ts", fn: "invoiceChipCounts", object: "map", decl: "const", key: "const in for-of", why: "chip counts keyed by the invoice chip names this file itself lists, on a record built in this function" },
  { file: "src/lib/invoices/kpis.ts", fn: "invoiceChipCounts", object: "map", decl: "const", key: "const", why: "chip counts keyed by the invoice chip names this file itself lists, on a record built in this function" },
  { file: "src/lib/utils.ts", fn: "enIn", object: "FORMAT_OPTIONS", decl: "const", key: "param#0 of enIn", why: "the key picks a row of a table this module declares itself (format preset, currency, GST state, GSTIN alphabet, digit index)" },
  { file: "src/lib/utils.ts", fn: "gstinChecksum", object: "first14", decl: "param string", key: "let in for-statement", why: "the key is the loop counter over the string's own length (a number)" },
  { file: "src/lib/utils.ts", fn: "gstinChecksum", object: "GSTIN_CHARS", decl: "const", key: "const", why: "the key picks a row of a table this module declares itself (format preset, currency, GST state, GSTIN alphabet, digit index)" },
  { file: "src/lib/utils.ts", fn: "formatForeignAmount", object: "sym", decl: "const", key: "const", why: "the key picks a row of a table this module declares itself (format preset, currency, GST state, GSTIN alphabet, digit index)" },
  { file: "src/lib/utils.ts", fn: "gstStateFromGstin", object: "GST_STATE_BY_CODE", decl: "const", key: "const", why: "the key picks a row of a table this module declares itself (format preset, currency, GST state, GSTIN alphabet, digit index)", exported: true },
  { file: "src/lib/auth/roles.ts", fn: "roleLabel", object: "ROLE_LABEL", decl: "const", key: "BinaryExpression", why: "the key is a UserRole / Permission from the module's own closed sets, read from the module's own table", exported: true },
  { file: "src/lib/auth/roles.ts", fn: "can", object: "PERMISSIONS[role]", decl: "element of PERMISSIONS", key: "param#1 of can", why: "role has just passed isUserRole() and permission is keyof Permissions — both closed sets" },
  { file: "src/lib/auth/roles.ts", fn: "can", object: "PERMISSIONS", decl: "const", key: "param#0 of can", why: "the key is a UserRole / Permission from the module's own closed sets, read from the module's own table", exported: true },
  { file: "src/lib/auth/roles.ts", fn: "isGatewayLimitedRole", object: "GATEWAY_LIMITED_BY_ROLE", decl: "const", key: "param#0 of isGatewayLimitedRole", why: "the key is a UserRole / Permission from the module's own closed sets, read from the module's own table", exported: true },
  { file: "src/lib/nav.ts", fn: "isRouteAllowed", object: "ROUTE_DENY", decl: "const", key: "param#0 of isRouteAllowed", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input", exported: true },
  { file: "src/lib/nav.ts", fn: "isRouteAllowed", object: "OFF_MENU_ROLES", decl: "const", key: "const", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input", exported: true },
  { file: "src/lib/nav.ts", fn: "homeForRole", object: "ROLE_HOME", decl: "const", key: "param#0 of homeForRole", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input", exported: true },
  { file: "src/lib/nav.ts", fn: "navCrumbs", object: "out", decl: "const", key: "PropertyAccessExpression", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input" },
  { file: "src/lib/nav.ts", fn: "buildScreenTitles", object: "fromNav", decl: "const", key: "Identifier", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input" },
  { file: "src/lib/nav.ts", fn: "buildScreenTitles", object: "fromNav", decl: "const", key: "BinaryExpression", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input" },
  { file: "src/lib/nav.ts", fn: "buildScreenTitles", object: "out", decl: "const", key: "Identifier", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input" },
  { file: "src/lib/nav.ts", fn: "getCrumb", object: "SCREEN_TITLES", decl: "const", key: "param#0 of getCrumb", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input", exported: true },
  { file: "src/lib/nav.ts", fn: "getCrumb", object: "SCREEN_TITLES", decl: "const", key: "const", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input", exported: true },
  { file: "src/lib/nav.ts", fn: "getCrumb", object: "SCREEN_TITLES", decl: "const", key: "TemplateExpression", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input", exported: true },
  { file: "src/lib/nav.ts", fn: "crumbForRole", object: "PERSONAL_MONEY_TABS", decl: "const", key: "const", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input" },
  { file: "src/lib/nav.ts", fn: "getParentListHref", object: "SCREEN_TITLES", decl: "const", key: "const", why: "route / role / title keys of the module's own navigation tables, built from APP_NAV — app strings, never model input", exported: true },
  { file: "src/lib/phone.ts", fn: "dialCodeForCountry", object: "DIAL", decl: "const", key: "const", why: "an ISO country or dial code looked up in the module's own country tables" },
  { file: "src/lib/phone.ts", fn: "phoneDigitsForCountry", object: "NATIONAL_LENGTH", decl: "const", key: "const", why: "an ISO country or dial code looked up in the module's own country tables" },
  { file: "src/lib/phone.ts", fn: "phoneDigitsForCountry", object: "NATIONAL_MAX", decl: "const", key: "const", why: "an ISO country or dial code looked up in the module's own country tables" },
];
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
/** No file declares its own Object / Array / Reflect / JSON / Function … — a look-alike would hide the real one. */
export function shadowedGlobalProblems(sf: ts.SourceFile, at: (n: ts.Node) => string): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && GUARDED_GLOBALS.has(n.text) && declaredName(n)) out.push(`${at(n)}: declares ${n.text}, which shadows a global the guard's rules rely on`);
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

/** The leftmost name of `a.b[c].d`, looking through `as` / `!` / parentheses. */
function rootIdentifier(e: ts.Expression): ts.Identifier | undefined {
  let x = unwrapExpr(e);
  while (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) x = unwrapExpr(x.expression);
  return ts.isIdentifier(x) ? x : undefined;
}
const isImportBinding = (d: ts.Declaration | undefined): boolean => !!d && (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d) || ts.isImportEqualsDeclaration(d));
/**
 * An imported binding is another module's object: this file may not assign to a member of it, delete
 * one, or hand it to Object.assign (R-2882 round 3 — `(arr as any).map = …` rewrites it for every file).
 */
export function importedWriteProblems(sf: ts.SourceFile, sy: Syms, at: (n: ts.Node) => string): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isWriteTarget(n)) {
      const root = rootIdentifier(n.expression);
      if (root && isImportBinding(sy.declOf(root))) out.push(`${at(n)}: writes to a member of the imported ${root.text} (another module's object)`);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "assign" && n.arguments.length) {
      const root = rootIdentifier(n.arguments[0]);
      if (root && isImportBinding(sy.declOf(root))) out.push(`${at(n)}: Object.assign onto the imported ${root.text}`);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
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
/** What an object expression is declared as, in the words COMPUTED_READ_ALLOWED uses. */
function describeObject(sy: Syms, sf: ts.SourceFile, e: ts.Expression): string {
  const x = unwrapExpr(e);
  if (ts.isElementAccessExpression(x)) return `element of ${unwrapExpr(x.expression).getText(sf)}`;
  const d = ts.isIdentifier(x) ? sy.declOf(x) : undefined;
  if (d && ts.isParameter(d)) return `param ${d.type ? d.type.getText(sf) : "-"}`;
  if (d && isConstDecl(d)) return "const";
  return ts.SyntaxKind[x.kind];
}
/** What the key is declared as: a parameter's position and function, a for-loop `let`, a const … */
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
    if (ts.isVariableDeclarationList(list) && ts.isForOfStatement(list.parent)) return "const in for-of";
    return isConstDecl(d) ? "const" : "let";
  }
  return ts.SyntaxKind[x.kind];
}
/** Is this identifier's binding visible to other files (`export const X`, `export { X }`, `export default X`)? */
function isExportedBinding(sy: Syms, id: ts.Identifier): boolean {
  const d = sy.declOf(id);
  if (!d) return false;
  const stmt = ts.isVariableDeclaration(d) ? d.parent.parent : d;
  if (ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  // `export { X }` / `export { X as Y }` / `export default X` — by the local NAME (the checker's alias symbol is a different symbol)
  let found = false;
  const walk = (n: ts.Node): void => {
    if (ts.isExportSpecifier(n) && !n.parent.parent.moduleSpecifier && (n.propertyName ?? n.name).text === id.text) found = true;
    if (ts.isExportAssignment(n) && ts.isIdentifier(unwrapExpr(n.expression)) && (unwrapExpr(n.expression) as ts.Identifier).text === id.text) found = true;
    ts.forEachChild(n, walk);
  };
  walk(id.getSourceFile());
  return found;
}

/**
 * Why `obj[expr]` is not allowed, or null when it is (rule above). `used` collects the
 * COMPUTED_READ_ALLOWED entries that matched, so an entry nobody uses is reported.
 */
export function computedReadProblem(f: string, sf: ts.SourceFile, n: ts.ElementAccessExpression, sy: Syms, used?: Set<string>): string | null {
  const key = unwrapExpr(n.argumentExpression);
  if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return null; // a literal name: judged by the member rules
  const objNode = unwrapExpr(n.expression);
  const obj = objNode.getText(sf);
  const decl = describeObject(sy, sf, n.expression);
  const fn = enclosingFn(n);
  const kd = describeKey(sy, sf, key);
  const site = COMPUTED_READ_ALLOWED.find((s) => s.file === f && s.fn === fn && s.object === obj && s.decl === decl && s.key === kd);
  const exported = ts.isIdentifier(objNode) && isExportedBinding(sy, objNode);
  if (site && (!exported || site.exported)) { used?.add(`${site.file}|${site.fn}|${site.object}|${site.key}`); return null; }
  return `${n.getText(sf).slice(0, 60)} — a computed member read: use a literal key, a switch or a Map, or add a pinned entry to COMPUTED_READ_ALLOWED (file + function + object + key declaration + reason; an object the module exports needs exported: true) — this site is ${JSON.stringify({ file: f, fn, object: obj, decl, key: kd, exported })}`;
}
