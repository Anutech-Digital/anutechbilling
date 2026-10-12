/**
 * What a customer IS, on the customers list — R-005 (Pardeep, 25 Sep 2026).
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * The list read subscriptions and nothing else. So Demo Co — an active
 * ₹10,80,000 ERP build, `project_sales.customer_id` correctly set — showed as
 * **"No subscription", Monthly ₹0, Yearly ₹0**, and fell under the "No subscription"
 * filter beside genuinely dead accounts.
 *
 * Nothing was broken in the usual sense. The customer 360 page already showed the
 * project; only the list, which is where anybody looks first, said the account was
 * empty. A reseller who sells custom software as well as seats reads that as churn.
 *
 * ─── WHY "QUOTED" IS NOT THE SAME AS "CLIENT" ───────────────────────────────
 * The request says "an active / quoted project". They are split here, because a
 * quotation is not a customer relationship — calling somebody a project client on the
 * strength of a document they have not accepted is the same overstatement as counting
 * a quote as revenue. A quoted-only customer reads "Project quoted", which is true and
 * is also the more useful thing to see: it is a deal to chase.
 *
 * ─── MONEY STAYS OUT OF MRR ─────────────────────────────────────────────────
 * This decides a LABEL. A project's contract value must never be folded into Monthly
 * or Yearly revenue — those are recurring figures and a one-off build is not recurring.
 * It gets its own number on the strip.
 */

/** The statuses that mean a project is real work, not a document. */
const WON = new Set(["active", "completed"]);
/** Proposed but not accepted. Worth showing, not worth claiming. */
const PROPOSED = new Set(["quoted", "draft"]);

export interface ProjectLike {
  status?: string | null;
  total_amount?: number | null;
}

export interface CustomerProjectFacts {
  /** Projects belonging to this customer, any status. */
  projects: readonly ProjectLike[];
  /** Whether the customer has at least one ACTIVE subscription. */
  hasActiveSub: boolean;
  /** `is_active === false` on the customer. */
  archived: boolean;
}

export interface PortfolioStatus {
  label: string;
  kind: "success" | "info" | "muted";
  dot: boolean;
}

/** Projects that count as won work. */
export function wonProjects(projects: readonly ProjectLike[]): ProjectLike[] {
  return projects.filter((p) => WON.has((p.status ?? "").toLowerCase()));
}

/** Projects proposed and not yet accepted. */
export function proposedProjects(projects: readonly ProjectLike[]): ProjectLike[] {
  return projects.filter((p) => PROPOSED.has((p.status ?? "").toLowerCase()));
}

/**
 * Contract value of a customer's WON projects, in rupees.
 *
 * Cancelled projects are excluded, and so are quotations — a quotation in a portfolio
 * total is a number the owner would plan against and that nobody has agreed to.
 */
export function projectValue(projects: readonly ProjectLike[]): number {
  return wonProjects(projects).reduce((sum, p) => sum + Math.max(0, p.total_amount ?? 0), 0);
}

/**
 * The pill on the customer row.
 *
 * Order matters: archived beats everything (it is a statement about the record, not the
 * business), then a subscription, then won project work, then a live proposal.
 */
export function customerPortfolioStatus(facts: CustomerProjectFacts): PortfolioStatus {
  if (facts.archived) return { label: "Inactive", kind: "muted", dot: false };
  if (facts.hasActiveSub) return { label: "Active", kind: "success", dot: true };
  if (wonProjects(facts.projects).length > 0) return { label: "Project client", kind: "info", dot: true };
  if (proposedProjects(facts.projects).length > 0) return { label: "Project quoted", kind: "info", dot: false };
  return { label: "No subscription", kind: "muted", dot: false };
}

/**
 * Does "No subscription" apply? It must not, for a customer doing project work —
 * that filter is read as "dead accounts", and R-005 is precisely about a live customer
 * appearing in it.
 *
 * A customer with only a QUOTATION and no subscription genuinely has no business yet,
 * so they stay in the filter. That is the honest reading and it keeps the filter useful.
 */
export function countsAsNoBusiness(facts: Omit<CustomerProjectFacts, "archived">): boolean {
  return !facts.hasActiveSub && wonProjects(facts.projects).length === 0;
}
