/**
 * Mark the current workspace tab as holding unsaved work.
 *
 * A tab flagged as a draft cannot be evicted silently when the 8-tab limit is
 * reached, and closing it asks first. Both of those already worked in the
 * reducer — nothing was calling `setDraft`, so the protection existed and never
 * fired. This hook is the missing call.
 *
 * ─── WHY A HOOK RATHER THAN A LINE IN EACH FORM ──────────────────────────────
 * Three things have to happen together and are each easy to forget in isolation:
 * flag on dirty, CLEAR on save, and clear on unmount. Getting the second one
 * wrong is the expensive mistake — a tab left flagged after a successful save
 * prompts "you have unsaved changes" forever, and a prompt that is wrong every
 * time is one users learn to click through, including the time it is right.
 *
 * ─── IT DOES NOT STASH VALUES ────────────────────────────────────────────────
 * `setDraft` can carry a formState snapshot, and this deliberately passes none.
 * Doing that on every keystroke would serialise the whole form into
 * sessionStorage continuously, and a half-restored form is its own bug class —
 * uncontrolled inputs and third-party widgets would not come back, so the user
 * would be handed a form that looks restored and quietly is not. The flag alone
 * buys the thing that matters: nothing closes the tab without asking.
 */
"use client";

import * as React from "react";
import { useWorkspaceTabs } from "@/components/providers/workspace-tabs-provider";
import { setFormDirty } from "./dirty-forms";

export function useDraftGuard(isDirty: boolean): void {
  const { activeId, setDraft } = useWorkspaceTabs();

  const token = React.useRef<symbol>(Symbol("draft"));
  React.useEffect(() => {
    const t = token.current;
    // R-490: what the browser close warning reads (dirty-forms.ts).
    setFormDirty(t, isDirty);
    return () => setFormDirty(t, false);
  }, [isDirty]);

  React.useEffect(() => {
    if (!activeId) return;
    setDraft(activeId, isDirty);
  }, [activeId, isDirty, setDraft]);

  // Clear on unmount. Without this, navigating away from a dirty form leaves the
  // tab flagged for the rest of the session — the form is gone, its unsaved
  // state with it, and the tab still refuses to close quietly.
  //
  // `activeId` is captured in a ref rather than listed as a dependency: as a
  // dependency the cleanup would run on every tab switch and clear the flag on
  // the tab the user just left, which is precisely the tab that needs it.
  const idRef = React.useRef(activeId);
  idRef.current = activeId;
  React.useEffect(() => () => {
    if (idRef.current) setDraft(idRef.current, false);
  }, [setDraft]);
}
