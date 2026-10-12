import { describe, it, expect } from "vitest";
import {
  generatePassword, assessStrength, reuseFingerprint, vaultHealth,
  DEFAULT_LENGTH, MIN_LENGTH, ROTATION_DAYS,
  type VaultEntryHealth,
} from "./passwords";

const TODAY = "2026-08-14";

describe("generatePassword — the crypto correctness that eyeballs cannot check", () => {
  it("uses crypto.getRandomValues, so the same call never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generatePassword());
    expect(seen.size).toBe(200);
  });

  it("honours the requested length and never goes below the floor", () => {
    expect(generatePassword().length).toBe(DEFAULT_LENGTH);
    expect(generatePassword({ length: 32 }).length).toBe(32);
    // A caller asking for 4 characters is asking for a mistake.
    expect(generatePassword({ length: 4 }).length).toBe(MIN_LENGTH);
    expect(generatePassword({ length: 0 }).length).toBe(MIN_LENGTH);
    expect(generatePassword({ length: -10 }).length).toBe(MIN_LENGTH);
  });

  it("is free of MODULO BIAS across the alphabet", () => {
    // The bug this guards: `byte % 70` makes some characters come up ~33% more
    // often than others, because 256 is not a multiple of 70. It looks perfectly
    // random to any human reading samples, and it is not.
    //
    // CHI-SQUARED, not a per-character tolerance. The first version of this test
    // asserted every character stayed within 10% of the mean, which at this sample
    // size is about 3 sigma — across ~70 characters that fails roughly one run in
    // five. It duly failed once, passed on re-run, and a flaky test in a suite of
    // 940 is worse than no test: it teaches people to re-run and move on.
    //
    // Chi-squared separates the two cases sharply instead. For ~69 degrees of
    // freedom a uniform generator lands near 69 and essentially never above 200,
    // while modulo bias at this N produces well over 1,000.
    const counts = new Map<string, number>();
    const N = 100_000;
    for (const ch of generatePassword({ length: N })) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }

    const k = counts.size;
    const expected = N / k;
    let chiSquared = 0;
    for (const observed of counts.values()) {
      chiSquared += ((observed - expected) ** 2) / expected;
    }

    expect(k).toBeGreaterThan(60);          // the alphabet is actually being used
    expect(chiSquared).toBeLessThan(200);   // ~p < 1e-9 for a uniform generator
  });

  it("omits glyphs that get misread when a password is read aloud", () => {
    const big = generatePassword({ length: 20_000 });
    for (const ch of ["l", "I", "O", "0", "1"]) {
      expect(big.includes(ch), `should not contain ${ch}`).toBe(false);
    }
  });

  it("can drop symbols for consoles that reject them", () => {
    const p = generatePassword({ length: 4000, symbols: false });
    expect(/^[A-Za-z0-9]+$/.test(p)).toBe(true);
  });

  it("produces a strong password by default", () => {
    for (let i = 0; i < 50; i++) {
      expect(assessStrength(generatePassword()).strength).toBe("strong");
    }
  });
});

describe("assessStrength", () => {
  it("calls a generated 20-character password strong", () => {
    expect(assessStrength("Xk9#mQ2vLp8@Tz4wRn6!").strength).toBe("strong");
  });

  it("calls the passwords that actually get broken weak", () => {
    for (const p of [
      "password", "Password1", "admin123", "welcome2026",
      "qwerty123456", "abcdef123456", "aaaaaaaaaaaa", "india@123",
      "office365pass", "letmein!",
    ]) {
      expect(assessStrength(p).strength, p).toBe("weak");
    }
  });

  it("counts character classes", () => {
    expect(assessStrength("abcdefghijkl").classes).toBe(1);
    expect(assessStrength("Abcdefghijkl").classes).toBe(2);
    expect(assessStrength("Abcdefghij12").classes).toBe(3);
    expect(assessStrength("Abcdefghij1!").classes).toBe(4);
  });

  it("flags a short password even when it mixes classes", () => {
    const r = assessStrength("Ab1!xy");
    expect(r.strength).toBe("weak");
    expect(r.problems.join(" ")).toMatch(/Only 6 characters/);
  });

  it("names the well-known word it found, so the warning is actionable", () => {
    expect(assessStrength("MyGooglePass99!").problems.join(" ")).toMatch(/google/);
  });

  it("catches a keyboard run in either direction", () => {
    expect(assessStrength("Zq!qwertyMn4x").problems.join(" ")).toMatch(/run/);
    expect(assessStrength("Zq!ytrewqMn4x").problems.join(" ")).toMatch(/run/);
  });

  it("handles empty and missing input without throwing", () => {
    for (const p of ["", null, undefined]) {
      const r = assessStrength(p as string);
      expect(r.strength).toBe("weak");
      expect(() => assessStrength(p as string)).not.toThrow();
    }
  });
});

describe("reuseFingerprint", () => {
  it("truncates the keyed MAC to a short, non-reversible marker", () => {
    const full = "a".repeat(64);
    expect(reuseFingerprint(full)).toBe("a".repeat(16));
    expect(reuseFingerprint(full).length).toBe(16);
  });

  it("normalises case and whitespace so equal passwords match", () => {
    expect(reuseFingerprint("  ABCDEF0123456789ZZ  ")).toBe("abcdef0123456789");
  });

  it("survives empty input", () => {
    expect(reuseFingerprint("")).toBe("");
  });
});

