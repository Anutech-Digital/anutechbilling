// Not wired yet — R-1608 (built, kept for later)
/**
 * Access register — WHICH credentials exist, never what they are.
 *
 * ─── WHY THIS IS NOT A PASSWORD MANAGER, AND MUST NOT BECOME ONE ─────────────
 * A password vault in this app cannot keep its own promise. `SECRETS_MASTER_KEY`
 * is a server-side environment variable, so anyone with the Cloud Run environment
 * or the Supabase service-role key can decrypt every row. Bitwarden and 1Password
 * derive the key from the user's master password IN THE BROWSER, so the server
 * holds ciphertext it cannot open. That is zero-knowledge, and it is an
 * architecture rather than a feature — bolting it on here would mean no
 * server-side reads, no admin recovery, no RLS team sharing, and audited crypto.
 *
 * So this register stores metadata and nothing else. There is deliberately NO
 * column for a secret value: the guarantee is structural, not a promise in a
 * comment. What it answers is the question a ten-person reseller actually has —
 * who holds the GST portal login, when was the bank password last changed, and
 * whose DSC expires next month.
 *
 * The one hole left is a human typing a password into `notes`, which
 * `looksLikeSecret` exists to catch before it is saved.
 */

/** How risky it is that this credential is in its current state. */
export type RiskLevel = "critical" | "high" | "medium" | "none";

export interface CredentialRow {
  id: string;
  /** What it opens, e.g. "GST portal", "ICICI corporate banking". */
  label: string;
  /** Category, for grouping. */
  kind: string | null;
  /** Who is accountable for it. */
  holder_name: string | null;
  /** The employee record, when the holder is staff. */
  holder_employee_id: string | null;
  /** Whether that employee is still with the business. */
  holder_active?: boolean | null;
  /** WHERE the secret actually lives — "Bitwarden", "hardware token", a person. */
  stored_in: string | null;
  /** ISO date the secret was last changed. */
  last_rotated_on: string | null;
  /** ISO date it stops working (DSC, token, certificate). */
  expires_on: string | null;
  /** How many people can get in. 1 means a single point of failure. */
  holder_count?: number | null;
  notes: string | null;
}

export interface Finding {
  credentialId: string;
  label: string;
  code:
    | "expired"
    | "expiring"
    | "orphaned"
    | "never_rotated"
    | "rotation_overdue"
    | "no_location"
    | "single_holder"
    | "secret_in_notes";
  risk: RiskLevel;
  /** One sentence stating the problem. */
  message: string;
  /** The concrete next step (§24 — never a dead end). */
  action: string;
  /** Days until expiry, when the finding is date-driven. */
  daysOut?: number;
}

/** Rotate a shared portal password at least this often. */
export const ROTATION_DAYS = 180;
/** Warn this far ahead of an expiry date. Mirrors the compliance ladder. */
export const EXPIRY_LADDER = [30, 15, 7] as const;

