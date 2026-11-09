/**
 * Card test — R-2517: an invite from ANOTHER company is accepted only through the emailed link
 * (proof of the mailbox); the in-app banner has no Accept button.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2517`.
 *
 * Data: scripts/dev/r2517-invite-link.mjs (local docker DB only) — "CT R2517 Invite Co" invites
 * e2e-sales@example.test (Local test login → Sales) as Support and prints the link the invite email
 * would carry — /invites/accept#token=… (locally emails are only stubbed). Each step loads a fresh invite (new link); removed
 * after the last step. The SQL half (no / wrong / used / expired token refused) is
 * supabase/tests/r2517_invite_mailbox_token.test.sql.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const COMPANY = "CT R2517 Invite Co"; // scripts/dev/r2517-invite-link.mjs

/** (Re)loads the invite and returns the accept PATH (the token is new each time). */
function freshInviteLink(): string {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/r2517-invite-link.mjs"], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`r2517-invite-link failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  const url = new URL(r.stdout.trim());
  return url.pathname + url.hash;
}
function clearInvite(): void {
  const prod = path.resolve(__dirname, "..", "..");
  spawnSync(process.execPath, ["scripts/dev/r2517-invite-link.mjs", "--clear"], { cwd: prod, encoding: "utf8" });
}

test.describe("R-2517 — invite from another company: accept only by the emailed link", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => clearInvite());

  test("Step 1: Sales sees the invite banner — it says to open the emailed link, no Accept button", async ({ browser, baseURL }) => {
    freshInviteLink();
    const page = await pageAs(browser, baseURL, "sales");
    await openAppPage(page, "/leads");
    const banner = page.getByRole("region", { name: "Invites from other companies" });
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText(`Invite from ${COMPANY} to join as Support.`);
    await expect(banner).toContainText("To accept, open the link we emailed to e2e-sales@example.test.");
    await expect(banner.getByRole("button", { name: /accept/i })).toHaveCount(0);
    await page.context().close();
  });

  test("Step 2: Sales opens the emailed link → Accept → joined; the same link again says already used", async ({ browser, baseURL }) => {
    const link = freshInviteLink();
    const page = await pageAs(browser, baseURL, "sales");
    await page.goto("about:blank");
    await page.goto(link);
    await expect(page.getByRole("heading", { name: `Join ${COMPANY}?` })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: `Accept and join ${COMPANY}` }).click();
    await expect(page.getByRole("heading", { name: "Invite accepted" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(`You joined ${COMPANY} as Support.`)).toBeVisible();
    await expect(page.getByRole("button", { name: `Switch to ${COMPANY} now` })).toBeVisible();
    await page.goto("about:blank");
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Invite already used" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: /accept/i })).toHaveCount(0);
    await page.context().close();
  });

  test("Step 3: another login (Owner) with Sales's link → 'Signed in as someone else', no Accept", async ({ browser, baseURL }) => {
    const link = freshInviteLink();
    const page = await pageAs(browser, baseURL, "owner");
    await page.goto("about:blank");
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Signed in as someone else" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/This invite was sent to e2e-sales@example\.test, but you are signed in as/)).toBeVisible();
    await expect(page.getByRole("button", { name: /accept/i })).toHaveCount(0);
    await page.context().close();
  });
});
