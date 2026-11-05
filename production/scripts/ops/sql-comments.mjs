/**
 * R-2491 (5 Nov 2026): SQL comments out, in ONE left-to-right pass — the one shared copy.
 *
 * Why one pass: the old way removed every block comment first and the line comments after. In
 * 20261011083000_r719_table_write_roles.sql the line comment "-- … /accounting/* by prefix)." then
 * opened a fake block comment that ran to the next star-slash, so role_column_write_guard() was not
 * seen and R-2485 was not listed as r719's later redefiner (deploy-db SUPS block, localhost-update).
 * Here whichever starts first wins: a slash-star inside a line comment is just text, two dashes
 * inside a block comment are just text, and neither starts a comment inside a 'string literal'
 * ('' inside a literal is a quote, kept). Block comments do not nest (as before). Text in literals
 * is kept as it is.
 *
 * Used by gen-deploy-db.mjs (redefinedObjects → SUPS / supersede peeks), so also by
 * localhost-update.mjs (imports gen-deploy-db), and by src/lib/security/direct-login-role-scan.test.ts.
 */
export function stripSqlComments(sql) {
  const s = String(sql ?? "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (two === "--") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
    } else if (two === "/*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      out += " ";
    } else if (s[i] === "'") {
      let j = i + 1;
      while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}
