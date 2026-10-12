/**
 * A project sale, read as the QUOTATION it started life as — R-006 (Pardeep, 25 Sep 2026).
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * A project's quotation lives on `project_sales` itself: status `quoted` becomes
 * `active` on acceptance, the line items hang off the same row, and the customer sees
 * it at `/project-quote/<id>?t=<token>`. There is no row in `quotes`.
 *
 * So Customer 360 -> Transactions -> Quotes showed only `quotes` rows, and for a
 * software client like Demo Co that meant an empty tab next to a deal that
 * was very much quoted. The owner reads that as "nobody ever sent them a quote".
 *
 * ─── WHY NOT JUST COPY THEM INTO `quotes` ───────────────────────────────────
 * Pardeep's request says it plainly and he is right: a copy would double them in the
 * quote pipeline and in Customer 360, and then the two rows would drift. This maps the
 * project's own status onto quote language at the point of DISPLAY. Nothing is written.
 */

export type ProjectQuotationKind = "muted" | "success" | "warning" | "danger";

export interface ProjectQuotationView {
  /** What to call it in a list of quotes. */
  label: string;
  kind: ProjectQuotationKind;
  /** True while it is still a live proposal — nobody has accepted it. */
  pending: boolean;
}

/**
 * How a project's status reads in quote language.
 *
 * `accepted_at` is preferred over the status when both are present, because it is the
 * event and the status is a summary of it. A project can be moved to active by other
 * paths; a timestamp on `accepted_at` only gets there one way.
 */
export function projectQuotationView(
  status: string | null | undefined,
  acceptedAt: string | null | undefined,
): ProjectQuotationView {
  const s = (status ?? "").toLowerCase();

  if (s === "cancelled") return { label: "Declined", kind: "danger", pending: false };
  if (acceptedAt) return { label: "Accepted", kind: "success", pending: false };
  if (s === "active" || s === "completed") {
    /* Accepted by a path that did not stamp the timestamp — older rows, and projects
       created directly from a bank receipt. Still accepted; we just cannot say when,
       and inventing a date on a document trail is worse than omitting one. */
    return { label: "Accepted", kind: "success", pending: false };
  }
  if (s === "quoted") return { label: "Quotation", kind: "warning", pending: true };
  if (s === "draft")  return { label: "Draft", kind: "muted", pending: true };

  /* An unrecognised status is not "fine". Saying so beats picking the friendliest of
     the labels above and having the list quietly under-report open proposals. */
  return { label: status?.trim() ? status : "Unknown", kind: "muted", pending: false };
}

/** Does this project belong in a list of quotes at all? */
export function isQuotableProject(status: string | null | undefined): boolean {
  /* Every project raised through `create_project_quote` has a quotation behind it,
     including the ones since accepted — an accepted quote is still a quote, and hiding
     it is what made the tab look empty. A cancelled one stays, so the trail is complete. */
  return Boolean((status ?? "").trim());
}
