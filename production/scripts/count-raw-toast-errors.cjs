/**
 * `toast.error(...)` ke call-sites ginta hai aur batata hai kitne NANGE hain
 * (na `description:` na `action:` — §24 ke teeno hisse nahi).
 * Ratchet-test (lib/errors/toast-error-ratchet.test.ts) isi ginti par khada hai.
 */
const fs = require("fs");
const path = require("path");

function* walk(dir, skipDir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".") || skipDir(p)) continue;
      yield* walk(p, skipDir);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
      yield p;
    }
  }
}

/** toast.error( se matching band-paren tak ka text. */
function callText(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start, start + 400);
}

/**
 * R-2564 (7 Nov 2026): the guard tests pass `read` (the shared, always-fresh read cache) and
 * `skipDir` (Prisma's generated client — not our code, 36 MB). The CLI keeps the plain defaults.
 */
function countRaw(root, { read = (f) => fs.readFileSync(f, "utf8"), skipDir = () => false } = {}) {
  let total = 0;
  let raw = 0;
  const rawByFile = new Map();
  for (const f of walk(root, skipDir)) {
    const src = read(f);
    let idx = 0;
    for (;;) {
      const at = src.indexOf("toast.error(", idx);
      if (at === -1) break;
      idx = at + 12;
      total++;
      const call = callText(src, at + 11);
      if (!/description\s*:/.test(call) && !/action\s*:/.test(call)) {
        raw++;
        rawByFile.set(f, (rawByFile.get(f) ?? 0) + 1);
      }
    }
  }
  return { total, raw, rawByFile };
}

module.exports = { countRaw };

if (require.main === module) {
  const { total, raw, rawByFile } = countRaw(path.join(process.cwd(), "src"));
  console.log(`toast.error total: ${total} · NANGE (na description na action): ${raw}`);
  const top = [...rawByFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [f, n] of top) console.log(`  ${n}  ${path.relative(process.cwd(), f)}`);
}
