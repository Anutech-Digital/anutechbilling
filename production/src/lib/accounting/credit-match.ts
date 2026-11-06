/**
 * Matching a bank CREDIT to the quote it probably paid.
 *
 * ─── THE GAP THIS FILLS ─────────────────────────────────────────────────────
 * `suggest_bank_transaction_matches` already proposes candidates for a credit — but only
 * against `payments` and `project_payments`, i.e. money somebody has ALREADY RECORDED.
 * The case that actually strands a deposit is the opposite one:
 *
 *   The customer pays by UPI or NEFT straight into the bank. No payment row exists yet.
 *   So the credit has nothing to match against, and it sits unreconciled for ever.
 *
 * That is not an edge case for an Indian reseller, it is the normal path — and it got
 * MORE normal the day we started putting a `upi://pay` link in the reminder. On ANUTECH's
 * live books this is ₹4.6 lakh across 9 deposits, every one of them older than a week.
 * Cash balance correct, ledger wrong, every revenue report understated.
 *
 * ─── WHY THIS IS TYPESCRIPT AND NOT SQL ─────────────────────────────────────
 * The existing suggester is a Postgres RPC and extending it would be the tidier home.
 * It also could not ship today: applying a migration needs write access this checkout
 * does not have. This runs over data the client already fetches, so the feature works
 * now; folding it into the RPC later changes nothing a caller can see.
 *
 * ─── THE NAME IN THE NARRATION IS THE STRONGEST SIGNAL, NOT THE AMOUNT ──────
 * Amount-and-date matching is what everyone builds first and it is the weaker half. Two
 * customers on the same monthly plan produce identical amounts on the same day, and a
 * confident wrong match posts money against the wrong customer — which is worse than no
 * match, because nobody goes back to check a reconciled line.
 *
 * A bank narration usually says WHO paid:
 *
 *   UPI-MUKUL BHARDWAJ-9896033878-2@AXL-BARB
 *   IMPS-519009330625-DARSHAN KUMAR-HDFC-XXXXXXX
 *
 * A name hit plus an amount hit is near-certain. An amount hit alone is a guess worth
 * showing and never worth applying by itself — which is why `confidence` is returned and
 * nothing in this module writes anything.
 *
 * ─── NOTHING IS EVER AUTO-APPLIED ───────────────────────────────────────────
 * This proposes. A human confirms. The 1-click button in the UI is one click for the
 * OPERATOR, not one click the machine takes on its own — a mis-posted receipt has to be
 * unwound through a credit note, and the customer sees it.
 */

/** Rail names, bank codes and statement noise — never a customer's name. */
const NARRATION_NOISE = new Set([
  "upi", "imps", "neft", "rtgs", "tpt", "ift", "ach", "ecs", "emi", "chq", "cheque",
  "cr", "dr", "ref", "txn", "api", "banking", "transfer", "payment", "paid", "from",
  "hdfc", "icic", "icici", "sbin", "sbi", "axis", "axl", "barb", "pnb", "kkbk", "utib",
  "yesb", "idib", "cnrb", "ubin", "iob", "bkid", "mahb", "nesf", "okhdfcbank", "oksbi",
  "okaxis", "okicici", "ybl", "paytm", "ptm", "ptyes", "gpay", "phonepe", "apl", "airtel",
  "collect", "reversal", "refund", "charges", "interest", "given", "loan", "self",
]);

/**
 * Words in a bank narration that could plausibly be part of a person or company name.
 *
 * Numbers, single letters and two-letter fragments are dropped: a UTR is not a name, and
 * a two-letter token matches far too much. Masked account digits (`XXXXXXX10`) fall out
 * because they are stripped to `xx`, which is under the length floor.
 */
export function narrationNames(description: string | null | undefined): string[] {
  if (!description) return [];
  return description
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !NARRATION_NOISE.has(w))
    .filter((w) => !/^x+$/.test(w));
}

/** Meaningful words in a customer or company name, for comparison against the above. */
const NAME_NOISE = new Set([
  "pvt", "private", "ltd", "limited", "llp", "inc", "co", "company", "corp",
  "corporation", "corprotion", "and", "the", "enterprises", "enterprise", "solutions",
  "technologies", "technology", "services", "service", "systems", "digital",
]);

export function customerNameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !NAME_NOISE.has(w));
}

/**
 * Do the narration and the customer name share a distinctive word?
 *
 * Deliberately not fuzzy. Levenshtein on short Indian names produces confident nonsense
 * — "Neetu" and "Neeta" are one edit apart and different people, and posting a receipt
 * to the wrong one is the failure this whole module is guarding against.
 */
export function nameOverlap(description: string | null | undefined, customerName: string | null | undefined): string | null {
  const narration = cachedNarrationSet(description);
  for (const token of cachedNameTokens(customerName)) {
    if (narration.has(token)) return token;
  }
  return null;
}

/* R-2524: the bank page runs nameOverlap for every unmatched credit × every open invoice
   (≈ 800 × 400 on a 6,000-line account) — split each narration / name once, not per pair.
   Same words as narrationNames / customerNameTokens; read-only, so the cached copy is shared.
   Bounded: past CACHE_MAX entries a map starts again (a long session never grows it for ever). */
