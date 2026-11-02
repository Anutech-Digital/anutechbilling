/**
 * R-2106 (alsoDo2, 29 Oct demo): `npm run dev:local` must never send for real — every key that sends
 * mail/messages/payments stays blanked (ALLOW in scripts/dev-local.mjs), and cron:local uses the CRON_SECRET
 * dev:local really sets. Pure file scan (listed in push-guard-suites).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { sendKeysAllowed, devLocalAllowKeys } from "../../scripts/ops/localhost-update.mjs";
// @ts-expect-error — plain .mjs script, no types
import { LOCAL_CRON_SECRET, parseCronArgs, cronUrl } from "../../scripts/cron-local.mjs";

const APP = path.resolve(__dirname, "../..");

describe("dev:local never sends for real (alsoDo2: RESEND guard) + cron secret", () => {
  const devLocal = fs.readFileSync(path.join(APP, "scripts", "dev-local.mjs"), "utf8");
  it("ALLOW holds no key that sends mail/messages/payments", () => {
    expect(devLocalAllowKeys(devLocal)).toContain("SECRETS_MASTER_KEY");
    expect(sendKeysAllowed(devLocal)).toEqual([]);
  });
  it("every non-ALLOW key of .env.local is blanked before next dev starts", () => {
    expect(devLocal).toMatch(/for \(const f of \[[^\]]*"\.env\.local"[^\]]*\]\)/);
    expect(devLocal).toMatch(/if \(ALLOW\.has\(k\)\) continue;\s*env\[k\] = "";/);
    /* nothing re-adds a send key after the blanking */
    const after = devLocal.slice(devLocal.indexOf("Object.assign(env"));
    expect(after.slice(0, after.indexOf("});"))).not.toMatch(/RESEND|SMTP_|GUPSHUP|RAZORPAY|VAPI/);
  });
  it("the guard catches an ALLOW edit that would let Resend through (as the deploy checkout's local edit might)", () => {
    const edited = devLocal.replace('"SECRETS_MASTER_KEY",', '"SECRETS_MASTER_KEY", "RESEND_API_KEY", "ZOHO_BOOKS_CLIENT_ID", "ANTHROPIC_API_KEY",');
    expect(sendKeysAllowed(edited)).toEqual(["RESEND_API_KEY"]);
  });
  it("cron:local sends exactly the CRON_SECRET dev-local sets", () => {
    expect(devLocal).toContain(`CRON_SECRET: "${LOCAL_CRON_SECRET}"`);
    expect(cronUrl(parseCronArgs(["/api/cron/renewals", "--dry"]))).toBe("http://localhost:3001/api/cron/renewals?dry=1");
    expect(() => parseCronArgs([])).toThrow();
  });
  it("localhost-update never starts or restarts a server", () => {
    const src = fs.readFileSync(path.join(APP, "scripts", "ops", "localhost-update.mjs"), "utf8");
    expect(src).not.toMatch(/["'](next|npm|npx)["']\s*,\s*\[/);
    expect(src).not.toMatch(/taskkill|process\.kill/);
  });
});
