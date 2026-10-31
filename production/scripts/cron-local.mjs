/**
 * `npm run cron:local <job> [-- --dry] [--port 3001] [--post]` — call one /api/cron/<job> route on the
 * LOCAL dev:local server (R-2106, 31 Oct 2026).
 *
 * 29 Oct demo: every localhost cron answered 401. `npm run dev:local` sets CRON_SECRET itself (the value
 * below) and blanks the .env.local one, so a curl with the .env.local secret can never match. This sends
 * the dev:local secret. `--dry` adds ?dry=1 (the cron gate's practice run: no send, no write).
 * Refuses anything but localhost. tests/ops/localhost-update.test.ts pins this value to dev-local.mjs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Must equal the CRON_SECRET scripts/dev-local.mjs puts in the dev server's env. */
export const LOCAL_CRON_SECRET = "local-dev-cron-secret";

export function parseCronArgs(argv) {
  const out = { job: null, dry: false, port: 3001, post: false, host: "localhost" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry" || a === "--dry-run") out.dry = true;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--post") out.post = true;
    else if (a.startsWith("--")) throw new Error(`Unknown flag ${a} (--dry / --port <n> / --post)`);
    else if (!out.job) out.job = a.replace(/^\/?(api\/cron\/)?/, "").replace(/\/+$/, "");
    else throw new Error(`Ek hi job do (mila: ${out.job}, ${a})`);
  }
  if (!out.job || !/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(out.job)) throw new Error("job do, jaise: npm run cron:local renewals -- --dry");
  if (!Number.isInteger(out.port) || out.port <= 0) throw new Error("--port galat");
  return out;
}

export function cronUrl({ job, dry, port, host = "localhost" }) {
  const u = new URL(`http://${host}:${port}/api/cron/${job}`);
  if (dry) u.searchParams.set("dry", "1");
  return u.toString();
}

async function main(argv) {
  let a;
  try { a = parseCronArgs(argv); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  const url = cronUrl(a);
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) { console.error("✗ sirf localhost."); process.exit(1); }
  console.log(`${a.post ? "POST" : "GET"} ${url}`);
  const res = await fetch(url, { method: a.post ? "POST" : "GET", headers: { authorization: `Bearer ${LOCAL_CRON_SECRET}` } });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 4000));
  if (res.status === 401) console.log("401: server dev:local se nahi chala? (npm run dev chalta hai to .env.local ka CRON_SECRET lagta hai)");
  process.exit(res.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
