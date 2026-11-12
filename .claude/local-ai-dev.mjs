#!/usr/bin/env node
// Local only: starts `npm run dev:local` (reselleros-deploy) with ONLY the Claude AI key
// passed through from new-reselleros/production/.env.local. dev:local blanks every key named
// in its own .env files; a key that arrives in the process env (and is not named there) stays.
// No value is printed.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const src = "C:/Users/mso50/new-reselleros/production/.env.local";
const line = readFileSync(src, "utf8").split(/\r?\n/).find((l) => /^\s*ANTHROPIC_API_KEY\s*=/.test(l));
const key = line ? line.split("=").slice(1).join("=").trim().replace(/^"|"$/g, "") : "";
if (!key) console.error("ANTHROPIC_API_KEY not found in production/.env.local — AI will use templates.");
const env = { ...process.env, ANTHROPIC_API_KEY: key, AI_PROVIDER: "claude" };
const child = spawn("npm", ["run", "dev:local", "--prefix", "C:/Users/mso50/reselleros-deploy/production"], {
  env, stdio: "inherit", shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