const CACHE_MAX = 20_000;
const narrationSets = new Map<string, ReadonlySet<string>>();
const nameTokenLists = new Map<string, readonly string[]>();
const NO_WORDS: ReadonlySet<string> = new Set();
/** narrationNames as a Set, cached per narration text (R-2524). Never mutate the result. */
export function cachedNarrationSet(description: string | null | undefined): ReadonlySet<string> {
  if (!description) return NO_WORDS;
  let hit = narrationSets.get(description);
  if (!hit) {
    if (narrationSets.size >= CACHE_MAX) narrationSets.clear();
    hit = new Set(narrationNames(description));
    narrationSets.set(description, hit);
  }
  return hit;
}
/** customerNameTokens, cached per name (R-2524). Never mutate the result. */
export function cachedNameTokens(name: string | null | undefined): readonly string[] {
  if (!name) return [];
  let hit = nameTokenLists.get(name);
  if (!hit) {
    if (nameTokenLists.size >= CACHE_MAX) nameTokenLists.clear();
    hit = customerNameTokens(name);
    nameTokenLists.set(name, hit);
  }
  return hit;
}

export type MatchConfidence = "certain" | "likely" | "possible";

export interface CreditMatchCandidate {
  quoteId: string;
  customerName: string | null;
  /** Whole rupees the quote is for. */
  quoteAmount: number;
  quoteDate: string;
  confidence: MatchConfidence;
  /** The reason, in the operator's words. Shown on the row; never a score. */
  why: string;
  /** The narration word that matched a customer name, when one did. */
  matchedName: string | null;
  /** Rupees apart. 0 on an exact match. */
  amountGap: number;
  /** Days between the deposit and the quote. */
  dayGap: number;
}

export interface CreditToMatch {
  amount: number;
  /** YYYY-MM-DD. */
  txnDate: string;
  description: string | null;
}

export interface QuoteCandidate {
  id: string;
  customerName: string | null;
  amount: number;
  /** YYYY-MM-DD — when the quote was raised. */
  quoteDate: string;
}

/**
 * ₹100. Matches the tolerance the existing SQL suggester already uses, so the two
 * cannot disagree about what "same amount" means. It absorbs a bank charge or a rounding
 * difference, not a different invoice.
 */
export const AMOUNT_TOLERANCE = 100;
/**
 * A quote raised up to 90 days before the money arrived is still plausibly what was
 * paid — Indian B2B payment terms routinely run 30 to 60 days, and a quote chased twice
 * takes longer. Money arriving BEFORE the quote existed is not a payment for it, so the
 * window is one-directional.
 */
export const MAX_DAYS_BEFORE = 90;
/** A couple of days of slack for a deposit that landed just before the paperwork. */
export const MAX_DAYS_AFTER = 2;

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO.slice(0, 10)}T00:00:00+05:30`);
  const b = Date.parse(`${toISO.slice(0, 10)}T00:00:00+05:30`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Rank the open quotes this credit might have paid. Best first, and an empty array when
 * nothing is plausible — which is a perfectly good answer and better than a bad one.
 */
export function matchCreditToQuotes(
  credit: CreditToMatch,
  quotes: readonly QuoteCandidate[],
): CreditMatchCandidate[] {
  const out: CreditMatchCandidate[] = [];

  for (const q of quotes) {
    const amountGap = Math.abs(q.amount - credit.amount);
    /* dayGap > 0 means the quote came first, which is the normal order. */
    const dayGap = daysBetween(q.quoteDate, credit.txnDate);
    const matchedName = nameOverlap(credit.description, q.customerName);
    const amountMatches = amountGap <= AMOUNT_TOLERANCE;

    if (dayGap < -MAX_DAYS_AFTER || dayGap > MAX_DAYS_BEFORE) continue;
    /* Neither signal present is not a candidate. Listing every open quote as "possible"
       would bury the real one and teach the operator to click the first row. */
    if (!amountMatches && !matchedName) continue;

    const confidence: MatchConfidence =
      matchedName && amountMatches ? "certain"
      : amountMatches ? "likely"
      : "possible";

    const why =
      confidence === "certain"
        ? `The deposit says “${matchedName}” and the amount matches to the rupee.`
        : confidence === "likely"
          ? amountGap === 0
            ? "Exact amount, and the dates line up — but the deposit does not name the payer."
            : `Within ₹${amountGap} of this quote, and the dates line up — the deposit does not name the payer.`
          : `The deposit says “${matchedName}”, but the amount is ₹${amountGap} away — a part payment, or a different invoice.`;

    out.push({
      quoteId: q.id, customerName: q.customerName, quoteAmount: q.amount,
      quoteDate: q.quoteDate, confidence, why, matchedName, amountGap, dayGap,
    });
  }

  /* certain → likely → possible, then closest amount, then closest date. */
  const rank: Record<MatchConfidence, number> = { certain: 0, likely: 1, possible: 2 };
  return out.sort((a, b) =>
    rank[a.confidence] - rank[b.confidence] ||
    a.amountGap - b.amountGap ||
    Math.abs(a.dayGap) - Math.abs(b.dayGap));
}

/**
 * May this be applied without a human reading it?
 *
 * Always false. The function exists so the question has one answer in one place, rather
 * than each caller deciding — and so that a future "auto-reconcile everything certain"
 * feature has to change this line, in a diff somebody reviews, instead of appearing by
 * accident in a UI handler.
 *
 * A mis-posted receipt is unwound through a credit note and the customer sees it. One
 * click by the operator is cheap; one click by the machine is not.
 */
export function canAutoApply(_c: CreditMatchCandidate): boolean {
  return false;
}
