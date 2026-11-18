/**
 * R-2366 (2 Nov 2026, Pardeep: "app me interest income ka option banao"): a money-in line booked
 * as interest income — from an FD, a savings account or other — and an FD premature closure in one
 * save (principal back from the FD + interest), with the TDS the bank deducted.
 *
 * Money (book_bank_credit_as_interest, migration 20261102100702):
 *   Dr Bank = line · Cr FD account = principal · Dr TDS receivable = TDS · Cr Interest received = interest + TDS.
 */

export type InterestSource = "fd" | "savings" | "other";

/** Where the narration says the interest came from (the owner can change it). */
export function guessInterestSource(description: string | null | undefined): InterestSource {
  const d = description ?? "";
  if (/\b(fd|f\.d\.|fixed\s+dep\w*|term\s+dep\w*|td|premat\w*|closure|mat(urity)?\s+proc\w*)\b/i.test(d)) return "fd";
  if (/\b(sb|s\.b\.|savings?|sav)\b/i.test(d)) return "savings";
  return "other";
}

export type InterestSplit = {
  /** Interest credited on this line (line − principal). */
  interest: number;
  /** Interest income booked = interest credited + TDS deducted. */
  gross: number;
  /** Why it cannot be saved yet, in plain English; null = ready. */
  error: string | null;
};

/**
 * The parts of the bank line: principal back from the FD + interest credited = the line.
 * TDS is extra (it never reached the bank), so the income is interest + TDS.
 * fdBalance: the FD account's balance today, when known — principal may not be more.
 */
export function interestSplit(input: {
  credit: number;
  principal: number;
  tds: number;
  fdBalance?: number | null;
}): InterestSplit {
  const credit = Math.round(input.credit || 0);
  const principal = Math.round(input.principal || 0);
  const tds = Math.round(input.tds || 0);
  const interest = credit - principal;
  const gross = interest + tds;
  let error: string | null = null;
  if (principal < 0 || tds < 0) error = "Amounts cannot be negative.";
  else if (principal >= credit) error = "Principal must be less than the bank line — the rest is the interest.";
  else if (input.fdBalance != null && principal > input.fdBalance) error = "Principal is more than this FD's balance.";
  return { interest, gross, error };
}

/** The narration says interest (INT.PD, INTEREST, FD INT …) — then "Interest received" is picked first. */
export function looksLikeInterest(description: string | null | undefined): boolean {
  return /\b(int\.?\s?pd|interest|int\s+cr|fd\s+int|sb\s+int|int\.?\s+credit|int\.?\s+on\s+(fd|td|sb|dep\w*))\b/i.test(description ?? "");
}

/** An FD account as the redeem guess needs it. */
export type FdForGuess = { id: string; name: string; account_number_last4?: string | null };

/**
 * R-2390 (staging 2 Nov): the ₹40,02,110 "…AUTO_REDEEM" line pre-picked "Other income" — one click
 * would have booked ₹40 L of FD principal as income. Does the narration say an FD came back
 * (REDEEM / PREMAT / SWEEP, or names one of our FDs by number), and which FD?
 *   fdId   — the ONE FD whose number (6+ digits in its name) is in the narration, or whose last 4
 *            digits end a 6+ digit run on a line that talks about an FD / deposit / sweep (a UTR
 *            or cheque number on a customer receipt must not pick an FD); two FDs fit → null.
 *   redeem — a redeem word (REDEEM / PREMAT / SWEEP) on a line about an FD (an MF redemption or
 *            "REWARD POINTS REDEEMED" is not), or one of our FDs named — unless the line only says
 *            interest ("INT ON FD 5012", "SWEEP FD INT …" is interest on the FD, not its closure).
 */
const FD_CONTEXT = /\b(fdr?|f\.d\.?|fixed\s*dep\w*|term\s*dep\w*|tdr?|deposit\w*|sweep\w*|swp|auto\s?sweep\w*|auto\s?redeem\w*)\b/i;
const REDEEM_WORD = /\b(redeem\w*|redemption|premat\w*|pre\s?mat\w*|auto\s?redeem\w*|auto\s?sweep\w*|sweep\w*|swp)\b/i;
const CLOSURE_WORD = /\b(redeem\w*|redemption|premat\w*|pre\s?mat\w*|closure|closed)\b/i;

export function fdRedeemGuess(description: string | null | undefined, fds: readonly FdForGuess[]): { redeem: boolean; fdId: string | null } {
  const d = (description ?? "").replace(/[_-]+/g, " ");
  const fdContext = FD_CONTEXT.test(d);
  const runs = d.match(/\d{6,}/g) ?? [];
  const byNumber = (fd: FdForGuess) => (fd.name.match(/\d{6,}/g) ?? []).some((n) => runs.some((r) => r === n || r.endsWith(n) || n.endsWith(r)));
  const byLast4 = (fd: FdForGuess) => {
    const last4 = (fd.account_number_last4 ?? "").replace(/\D/g, "");
    return fdContext && last4.length === 4 && runs.some((r) => r.endsWith(last4));
  };
  const hits = fds.filter((fd) => byNumber(fd) || byLast4(fd));
  const fdId = hits.length === 1 ? hits[0].id : null;
  const interestOnly = looksLikeInterest(description) && !CLOSURE_WORD.test(d);
  const word = REDEEM_WORD.test(d) && (fdContext || fdId !== null);
  return { redeem: !interestOnly && (word || fdId !== null), fdId };
}

