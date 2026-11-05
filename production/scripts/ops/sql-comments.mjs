/**
 * R-2491 (5 Nov 2026): SQL comments out, in ONE left-to-right pass — the one shared copy.
 *
 * Why one pass: the old way removed every block comment first and the line comments after. In
 * 20261011083000_r719_table_write_roles.sql the line comment "-- … /accounting/* by prefix)." then
 * opened a fake block comment that ran to the next star-slash, so role_column_write_guard() was not
 * seen and R-2485 was not listed as r719's later redefiner (deploy-db SUPS block, localhost-update).
 * Same miss in 5 more migrations ("-- … anutech/* branch").
 *
 * Here whichever starts first wins, as in PostgreSQL's own lexer:
 *   - `--` to the end of the line, and block comments (they NEST in PostgreSQL), become nothing / one space;
 *   - a comment mark inside a 'literal' ('' = a quote; E'…' also takes \' escapes) or a "quoted
 *     identifier" is text and is kept;
 *   - a dollar-quoted string ($$…$$, $tag$…$tag$) is kept with its tags, and its INSIDE is stripped
 *     on its own (a function body's own comments go, its literals stay) — so a stray apostrophe in a
 *     body (e.g. $m$can't$m$, or template text) can never run past the closing tag.
 * Unterminated comments / literals run to the end of the text (or of their dollar body). Never throws.
 *
 * Used by gen-deploy-db.mjs (redefinedObjects → SUPS / supersede peeks), so also by
 * localhost-update.mjs (imports gen-deploy-db), and by src/lib/security/direct-login-role-scan.test.ts.
 */
const SPECIAL = /--|\/\*|'|"|\$/g;
const DOLLAR_TAG = /\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

export function stripSqlComments(sql) {
  const s = String(sql ?? "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(s);
    if (!m) { out += s.slice(i); break; }
    out += s.slice(i, m.index);
    const at = m.index;
    const tok = m[0];
    if (tok === "--") {
      const nl = s.indexOf("\n", at);
      i = nl === -1 ? s.length : nl;
    } else if (tok === "/*") {
      i = endOfBlockComment(s, at);
      out += " ";
    } else if (tok === "'") {
      const escapes = at > 0 && /[eE]/.test(s[at - 1]) && (at < 2 || !IDENT_CHAR.test(s[at - 2]));
      const end = endOfQuoted(s, at, "'", escapes);
      out += s.slice(at, end);
      i = end;
    } else if (tok === '"') {
      const end = endOfQuoted(s, at, '"', false);
      out += s.slice(at, end);
      i = end;
    } else {
      /* `$`: a dollar-quote opener only when not part of an identifier/parameter (a$b, $1). */
      DOLLAR_TAG.lastIndex = at;
      const d = at > 0 && IDENT_CHAR.test(s[at - 1]) ? null : DOLLAR_TAG.exec(s);
      if (!d) { out += "$"; i = at + 1; continue; }
      const tag = d[0];
      const bodyStart = at + tag.length;
      const close = s.indexOf(tag, bodyStart);
      const bodyEnd = close === -1 ? s.length : close;
      out += tag + stripSqlComments(s.slice(bodyStart, bodyEnd)) + (close === -1 ? "" : tag);
      i = close === -1 ? s.length : close + tag.length;
    }
  }
  return out;
}

/** Index just after the block comment opening at `at` (nested block comments counted); end of text if unclosed. */
function endOfBlockComment(s, at) {
  let depth = 0;
  let j = at;
  while (j < s.length) {
    if (s.startsWith("/*", j)) { depth += 1; j += 2; }
    else if (s.startsWith("*/", j)) { depth -= 1; j += 2; if (depth === 0) return j; }
    else j += 1;
  }
  return s.length;
}

/** Index just after the quoted text opening at `at` (doubled quote = one quote; with `escapes`, backslash escapes). */
function endOfQuoted(s, at, q, escapes) {
  let j = at + 1;
  while (j < s.length) {
    if (escapes && s[j] === "\\") { j += 2; continue; }
    if (s[j] === q) {
      if (s[j + 1] === q) { j += 2; continue; }
      return j + 1;
    }
    j += 1;
  }
  return s.length;
}
