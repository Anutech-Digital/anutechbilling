#!/usr/bin/env node
/**
 * Local ResellerOS with only the ros-pg container.
 *
 * `.env.local` can contain live credentials, so this launcher clears every env key from it
 * before starting Next. It then supplies only the safe local settings in
 * `.env.development.local`: Auth.js, the in-app data gateway, and ros-pg URLs.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const SAFE = new Set([
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET",
  "NEXT_PUBLIC_APP_URL", "DATA_GATEWAY", "NEXT_PUBLIC_DATA_GATEWAY", "AUTH_PROVIDER", "NEXT_PUBLIC_AUTH_PROVIDER",
  "AUTH_SECRET", "AUTH_URL", "STORAGE_BACKEND", "DATABASE_URL", "ANON_DATABASE_URL", "SERVICE_DATABASE_URL",
  "AUTH_DATABASE_URL", "JOBS_DATABASE_URL", "BUY_PAGE_TENANT_ID", "TELECALL_PROVIDER",
  // LinkedIn Company Page + Advertising API. These are read only from
  // .env.development.local, never from .env/.env.local where live keys may exist.
  "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_REDIRECT_URI", "LINKEDIN_ADS_REDIRECT_URI", "LINKEDIN_API_VERSION",
  // Local Ads OAuth apps. Read only from .env.development.local, never .env.local.
  "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_ADS_API_VERSION",
  "META_APP_ID", "META_APP_SECRET", "META_GRAPH_VERSION",
  "SECRETS_MASTER_KEY",
]);

function entries(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) return [];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [[match[1], value]];
  });
}

const env = { ...process.env };
for (const file of [".env", ".env.local", ".env.development"]) {
  for (const [key] of entries(file)) env[key] = "";
}
for (const [key, value] of entries(".env.development.local")) {
  if (SAFE.has(key)) env[key] = value;
}

const args = process.argv.slice(2);
const portIndex = args.findIndex((value) => value === "-p" || value === "--port");
const port = portIndex >= 0 ? args[portIndex + 1] : "3001";
env.NEXT_PUBLIC_APP_URL = `http://localhost:${port}`;

console.log(`\n  dev:ros  →  http://localhost:${port}`);
console.log("  database → ros-pg only (no Supabase containers)\n");

const child = spawn("npx", ["next", "dev", "-p", port, "--turbopack", ...args], {
  env, stdio: "inherit", shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 1));