/**
 * R-2935 (staging 18 Nov 2026, HDFC 4523): HDFC pays a closed FD on three bank lines —
 * "FD REDEEM PRINCIPAL", "FD REDEEM INTEREST" and "FD REDEEM TAX". Which part does this line say
 * it is? null = it does not say (one line with everything, or not an FD line at all).
 */
export type FdRedeemPart = "principal" | "interest" | "tax";

const PRINCIPAL_WORD = /\b(prin|princ|principal|prncpl)\b/i;
const TAX_WORD = /\b(tax|tds)\b/i;

export function fdRedeemPart(description: string | null | undefined): FdRedeemPart | null {
  const d = (description ?? "").replace(/[_-]+/g, " ");
  if (PRINCIPAL_WORD.test(d)) return "principal";
  if (looksLikeInterest(d)) return "interest";
  if (TAX_WORD.test(d)) return "tax";
  return null;
}

/** An FD as the closure guard needs it. */
export type FdForGuard = { id: string; current_balance?: number | null };

/**
 * R-2935: may a redeem line (fdRedeemGuess().redeem) be booked as plain interest, without the
 * "FD closed" split? Only its INTEREST part may, and never silently unless the books show the
 * principal is already out:
 *   "hold" — the line says PRINCIPAL, or says nothing about interest (as R-2390); or it says
 *            INTEREST but the picked FD still holds money that fits in this line (0 < balance ≤
 *            line); no FD picked → the same test against every FD of the company.
 *   "free" — it says INTEREST and the picked FD's balance is exactly 0: its principal line is
 *            already reconciled, so this line cannot be the principal.
 *   "ask"  — it says INTEREST but nothing proves the principal is elsewhere (no FD picked, the
 *            FD's balance unknown, or the FD still holds more than the line — a part-withdrawal
 *            would look the same): the owner must say "Interest only" himself.
 * A line that is not a redeem line is always "free".
 */
export type RedeemVerdict = "free" | "ask" | "hold";

export function redeemVerdict(input: {
  description: string | null | undefined;
  redeem: boolean;
  credit: number;
  fd: FdForGuard | null;
  fds: readonly FdForGuard[];
}): RedeemVerdict {
  if (!input.redeem) return "free";
  if (fdRedeemPart(input.description) !== "interest") return "hold";
  const holdsPrincipal = (fd: FdForGuard) => (fd.current_balance ?? 0) > 0 && input.credit >= (fd.current_balance ?? 0);
  if (!input.fd) return input.fds.some(holdsPrincipal) ? "hold" : "ask";
  if (holdsPrincipal(input.fd)) return "hold";
  return input.fd.current_balance === 0 ? "free" : "ask";
}

/**
 * R-2935: a money-OUT line that is the bank's own TDS on interest ("FD REDEEM TAX", "TDS ON FD INT")
 * — TDS receivable (Sec 194A), not a challan the company paid and not an expense.
 */
export function looksLikeInterestTds(description: string | null | undefined): boolean {
  const d = (description ?? "").replace(/[_-]+/g, " ");
  if (!TAX_WORD.test(d)) return false;
  /* A payment the company itself made (challan, 201(1A) interest, a quarter's deposit), or money
     put INTO a tax-saver FD, is not the bank's TDS. */
  if (/\b(itns|challan|cin|advance\s*tax|self\s*assessment|income\s*tax|gst\w*|tcs|201|q[1-4]|tax\s*sav\w*)\b/i.test(d)) return false;
  /* "FD REDEEM TAX", "TAX DEDUCTED ON TERM DEPOSIT" — an FD named (the bare word "deposit" is not enough) … */
  if (/\b(fdr?|f\.d\.?|fixed\s*dep\w*|term\s*dep\w*|tdr)\b/i.test(d)) return true;
  /* … or "TDS ON INT", "TAX ON SB INTEREST". */
  return /\b(tds|tax)\s+(ded\w*\s+)?on\s+(\w+\s+)?int(erest)?\b/i.test(d);
}

/** An interest row a bank's TDS line can belong to (bank_interest_without_tds). */
export type InterestForTds = { id: string; income_date: string; amount: number };

/**
 * R-2935: which booked interest is this TDS line for? Only a same-day interest the TDS is 10% (or
 * 20%, no PAN) of — within ₹1 — is pre-picked, and only when exactly one fits. Anything less sure
 * → "" (the owner picks): a wrong pick marks the wrong interest and a wrong gross for 26AS.
 */
export function pickInterestForTds(rows: readonly InterestForTds[], tds: number, txnDate: string): string {
  const sameDay = rows.filter((r) => r.income_date === txnDate && r.amount > tds);
  const byRate = sameDay.filter((r) => [0.1, 0.2].some((rate) => Math.abs(r.amount * rate - tds) <= 1));
  return byRate.length === 1 ? byRate[0].id : "";
}
