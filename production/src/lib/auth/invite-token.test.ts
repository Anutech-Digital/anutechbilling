/**
 * Invite-takeover ka darwaza band rahe — source par pehra.
 *
 * 1 Sep 2026 ke audit ka #1 khatra: password-signup invite ko sirf EMAIL se
 * pehchanta tha aur email_confirm ke saath account bana deta tha — mailbox
 * ka koi saboot nahi, matlab invited address jaanne wala koi bhi us tenant
 * me (owner tak) ghus sakta tha. Ab join ka ek-matra saboot invite ka token
 * hai. Ye test wo teen cheezein pin karta hai jinke bina darwaza wapas
 * khul jata hai.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const signup = readFileSync(join(process.cwd(), "src/app/api/auth/signup/route.ts"), "utf8");
const invite = readFileSync(join(process.cwd(), "src/app/api/team/invite/route.ts"), "utf8");

describe("password-signup invite ko token se pehchanta hai, email se nahi", () => {
  it("invite-lookup token + email dono par filter hota hai", () => {
    const lookup = signup.indexOf('.eq("token", inviteToken)');
    expect(lookup).toBeGreaterThan(-1);
    // Aur wo lookup join-branch se pehle aata hai.
    expect(lookup).toBeLessThan(signup.indexOf('decision.mode === "join"'));
  });

  it("pending invite + galat/gayab token = 409, account nahi banta", () => {
    const guard = signup.indexOf("pendingByEmail");
    const createUser = signup.indexOf("admin.auth.admin.createUser");
    expect(guard).toBeGreaterThan(-1);
    expect(signup).toContain("409");
    // Guard user-creation se PEHLE — warna takeover ke bajay stray account banta.
    expect(guard).toBeLessThan(createUser);
  });

  it("accept bhi token se scope hota hai — R-733 se ek atomic RPC me", () => {
    // R-733: accepted_at + users row ek transaction me (accept_team_invite), token ke saath.
    expect(signup).toMatch(/rpc\("accept_team_invite",\s*\{[^}]*p_token:\s*inviteToken/);
    expect(signup).not.toMatch(/update\(\{ accepted_at/);
  });

  it("invite-email me token wala signup-link jata hai", () => {
    expect(invite).toContain("/signup?invite=");
    expect(invite).toContain('select("token")');
  });
});
