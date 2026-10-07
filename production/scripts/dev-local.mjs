#!/usr/bin/env node
/**
 * `npm run dev:local` — dev server jo PRODUCTION ko chhoo hi nahi sakta (S8, 28 Sep 2026).
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * `.env.local` production database ki service-role key rakhta hai, aur saath mein live
 * Razorpay, Resend, Gupshup, Vapi, Google reseller, GST IRP ki keys. `npm run dev` wahi padhta
 * hai — yaani laptop par ek galat click, test ya script = asli customer ka data badla, asli
 * email/WhatsApp gaya, asli call hui. Staging (docs/STAGING.md) abhi bana nahi hai.
 *
 * ─── KAISE ──────────────────────────────────────────────────────────────────
 * Next.js `.env*` files se koi variable tab NAHI leta jab wo process.env mein pehle se ho —
 * khaali string bhi (`@next/env` hasOwnProperty dekhta hai). To ye script:
 *   1. Supabase ko LOCAL stack par le jaati hai (`supabase status`), aur localhost ke
 *      alawa kuch mile to ruk jaati hai;
 *   2. `.env.local` ki HAR key ko khaali kar deti hai, sirf ALLOW wali chhod kar — nayi
 *      production key judne par wo bhi apne aap band rehti hai (allowlist, blocklist nahi);
 *   3. NEXT_PUBLIC_APP_ENV=local — topbar par "Local" badge.
 *
 *   npm run dev:local            # port 3001
 *   npm run dev:local -- -p 3005
 *
 * `.env.local` ki values kabhi padhi/chhapi nahi jaati — sirf key ke NAAM.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";

/** Ye keys `.env.local` se aa sakti hain — koi secret nahi, koi bahar ka call nahi. */
const ALLOW = new Set([
  "ALLOW_DEV_PAGES", "ALLOW_QUOTE_PAY_SIMULATION", "EMAIL_FROM", "EMAIL_REPLY_TO",
  "GEMINI_MODEL", "TELECALL_PROVIDER", "WHATSAPP_BSP", "NODE_ENV",
]);

function envKeyNames(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
    .filter(Boolean);
}

function localSupabase() {
  const r = spawnSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8", shell: process.platform === "win32" });
  const out = `${r.stdout ?? ""}`;
  const get = (k) => new RegExp(`^${k}="?([^"\\r\\n]+)"?`, "m").exec(out)?.[1];
  const url = get("API_URL"), anon = get("ANON_KEY"), service = get("SERVICE_ROLE_KEY");
  if (!url || !anon || !service) {
    console.error("Local Supabase nahi mila. Pehle `npx supabase start` chalao (Docker chahiye).");
    process.exit(2);
  }
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    console.error(`supabase status ne ${host} diya — ye local nahi hai. Ruk raha hoon.`);
    process.exit(2);
  }
  return { url, anon, service };
}

const args = process.argv.slice(2);
const portIdx = args.findIndex((a) => a === "-p" || a === "--port");
const port = portIdx >= 0 ? args[portIdx + 1] : "3001";

const sb = localSupabase();
const env = { ...process.env };
const blanked = [];
for (const f of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  for (const k of envKeyNames(f)) {
    if (ALLOW.has(k)) continue;
    env[k] = "";
    blanked.push(k);
  }
}
Object.assign(env, {
  NEXT_PUBLIC_SUPABASE_URL: sb.url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: sb.anon,
  SUPABASE_SERVICE_ROLE_KEY: sb.service,
  NEXT_PUBLIC_APP_ENV: "local",
  NEXT_PUBLIC_APP_URL: `http://localhost:${port}`,
  CRON_SECRET: "local-dev-cron-secret",
});

console.log(`\n  dev:local  →  http://localhost:${port}`);
console.log(`  database   →  ${sb.url} (local)`);
console.log(`  band kiye  →  ${[...new Set(blanked)].filter((k) => !k.startsWith("NEXT_PUBLIC_SUPABASE") && k !== "SUPABASE_SERVICE_ROLE_KEY").length} live keys (Razorpay, Resend, Gupshup, Vapi, Google, GST IRP, …)\n`);

/* Turbopack by default (1 Oct 2026, measured on this laptop): first compile of a page
   dropped from 5–58 s (webpack) to 1–2 s — e.g. /invoices 4.6–58 s → 2 s, /projects/[id]
   19 s → 1 s. Every browser check waited on those compiles. `--webpack` brings the old
   bundler back (next build still uses webpack, so a build-only problem shows in the build). */
const rest = args.filter((_, i) => i !== portIdx && i !== portIdx + 1);

/* --prod (7 Oct 2026, R-321): same safe env, but `next build` + `next start` instead of dev.
   Measured on this laptop: dev mode first visit /accounting/gst 15.2 s, repeat 1.7 s with
   10 MB of unminified JS; the dev server alone held 3.2 GB RAM. A production build serves
   every page pre-compiled and minified. Run it from its own worktree (reselleros-fast) so the
   build never wipes the .next a dev server or Playwright is using. After pulling new code,
   run it again — it rebuilds, then starts. `--no-build` starts the last build as is. */
if (rest.includes("--prod")) {
  const shell = process.platform === "win32";
  if (!rest.includes("--no-build")) {
    console.log("  prod:local →  next build (pehli baar ~5 min)…\n");
    const b = spawnSync("npx", ["next", "build"], { env: { ...env, NODE_ENV: "production" }, stdio: "inherit", shell });
    if (b.status !== 0) { console.error("Build fail — upar ka error dekho."); process.exit(b.status ?? 1); }
  }
  const s = spawn("npx", ["next", "start", "-p", port], { env: { ...env, NODE_ENV: "production" }, stdio: "inherit", shell });
  s.on("exit", (code) => process.exit(code ?? 0));
} else {
  const bundler = rest.includes("--webpack") ? [] : rest.includes("--turbopack") ? [] : ["--turbopack"];
  const child = spawn("npx", ["next", "dev", "-p", port, ...bundler, ...rest.filter((a) => a !== "--webpack")], {
    env, stdio: "inherit", shell: process.platform === "win32",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
