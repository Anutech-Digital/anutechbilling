"use client";

/**
 * R-2243: the one "why is the customer leaving?" picker — used by Cancel subscription and Won't renew,
 * so both write the same reason codes (lib/subscriptions/leave-reasons.ts) and the owner can count them.
 * A reason is required; "Other" needs a note, every other reason takes an optional one.
 */
import { FormField } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LEAVE_REASONS, OTHER_NOTE_MIN } from "@/lib/subscriptions/leave-reasons";

const SELECT_CLS =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40 disabled:opacity-70";

export function LeaveReasonField({ idPrefix, code, note, onCode, onNote }: {
  /** The note's id; the picker's id is `${idPrefix}-code`. */
  idPrefix: string;
  code: string;
  note: string;
  onCode: (v: string) => void;
  onNote: (v: string) => void;
}) {
  const otherNeedsNote = code === "other";
  return (
    <>
      <FormField label="Why is the customer leaving?" htmlFor={`${idPrefix}-code`} required>
        <select id={`${idPrefix}-code`} name="leave_reason_code" value={code} onChange={(e) => onCode(e.target.value)} className={SELECT_CLS}>
          <option value="">Pick a reason…</option>
          {LEAVE_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </FormField>
      <FormField label={otherNeedsNote ? `Note (needed for Other, ${OTHER_NOTE_MIN}+ characters)` : "Note (optional)"} htmlFor={idPrefix}>
        <Textarea id={idPrefix} name="reason_note" rows={2} value={note} onChange={(e) => onNote(e.target.value)}
          placeholder={otherNeedsNote ? "What did the customer say?" : "Anything worth remembering"} />
      </FormField>
    </>
  );
}
