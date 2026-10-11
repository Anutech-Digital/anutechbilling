import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { claimLinkExp, claimLinkUrl, claimTokenStatus, signClaimToken, verifyClaimToken } from "./claim-token";

/* S20 (28 Sep 2026): claim link bhi PDF_SIGNING_SECRET se sign hota hai. Employees ke paas
   pade link service-role chaabi se bane hain — secret set karte hi wo toot-te, agar verify
   sirf nayi chaabi maanta. R-725: link me ab `exp` bhi hai (90 din). */
beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.stubEnv("PDF_SIGNING_SECRET", "");
  vi.stubEnv("SIGNING_LEGACY_UNTIL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("claim-token", () => {
  const T = "fbb976f1-9090-4f10-9726-0901bd144e42";

  it("sahi tenant par chalta, doosre par nahi", () => {
    const exp = claimLinkExp();
    const sig = signClaimToken(T, exp);
    expect(verifyClaimToken(T, sig, exp)).toBe(true);
    expect(verifyClaimToken("other", sig, exp)).toBe(false);
    expect(verifyClaimToken(T, "", exp)).toBe(false);
    expect(verifyClaimToken(T, sig)).toBe(false); // exp hata diya → dastkhat nahi milta
  });

  it("PDF_SIGNING_SECRET set hone ke baad bhi purana link chalta hai (grace) — ASLI JAAL", () => {
    const exp = claimLinkExp();
    const old = signClaimToken(T, exp); // service-role se
    vi.stubEnv("PDF_SIGNING_SECRET", "new-dedicated");
    expect(verifyClaimToken(T, old, exp)).toBe(true);
    expect(signClaimToken(T, exp)).not.toBe(old); // naya link nayi chaabi se
    expect(verifyClaimToken(T, signClaimToken(T, exp), exp)).toBe(true);
  });

  it("grace khatam → purani chaabi ka link band", () => {
    const exp = claimLinkExp();
    const old = signClaimToken(T, exp);
    vi.stubEnv("PDF_SIGNING_SECRET", "new-dedicated");
    vi.stubEnv("SIGNING_LEGACY_UNTIL", "2020-01-01T00:00:00Z");
    expect(verifyClaimToken(T, old, exp)).toBe(false);
  });

  it("R-725: link 90 din baad expire; galat exp invalid", () => {
    const now = new Date("2026-10-11T00:00:00Z");
    const url = new URL(claimLinkUrl("https://app.test/", T, now));
    const exp = url.searchParams.get("exp")!;
    const sig = url.searchParams.get("sig")!;
    expect(Number(exp)).toBe(Math.floor(now.getTime() / 1000) + 90 * 86_400);
    expect(claimTokenStatus(T, sig, exp, new Date("2027-01-08T00:00:00Z"))).toBe("ok");
    expect(claimTokenStatus(T, sig, exp, new Date("2027-01-10T00:00:00Z"))).toBe("expired");
    expect(claimTokenStatus(T, sig, "abc", now)).toBe("invalid");
  });
});
