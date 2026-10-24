/**
 * PIN rules — the half of the screen lock that has no crypto in it.
 *
 * SPLIT OUT OF pin.ts BECAUSE OF A REAL BUILD FAILURE, not for tidiness. The lock screen
 * and the settings card are client components and need PIN_LENGTH, the weak-PIN rules and
 * the lockout maths. Importing those from pin.ts dragged `node:crypto` into the browser
 * bundle and webpack refused the whole route with UnhandledSchemeError — a 500 that
 * typecheck, lint and vitest all passed straight over, and only running the app showed.
 *
 * Nothing here touches a secret: no hashing, no salt, no comparison. Those stay in pin.ts,
 * server-side, where they belong.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROTECTS: somebody who walks up to the owner's unlocked laptop, or is looking over
 * their shoulder, or is watching a screen share. That is a real and common threat in a
 * small office, and it is the threat the reporter of this feature has in mind.
 *
 * DOES NOT PROTECT: anybody technical holding a live session. The vault rows are read
 * through PostgREST under RLS, so a person who can open the browser console can fetch
 * them without ever seeing this PIN. **The access control is the RLS policy
 * (`owner_user_id = auth.uid()`), not this.**
 *
 * That gap is not fixable by trying harder here. Encrypting the data under the PIN is
 * the only thing that would close it, and a 4-digit key has 10,000 possibilities — an
 * attacker holding the ciphertext tries all of them in under a second. It would also
 * mean a forgotten PIN destroys the data permanently. So the PIN stays a screen lock,
 * the UI says so in plain words, and nobody is misled into thinking their net worth is
 * encrypted when it is not.
 *
 * ─── WHAT IS STILL WORTH DOING PROPERLY ─────────────────────────────────────
 * Given it exists, it should not be a *bad* screen lock:
 *   · the PIN is never stored, only a salted scrypt hash, and never leaves the server
 *   · comparison is timing-safe
 *   · guesses are counted and locked out — 10,000 possibilities is seconds of scripted
 *     guessing without a limit, which would make the lock decorative even against the
 *     shoulder-surfer it is for
 *   · obvious PINs are refused at the point of setting, because "1234" is not a lock
 */

export const PIN_LENGTH = 4;

/** Wrong guesses before the lock closes. */
export const MAX_ATTEMPTS = 5;
/** How long it stays closed. Long enough to defeat scripting, short enough to survive. */
export const LOCKOUT_MINUTES = 15;

export function isValidPinFormat(pin: string): boolean {
  return typeof pin === "string" && new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin);
}

/**
 * PINs that are not worth setting.
 *
 * Refused rather than warned about: the whole value of a 4-digit lock is that a passer-by
 * cannot guess it, and these are the guesses a passer-by makes. `1234` and `0000` alone
 * are a double-digit share of PINs chosen in the wild.
 */
export function isWeakPin(pin: string): boolean {
  if (!isValidPinFormat(pin)) return false; // format is a separate complaint
  if (/^(\d)\1{3}$/.test(pin)) return true; // 0000, 1111, …

  const digits = pin.split("").map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10);
  if (ascending || descending) return true; // 1234, 4321, 9012…

  // Repeated pairs — 1212, 6767. Reads as random, is not.
  if (digits[0] === digits[2] && digits[1] === digits[3]) return true;

  return false;
}

export interface PinValidation {
  ok: boolean;
  /** A reason phrased as a next step, per CLAUDE.md §24 — never a bare refusal. */
  error?: string;
}

export function validateNewPin(pin: string): PinValidation {
  if (!isValidPinFormat(pin)) {
    return { ok: false, error: `PIN must be exactly ${PIN_LENGTH} digits (0-9).` };
  }
  if (isWeakPin(pin)) {
    return { ok: false, error: "This PIN is too easy to guess (like 1234, 0000, 1212). Choose a different one." };
  }
  return { ok: true };
}

export interface LockState {
  locked: boolean;
  /** Seconds until it opens again. 0 when not locked. */
  retryAfterSec: number;
  /** Guesses left before it closes. 0 while locked. */
  attemptsLeft: number;
}

export function lockState(
  failedAttempts: number,
  lockedUntil: string | Date | null | undefined,
  now: Date,
): LockState {
  if (lockedUntil) {
    const until = lockedUntil instanceof Date ? lockedUntil : new Date(lockedUntil);
    if (!Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) {
      return {
        locked: true,
        retryAfterSec: Math.ceil((until.getTime() - now.getTime()) / 1000),
        attemptsLeft: 0,
      };
    }
  }
  const used = Math.max(0, failedAttempts);
  return { locked: false, retryAfterSec: 0, attemptsLeft: Math.max(0, MAX_ATTEMPTS - used) };
}

export interface FailureOutcome {
  failedAttempts: number;
  lockedUntil: string | null;
  locked: boolean;
}

/**
 * What to write after a wrong guess.
 *
 * The counter is NOT reset when the lockout is applied. Resetting it would mean a
 * patient guesser gets a fresh five attempts every fifteen minutes forever; keeping it
 * means the lock re-closes on the very next wrong guess. It is cleared only by a
 * correct PIN, which is the only event that proves it is the owner.
 */
export function nextFailureState(
  currentFailedAttempts: number,
  now: Date,
  lockoutMinutes: number = LOCKOUT_MINUTES,
): FailureOutcome {
  const failed = Math.max(0, currentFailedAttempts) + 1;
  if (failed >= MAX_ATTEMPTS) {
    return {
      failedAttempts: failed,
      lockedUntil: new Date(now.getTime() + lockoutMinutes * 60_000).toISOString(),
      locked: true,
    };
  }
  return { failedAttempts: failed, lockedUntil: null, locked: false };
}

/** What to write after a correct PIN: the slate is wiped. */
export function successState(): FailureOutcome {
  return { failedAttempts: 0, lockedUntil: null, locked: false };
}

/**
 * How long an unlock lasts before the PIN is asked for again.
 *
 * Fifteen minutes. The lock exists for the walk-away case, so an unlock that survives
 * all day would defeat its only purpose; asking on every navigation would get the PIN
 * switched off within a week.
 */
export const UNLOCK_TTL_MINUTES = 15;
