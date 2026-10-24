/**
 * R-739 (23 Oct 2026): capability links (PDF, expense-claim, AA consent state) are signed with
 * their OWN secret in production. Before this, a missing PDF_SIGNING_SECRET silently fell back to
 * SUPABASE_SERVICE_ROLE_KEY — the database's full admin key doubled as the links' signing key.
 *
 * Production without PDF_SIGNING_SECRET now refuses (fails closed) with a message that says what
 * to set. Dev and tests keep the fallback so a fresh checkout still works. Links signed with the
 * service-role key before the switch still VERIFY until SIGNING_LEGACY_UNTIL (unchanged).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { signingSecrets } from "./signing-secrets";

afterEach(() => { vi.unstubAllEnvs(); });

const BEFORE_GRACE_END = new Date("2026-11-01T00:00:00Z");

describe("signingSecrets — R-739: no service-role fallback in production", () => {
  it("production without PDF_SIGNING_SECRET refuses, naming the variable to set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PDF_SIGNING_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-key");
    expect(() => signingSecrets(BEFORE_GRACE_END)).toThrow(/PDF_SIGNING_SECRET/);
  });

  it("production never signs with the service-role key", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PDF_SIGNING_SECRET", "dedicated-secret");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-key");
    const s = signingSecrets(BEFORE_GRACE_END);
    expect(s.primary).toBe("dedicated-secret");
    /* Old links still verify during the grace window — setting the secret breaks nothing. */
    expect(s.legacy).toEqual(["svc-role-key"]);
  });

  it("production after the grace window: only the dedicated secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PDF_SIGNING_SECRET", "dedicated-secret");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-key");
    expect(signingSecrets(new Date("2027-01-02T00:00:00Z")).legacy).toEqual([]);
  });

  it("outside production the service-role fallback still works (fresh local checkout)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PDF_SIGNING_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-key");
    expect(signingSecrets(BEFORE_GRACE_END).primary).toBe("svc-role-key");
  });

  it("never an empty key, anywhere", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PDF_SIGNING_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => signingSecrets(BEFORE_GRACE_END)).toThrow(/PDF_SIGNING_SECRET/);
  });
});
