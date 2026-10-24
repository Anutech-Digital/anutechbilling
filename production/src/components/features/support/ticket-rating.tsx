"use client";

/**
 * CSAT on a support ticket — DSP-merge brick 3 UI (7 Sep 2026).
 *
 * Two faces of the same fact:
 *   · <RateTicket>   — the PORTAL customer's one chance to score a finished
 *     ticket (1–5 + an optional line). One verdict per ticket, enforced by the
 *     DB (unique key + RLS gate on resolved/closed); this widget just makes
 *     the honest path pleasant and shows the verdict once given.
 *   · <RatingStars>  — the read-only display anybody uses to SHOW a rating
 *     (the agent panel, and the portal card after rating).
 *
 * Errors are inline, not toasts — the portal layout ships no toaster, and a
 * §24 dead-end ("kuch galat ho gaya") is exactly what this codebase refuses.
 */

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const STAR_LABEL: Record<number, string> = {
  1: "Very poor",
  2: "Poor",
  3: "Okay",
  4: "Good",
  5: "Excellent",
};

export function RatingStars({ score, size = 16 }: { score: number; size?: number }) {
  return (
    <span
      role="img"
      aria-label={`${score} out of 5 stars`}
      className="inline-flex items-center gap-0.5 align-middle"
      style={{ fontSize: size }}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} aria-hidden="true" className={i <= score ? "text-amber" : "text-ink-3/40"}>
          ★
        </span>
      ))}
    </span>
  );
}

interface RateTicketProps {
  ticketId: string;
  tenantId: string;
  ratedByEmail: string;
  existing: { score: number; comment: string | null } | null;
}

export function RateTicket({ ticketId, tenantId, ratedByEmail, existing }: RateTicketProps) {
  const [given, setGiven] = useState(existing);
  const [score, setScore] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already rated (now or earlier): show the verdict, offer no edits — the DB
  // would refuse them anyway, and a rating you can haggle with measures nothing.
  if (given) {
    return (
      <div className="mt-3 pt-3 border-t border-hairline flex items-center gap-2 flex-wrap text-xs text-ink-2">
        <span className="font-semibold text-ink">Your rating:</span>
        <RatingStars score={given.score} />
        {given.comment && <span className="text-ink-3">“{given.comment}”</span>}
      </div>
    );
  }

  const submit = async () => {
    setSaving(true);
    setError(null);
    const supabase = createClient();
    const { error: err } = await supabase.from("support_ticket_ratings").insert({
      tenant_id: tenantId,
      ticket_id: ticketId,
      score,
      comment: comment.trim() || null,
      rated_by_email: ratedByEmail,
    });
    setSaving(false);
    if (err) {
      // 23505 = somebody (another device/tab) already rated — that IS the verdict.
      if (err.code === "23505") {
        setGiven({ score, comment: comment.trim() || null });
        return;
      }
      setError(
        "Your rating was not saved — it may be a network or session problem. Refresh the page and try again, or press Retry below.",
      );
      return;
    }
    setGiven({ score, comment: comment.trim() || null });
  };

  return (
    <div className="mt-3 pt-3 border-t border-hairline">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-ink">How was our support?</span>
        <div role="radiogroup" aria-label="Rate this ticket from 1 to 5 stars" className="inline-flex">
          {[1, 2, 3, 4, 5].map((i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={score === i}
              aria-label={`${i} star${i > 1 ? "s" : ""} — ${STAR_LABEL[i]}`}
              title={STAR_LABEL[i]}
              onClick={() => setScore(i)}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(0)}
              className={`px-0.5 text-xl leading-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink rounded ${
                i <= (hover || score) ? "text-amber" : "text-ink-3/40"
              }`}
            >
              ★
            </button>
          ))}
        </div>
        {score > 0 && <span className="text-2xs text-ink-3">{STAR_LABEL[score]}</span>}
      </div>

      {score > 0 && (
        <div className="mt-2 flex gap-2 flex-wrap">
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            placeholder="Anything you'd like to add? (optional)"
            aria-label="Optional comment with your rating"
            className="flex-1 min-w-[180px] rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="text-xs font-semibold px-3 py-1.5 rounded-md bg-ink text-paper hover:opacity-90 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          >
            {saving ? "Sending…" : "Submit rating"}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-2xs text-rose">
          {error}{" "}
          <button
            type="button"
            onClick={submit}
            className="font-semibold underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink rounded"
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
