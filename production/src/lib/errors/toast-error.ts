/**
 * One place that turns an unknown thrown value into a toast a non-technical
 * operator can act on — CLAUDE.md §24 ("what happened · why · what to do next")
 * and §11 ("never throw raw errors to the user").
 *
 * WHY THIS EXISTS
 * The audit in docs/UX-AUDIT.md (G1) measured 278 `toast.error` call sites, of
 * which 3 carried a description and 1 carried an action button. 147 were the
 * literal anti-pattern `toast.error((e as Error).message)` — a raw Postgres/RPC
 * exception rendered to the user.
 *
 * THE KEY DESIGN DECISION: decide by the MESSAGE TEXT, never by the error code.
 * Our `SECURITY DEFINER` guards deliberately raise *good, actionable* messages
 * WITH a technical errcode attached, e.g.
 *
 *   raise exception 'This payment is reconciled to a bank transaction —
 *     un-reconcile that bank line first, then delete.'
 *   raise exception 'quote % has no amount …' using errcode = 'check_violation'
 *
 * Keying off `code` would throw those away and replace careful business copy
 * with something generic. So we do the opposite: pass every message through
 * UNCHANGED unless it matches a known pattern of raw database plumbing.
 * Allowlist-to-translate, not allowlist-to-show.
 *
 * TWO TIERS (see docs/UX-AUDIT.md §7)
 *  - `lib/queries/*` mutation `onError`: call `toastError(err)`. Gives every
 *    screen the "what happened + why" half for free. Query modules have no
 *    router and don't know where the user is, so they pass no action.
 *  - Pages, where a destination IS known: pass `action` to add the button —
 *    the "what to do next" half. See payments/page.tsx for the shape.
 */

import { toast } from "sonner";

export interface ToastErrorAction {
  label: string;
  onClick: () => void;
}

export interface DescribedError {
  /** Safe to render. Never raw database plumbing. */
  message: string;
  /** Optional second line — the why / the next step. */
  description?: string;
  /** True when the original text was technical and we replaced it. */
  translated: boolean;
  /** The original text. Kept for console/support; never rendered by default. */
  raw: string;
}

/** Pull a string out of whatever was thrown (Error, PostgrestError, string, …). */
function rawMessageOf(err: unknown): string {
  if (typeof err === "string") return err.trim();
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m.trim();
  }
  return "";
}

/**
 * Patterns that mean "this is database plumbing, not a sentence for a human".
 * Deliberately narrow — anything not matched here is assumed to be intentional
 * operator-facing copy and is shown as-is.
 */
const PLUMBING: ReadonlyArray<{
  test: RegExp;
  message: string;
  description: string;
}> = [
  {
    test: /duplicate key value|already exists.*constraint|violates unique constraint/i,
    message: "This is already saved.",
    description: "A record with the same details exists. Open the existing one instead of adding it twice.",
  },
  {
    test: /violates foreign key constraint|is not present in table/i,
    message: "Something this depends on is missing.",
    description: "A linked record was removed, or was never saved. Refresh the page and try again.",
  },
  {
    test: /violates not-null constraint|null value in column/i,
    message: "A required field is empty.",
    description: "Fill in the missing field and save again — nothing was saved.",
  },
  {
    test: /violates row-level security|permission denied for|insufficient_privilege/i,
    message: "You don't have access to this.",
    description: "It belongs to another workspace, or your role doesn't allow it. Ask the owner to give you access.",
  },
  {
    test: /(relation|column|function) .* does not exist|syntax error at or near/i,
    message: "Something went wrong on our side.",
    description: "Nothing was saved. Please report this — the details are in the browser console.",
  },
  {
    test: /failed to fetch|network ?error|load failed|fetch failed|econnrefused|timeout/i,
    message: "Network problem.",
    description: "Nothing was saved. Check your connection and try again.",
  },
  {
    test: /jwt|token .*expired|refresh_token|not authenticated|auth session missing/i,
    message: "Your session expired.",
    description: "Sign in again — your work up to the last save is safe.",
  },
];

const GENERIC = {
  message: "Something went wrong.",
  description: "Nothing was saved. Try again — if it keeps happening, report it with the details from the browser console.",
};

/**
 * Turn any thrown value into renderable copy. PURE — unit-tested; the toast
 * wrapper below is the only side-effecting part.
 *
 * @param fallback message to use when the error carries no usable text
 */
export function describeError(err: unknown, fallback?: string): DescribedError {
  const raw = rawMessageOf(err);

  if (!raw) {
    return { message: fallback ?? GENERIC.message, description: fallback ? undefined : GENERIC.description, translated: true, raw: "" };
  }

  for (const p of PLUMBING) {
    if (p.test.test(raw)) {
      return { message: p.message, description: p.description, translated: true, raw };
    }
  }

  // Not plumbing → intentional operator-facing copy (usually an RPC guard that
  // already states the next step). Show it exactly as written.
  return { message: raw, translated: false, raw };
}

/**
 * Show an error toast that never dead-ends.
 *
 * @example query module — reason + why, no destination available
 *   onError: (err) => toastError(err)
 *
 * @example page — adds the "what to do next" button
 *   toastError(err, {
 *     action: { label: "Open quote", onClick: () => router.push(`/quotes/${id}`) },
 *   })
 */
export function toastError(
  err: unknown,
  opts: { description?: string; action?: ToastErrorAction; fallback?: string; duration?: number } = {}
): void {
  const d = describeError(err, opts.fallback);

  // Never lose the original — hidden from the operator, available for support.
  if (d.translated && d.raw) {
    // eslint-disable-next-line no-console
    console.error("[toastError]", d.raw, err);
  }

  toast.error(d.message, {
    description: opts.description ?? d.description,
    action: opts.action ? { label: opts.action.label, onClick: opts.action.onClick } : undefined,
    // R-431: an error with a fix button must stay long enough to press it (default ~4 s).
    ...(opts.duration ? { duration: opts.duration } : {}),
  });
}