function dayDiff(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Does this text look like somebody pasted a secret into a notes field?
 *
 * The register has no column for a secret, so the only way one gets in is a human
 * typing it somewhere free-form. This is a guard, not a filter: it warns the
 * person saving, because refusing the save outright would just get the password
 * written on paper instead.
 *
 * Deliberately conservative — a false positive costs one dismissed warning, a
 * false negative puts a live credential in a table designed to be widely readable.
 */
export function looksLikeSecret(text: string | null | undefined): boolean {
  const s = (text ?? "").toString();
  if (s.trim().length === 0) return false;

  // Named provider key prefixes. These are unambiguous.
  const PREFIXES = [
    "sk_live_", "sk_test_", "rzp_live_", "rzp_test_", "AIza", "ghp_", "gho_",
    "xoxb-", "xoxp-", "SG.", "AKIA", "eyJhbGciOi", "-----BEGIN",
  ];
  if (PREFIXES.some((p) => s.includes(p))) return true;

  // "password: hunter2", "pwd = ...", "pin - 1234"
  if (/\b(pass(word)?|pwd|passcode|pin|otp|secret|token|api[\s_-]?key)\b\s*[:=-]\s*\S+/i.test(s)) {
    return true;
  }

  // A long run with no spaces and mixed character classes is almost always a
  // key rather than prose. Kept at 20+ so ordinary words and URLs pass.
  for (const word of s.split(/\s+/)) {
    if (word.length < 20) continue;
    if (/^https?:\/\//i.test(word)) continue;            // a long URL is fine
    const classes =
      (/[a-z]/.test(word) ? 1 : 0) +
      (/[A-Z]/.test(word) ? 1 : 0) +
      (/[0-9]/.test(word) ? 1 : 0) +
      (/[^A-Za-z0-9]/.test(word) ? 1 : 0);
    if (classes >= 3) return true;
  }

  return false;
}

/**
 * Everything wrong with the register today, worst first.
 *
 * `today` is a parameter rather than read from the clock so this stays pure and
 * can be tested at a chosen date — a function that reads `new Date()` cannot be
 * tested against a DSC expiring next Tuesday.
 */
export function credentialFindings(rows: CredentialRow[], today: string): Finding[] {
  const out: Finding[] = [];

  for (const c of rows) {
    const label = c.label || "Untitled credential";
    const push = (f: Omit<Finding, "credentialId" | "label">) =>
      out.push({ credentialId: c.id, label, ...f });

    // ── Expiry ──────────────────────────────────────────────────────────
    if (c.expires_on) {
      const d = dayDiff(today, c.expires_on);
      if (d !== null) {
        if (d < 0) {
          push({
            code: "expired", risk: "critical", daysOut: d,
            message: `Expired ${Math.abs(d)} ${Math.abs(d) === 1 ? "day" : "days"} ago.`,
            action: "Renew it, then update the expiry date here.",
          });
        } else if (d <= EXPIRY_LADDER[0]) {
          push({
            code: "expiring",
            // Inside a week is critical: a DSC or token that lapses can stop a
            // statutory filing dead, and renewal is rarely same-day.
            risk: d <= EXPIRY_LADDER[2] ? "critical" : d <= EXPIRY_LADDER[1] ? "high" : "medium",
            daysOut: d,
            message: d === 0 ? "Expires today." : `Expires in ${d} ${d === 1 ? "day" : "days"}.`,
            action: "Start the renewal now — most portals take days, not minutes.",
          });
        }
      }
    }

    // ── Holder has left ─────────────────────────────────────────────────
    // The finding that only a register can surface: a live credential whose only
    // named holder is no longer with the business.
    if (c.holder_employee_id && c.holder_active === false) {
      push({
        code: "orphaned", risk: "critical",
        message: `Held by ${c.holder_name || "a former employee"}, who is no longer active.`,
        action: "Change the secret and reassign the holder before anything else.",
      });
    }

    // ── Rotation ────────────────────────────────────────────────────────
    if (!c.last_rotated_on) {
      push({
        code: "never_rotated", risk: "medium",
        message: "No rotation date recorded, so nobody knows how old this secret is.",
        action: "Change it once and record the date — after that the clock is honest.",
      });
    } else {
      const age = dayDiff(c.last_rotated_on, today);
      if (age !== null && age > ROTATION_DAYS) {
        push({
          code: "rotation_overdue",
          risk: age > ROTATION_DAYS * 2 ? "high" : "medium",
          message: `Last changed ${Math.round(age / 30)} months ago.`,
          action: `Rotate it — the target here is every ${ROTATION_DAYS} days.`,
        });
      }
    }

    // ── Where does the secret actually live? ────────────────────────────
    if (!c.stored_in || c.stored_in.trim() === "") {
      push({
        code: "no_location", risk: "high",
        message: "No record of where the secret is kept.",
        action: "Name the place — a password manager, a hardware token, or the person holding it.",
      });
    }

    // ── Single point of failure ─────────────────────────────────────────
    if (typeof c.holder_count === "number" && c.holder_count <= 1) {
      push({
        code: "single_holder", risk: "medium",
        message: "Only one person can get in.",
        action: "Give a second person access, or the business is locked out if they are unavailable.",
      });
    }

    // ── The one way a secret can leak into this table ───────────────────
    if (looksLikeSecret(c.notes)) {
      push({
        code: "secret_in_notes", risk: "critical",
        message: "The notes field looks like it contains an actual secret.",
        action: "Remove it. This register is readable by the whole workspace and is not encrypted for that purpose.",
      });
    }
  }

  const order: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, none: 3 };
  return out.sort(
    (a, b) => order[a.risk] - order[b.risk]
      || (a.daysOut ?? 9_999) - (b.daysOut ?? 9_999)
      || a.label.localeCompare(b.label)
  );
}

/** Worst risk present, for a header badge. */
export function worstRisk(findings: Finding[]): RiskLevel {
  if (findings.some((f) => f.risk === "critical")) return "critical";
  if (findings.some((f) => f.risk === "high")) return "high";
  if (findings.some((f) => f.risk === "medium")) return "medium";
  return "none";
}
