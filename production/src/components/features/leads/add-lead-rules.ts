/**
 * Add lead — small rules kept out of the 1,500-line form so they can be tested (R-483).
 *
 * R-442: a new lead had no owner. The Owner select lives on step 2, and the form read the
 *        owner from React Hook Form, which only learns the value once that hidden input is
 *        registered — so a lead saved without visiting step 2's Owner box went in with
 *        owner_id = null and never showed in "My assigned".
 * R-449: a 5-digit phone, 0 seats and a negative price were all accepted in silence.
 */
import { parseMoney } from "@/lib/forms/poka-yoke";
import { phoneDigits } from "@/lib/leads/quick-add";

/**
 * The owner to save.
 * - Editing: whatever the Owner box says ("" = unassigned).
 * - New lead, owner never touched: `undefined`, so the create hook fills in the signed-in
 *   user (queries/leads.ts#withCreatorAsOwner) even if the form loaded before the user did.
 * - New lead, "Unassigned" picked on purpose: null.
 */
export function ownerForSave(i: { ownerId: string; picked: boolean; isEditing: boolean }): string | null | undefined {
  if (i.ownerId) return i.ownerId;
  if (i.isEditing || i.picked) return null;
  return undefined;
}

/** Same rule as Quick add (lib/leads/quick-add.ts): a phone, if given, has 10+ digits. */
export function phoneProblem(raw: string | null | undefined): string | null {
  const d = phoneDigits(raw);
  if (!d) return null;
  return d.length < 10 ? "A phone number needs at least 10 digits." : null;
}

/** Price per seat box: empty is fine, a negative number is not. */
export function priceProblem(raw: string): string | null {
  const n = parseMoney(raw);
  if (n == null) return null;
  return n < 0 ? "Price can't be negative." : null;
}

/**
 * The empty form for a NEW lead. Used on close too: a bare `reset()` goes back to the values
 * the form was FIRST mounted with — which, when Edit was the first thing opened, are that
 * lead's. Add lead then opened pre-filled with the last edited lead (seen 9 Oct 2026).
 */
export function blankLeadValues<S extends string>(defaultStage: S | undefined) {
  return {
    company: "", contact_name: "", contact_email: "", contact_phone: "", gstin: "", state_code: "",
    enquiry_type: "subscription" as const,
    requirement: "", project_timeline: "", plan: "",
    seats: undefined, value: undefined,
    stage: (defaultStage ?? "new") as S | "new",
    source: "manual", priority: "medium" as const,
    follow_up_date: "", expected_close_date: "", owner_id: "",
    subscription_type: "" as const, billing_cycle: "" as const, current_provider: "", notes: "",
  };
}
