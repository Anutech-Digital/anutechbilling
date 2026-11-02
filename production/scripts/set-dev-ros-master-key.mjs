/** Generate the local encryption key used by the ros-pg development app. Never prints it. */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const file = ".env.development.local";
const name = "SECRETS_MASTER_KEY";
const source = existsSync(file) ? readFileSync(file, "utf8") : "";
const hasKey = source.split(/\r?\n/).some((line) => line.startsWith(`${name}=`) && line.slice(name.length + 1).trim());
if (hasKey) {
  console.log("Local encryption key already exists. Nothing changed.");
  process.exit(0);
}
if (existsSync(file)) copyFileSync(file, `${file}.bak-${Date.now()}`);
const key = randomBytes(32).toString("base64");
writeFileSync(file, `${source}${source && !source.endsWith("\n") ? "\n" : ""}${name}=${key}\n`, "utf8");
console.log("Local encryption key created. Its value was not printed.");