describe("vaultHealth", () => {
  const e = (over: Partial<VaultEntryHealth> = {}): VaultEntryHealth => ({
    id: "v1", title: "Demo Co — Google Admin", category: "google_admin",
    customerId: "c1", fingerprint: "aaaaaaaaaaaaaaaa",
    lastRotatedAt: "2026-08-01",
    ...over,
  });

  it("says nothing about a healthy entry", () => {
    expect(vaultHealth([e()], TODAY)).toEqual([]);
  });

  it("flags reuse as CRITICAL and names the entries that share it", () => {
    // One leak opening three customer consoles is the worst state this vault can
    // be in, so it outranks everything else.
    const f = vaultHealth([
      e({ id: "a", title: "A", fingerprint: "same0000same0000" }),
      e({ id: "b", title: "B", fingerprint: "same0000same0000" }),
      e({ id: "c", title: "C", fingerprint: "same0000same0000" }),
    ], TODAY);
    expect(f).toHaveLength(3);
    expect(f[0].code).toBe("reused");
    expect(f[0].severity).toBe("critical");
    expect(f[0].message).toMatch(/2 other entries/);
    expect(f[0].sharedWith).toHaveLength(2);
    expect(f[0].action).toMatch(/one leak currently opens all of them/i);
  });

  it("detects reuse WITHOUT any password being decrypted", () => {
    // The point of fingerprints: a health sweep that had to decrypt everything
    // would be a scheduled bulk-decrypt job, which is the last thing you want
    // running unattended.
    const entries = [
      e({ id: "a", title: "A", fingerprint: "dup", password: undefined }),
      e({ id: "b", title: "B", fingerprint: "dup", password: undefined }),
    ];
    expect(vaultHealth(entries, TODAY).some((f) => f.code === "reused")).toBe(true);
  });

  it("ignores entries with no fingerprint rather than grouping them together", () => {
    // Two nulls are not "the same password".
    const f = vaultHealth([
      e({ id: "a", title: "A", fingerprint: null }),
      e({ id: "b", title: "B", fingerprint: null }),
      e({ id: "c", title: "C", fingerprint: "" }),
    ], TODAY);
    expect(f.some((x) => x.code === "reused")).toBe(false);
  });

  it("flags a password older than the rotation target", () => {
    const old = new Date(Date.parse(TODAY) - (ROTATION_DAYS + 10) * 86_400_000).toISOString().slice(0, 10);
    const f = vaultHealth([e({ lastRotatedAt: old, fingerprint: "x1" })], TODAY);
    expect(f[0].code).toBe("stale");
    expect(f[0].message).toMatch(/100 days ago/);
  });

  it("escalates to high past double the target", () => {
    const ancient = new Date(Date.parse(TODAY) - ROTATION_DAYS * 3 * 86_400_000).toISOString().slice(0, 10);
    expect(vaultHealth([e({ lastRotatedAt: ancient, fingerprint: "x1" })], TODAY)[0].severity).toBe("high");
  });

  it("flags a missing rotation date without pretending to know the age", () => {
    const f = vaultHealth([e({ lastRotatedAt: null, fingerprint: "x1" })], TODAY);
    expect(f[0].code).toBe("never_rotated");
    expect(f[0].message).toMatch(/age is unknown/);
  });

  it("assesses strength only when the caller supplied a decrypted password", () => {
    // Absent means "not checked", which must not be reported as "fine".
    const unchecked = vaultHealth([e({ fingerprint: "x1" })], TODAY);
    expect(unchecked.some((f) => f.code === "weak")).toBe(false);

    const checked = vaultHealth([e({ fingerprint: "x1", password: "admin123" })], TODAY);
    expect(checked.some((f) => f.code === "weak")).toBe(true);
  });

  it("puts reuse above staleness in the list", () => {
    const old = new Date(Date.parse(TODAY) - 400 * 86_400_000).toISOString().slice(0, 10);
    const f = vaultHealth([
      e({ id: "stale", title: "Stale one", fingerprint: "solo", lastRotatedAt: old }),
      e({ id: "r1", title: "Dup A", fingerprint: "dup" }),
      e({ id: "r2", title: "Dup B", fingerprint: "dup" }),
    ], TODAY);
    expect(f[0].code).toBe("reused");
    expect(f[f.length - 1].code).toBe("stale");
  });

  it("gives every finding a message AND a next step (§24)", () => {
    const old = new Date(Date.parse(TODAY) - 400 * 86_400_000).toISOString().slice(0, 10);
    const f = vaultHealth([
      e({ id: "a", title: "A", fingerprint: "dup", lastRotatedAt: old, password: "password" }),
      e({ id: "b", title: "B", fingerprint: "dup", lastRotatedAt: null }),
    ], TODAY);
    expect(f.length).toBeGreaterThan(3);
    for (const x of f) {
      expect(x.message.length, x.code).toBeGreaterThan(0);
      expect(x.action.length, x.code).toBeGreaterThan(0);
    }
  });

  it("handles an empty vault and a bad date", () => {
    expect(vaultHealth([], TODAY)).toEqual([]);
    expect(() => vaultHealth([e({ lastRotatedAt: "not-a-date" })], TODAY)).not.toThrow();
  });
});
