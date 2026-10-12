#!/usr/bin/env node
/**
 * local-login-link.mjs — one-time login link for a LOCAL test user (R-878).
 *
 *   node scripts/dev/local-login-link.mjs e2e-manager@example.test --host tester1.localhost:3008
 *   node scripts/dev/local-login-link.mjs e2e-sales@example.test --next /leads
 *
 * Prints ONE line: a link. Open it in the browser and you are signed in as that user on that
 * dev server (`npm run dev:local -- -p <port>`), landing on --next (default /dashboard).
 *
 * How: the local GoTrue (Supabase stack) mints a magic-link token for the user with the
 * service role; the link carries only its HASH to GET /api/dev/login-link on the dev server,
 * which verifies it (one use, expires in 1 h) and sets the session cookie. Same mechanism as
 * the demo login (src/lib/demo/demo-account.server.ts#signInAs). No password is involved.
 *
 * REFUSES (exit 1, reason on stderr, nothing on stdout):
 *   - an email that is not @example.test (real accounts can never get a link);
 *   - a --host that is not localhost / 127.0.0.1 / *.localhost;
 *   - a Supabase URL that is not local (staging / live are unreachable from here);
 *   - an email with no account in the local DB (run the E2E seed first — this never creates users).
 *
 * The service key is read from `npx supabase status` (or env) and never printed.
 * The app side answers 404 outside `npm run dev:local` (see src/app/api/dev/login-link/rules.ts).
 * Uses the GoTrue session, i.e. the default local auth; with AUTH_PROVIDER=authjs use the
 * login page's "Local test login" buttons instead.
 */
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  appHostLocalReason, testEmailReason, localSupabase, buildLoginLink, parseLoginLinkArgs,
} from "./local-guard.mjs";

function die(msg) {
  console.error(`local-login-link: ${msg}`);
  process.exit(1);
}

const args = parseLoginLinkArgs(process.argv.slice(2));
if (!args.email) die("usage: node scripts/dev/local-login-link.mjs <email@example.test> [--host <host:port>] [--next /path]");
const email = String(args.email).trim().toLowerCase();

const emailWhy = testEmailReason(email);
if (emailWhy) die(emailWhy);
const hostWhy = appHostLocalReason(args.host);
if (hostWhy) die(hostWhy);

const productionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sb = localSupabase(productionDir);
if ("reason" in sb) die(sb.reason);

const admin = createClient(sb.url, sb.service, { auth: { autoRefreshToken: false, persistSession: false } });

async function authUserExists(addr) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    if (data.users.some((u) => (u.email ?? "").toLowerCase() === addr)) return true;
    if (data.users.length < 200) return false;
  }
}

try {
  if (!(await authUserExists(email))) {
    die(`${email} has no account in the local DB — run the E2E seed first (E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs).`);
  }
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) die(`could not mint a link: ${error?.message ?? "no token"}`);
  console.log(buildLoginLink({ host: String(args.host).trim().toLowerCase(), tokenHash, email, next: args.next }));
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
