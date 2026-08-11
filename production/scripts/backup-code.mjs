/**
 * One-command code + schema backup.
 *
 *   npm run backup:code
 *
 * Produces a timestamped ZIP of the committed codebase — which INCLUDES the full
 * database schema (every file in supabase/migrations/*.sql builds the DB). The
 * ZIP is written one level above the repo (outside git) so it never gets committed.
 *
 * Note: this archives the last COMMITTED state (git archive HEAD). Anything not
 * yet committed won't be included — commit first if you have pending changes.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const now = new Date();
const p = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;

// process.cwd() is the `production/` dir when run via npm. Write two levels up.
const dest = path.resolve(process.cwd(), "..", "..", `ResellerOS-code-backup-${stamp}.zip`);

try {
  execFileSync("git", ["archive", "--format=zip", "-o", dest, "HEAD"], { stdio: "inherit" });
  console.log(`\n✅ Code + schema backup saved:\n   ${dest}\n   (includes all supabase/migrations schema files)\n`);
} catch (err) {
  console.error("\n❌ Backup failed:", err.message);
  console.error("   Make sure you have committed your changes and git is installed.\n");
  process.exit(1);
}
