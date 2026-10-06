/**
 * R-216 (R-089): shared UI words so buttons and labels read the same everywhere.
 * App UI copy is short plain English; chat/AI text can stay Hinglish.
 */
export const COPY = {
  save: "Save",
  cancel: "Cancel",
  tryAgain: "Try again",
  open: "Open",
  send: "Send",
  done: "Done",
  remove: "Remove",
  add: "Add",
  back: "Back",
  delete: "Delete",
  yesRemove: "Yes, remove",
  showLess: "Show less",
  check: "Check",
  pending: "Pending",
} as const;

export type CopyKey = keyof typeof COPY;
