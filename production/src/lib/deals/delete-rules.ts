/**
 * May this deal (a `leads` row) be deleted — and if not, what to do instead (2 Oct 2026).
 *
 * Pardeep: "kya deal delete hone ka koi system nahi hai". Deleting was open to every rep,
 * from the drawer only, and on a deal with a quote it failed with a raw foreign-key error.
 *
 *  - Only an owner or a manager deletes. A rep marks a deal Lost (with a reason), which
 *    keeps the history and the win/loss numbers honest. The database enforces this too
 *    (policy leads_delete_owner_manager), this is the words for it.
 *  - A deal with a quote is never deleted: the quote (and any invoice or payment behind it)
 *    is part of the books, and quotes.lead_id keeps it. Mark it Lost instead.
 */
export interface DeleteCheck {
  role: string | null | undefined;
  quoteIds: readonly string[];
  /** R-1806: the quotes read failed, so quoteIds is not known to be empty. */
  quotesFailed?: boolean;
}

export function dealDeleteBlock(c: DeleteCheck): string | null {
  if (c.role !== "owner" && c.role !== "manager") {
    return "Only an owner or manager can delete a deal. Mark it Lost instead — it keeps the history.";
  }
  if (c.quotesFailed) {
    return "This deal's quotes didn't load, so we can't check it is safe to delete. Try again once they load, or mark it Lost.";
  }
  if (c.quoteIds.length > 0) {
    const shown = c.quoteIds.slice(0, 2).join(", ") + (c.quoteIds.length > 2 ? ` and ${c.quoteIds.length - 2} more` : "");
    return `This deal has ${c.quoteIds.length === 1 ? "a quote" : "quotes"} (${shown}), which are part of your records — it cannot be deleted. Mark it Lost instead.`;
  }
  return null;
}

/** A database refusal to delete, in words — the FK on quotes, or the role policy. */
export function friendlyDeleteError(message: string, code?: string | null): string | null {
  if (code === "23503" || /foreign key|violates.*constraint/i.test(message)) {
    return "This deal still has quotes or other records linked to it, so it cannot be deleted. Mark it Lost instead.";
  }
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return "Only an owner or manager can delete a deal. Mark it Lost instead.";
  }
  return null;
}
