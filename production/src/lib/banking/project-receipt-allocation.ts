/**
 * R-1998 — one bank receipt shared across a project's open instalments (R-1910 audit, "ONE path").
 *
 * Pure rules behind the instalment list in the reconcile dialog (project-payment-section.tsx):
 *   fifoAllocate          — tick the oldest instalments first up to what the receipt settles
 *                           (bank + TDS); the last one ticked may be part-paid; any extra is
 *                           LEFT OVER, never put on an instalment (extra money as the customer's
 *                           advance is R-1997, decision D1).
 *   receiptCheck          — bank + TDS against the instalments ticked: match / short / over.
 *   pickProjectForReceipt — the project to open on, so the owner does not have to pick one.
 *   projectReceiptPayload — what Save sends to allocate_project_receipt(_with_tds) (R-1995/R-1996).
 */

export interface KistLite { id: string; seq: number; remaining: number }

export interface FifoResult {
  lines: { id: string; amount: number }[];
  /** What is left after every open instalment is paid in full. */
  leftover: number;
}

export function fifoAllocate(settled: number, kists: readonly KistLite[]): FifoResult {
  let left = Math.max(0, Math.round(settled));
  const lines: FifoResult["lines"] = [];
  for (const k of [...kists].sort((a, b) => a.seq - b.seq)) {
    if (left <= 0) break;
    const amount = Math.min(left, Math.max(0, Math.round(k.remaining)));
    if (amount <= 0) continue;
    lines.push({ id: k.id, amount });
    left -= amount;
  }
  return { lines, leftover: left };
}

export interface ReceiptCheck {
  state: "match" | "short" | "over";
  /** Bank + TDS — what the receipt settles. */
  settled: number;
  /** How far the ticked total is from it (always ≥ 0). */
  diff: number;
}

export function receiptCheck(bank: number, tds: number, ticked: number): ReceiptCheck {
  const settled = Math.round(bank) + Math.round(tds);
  const t = Math.round(ticked);
  return { state: t === settled ? "match" : t < settled ? "short" : "over", settled, diff: Math.abs(settled - t) };
}

/**
 * The guessed customer's ONE project with open instalments; else the ONE project whose oldest
 * open instalments add up to the receipt exactly. Anything else → null (the owner picks).
 */
export function pickProjectForReceipt(
  projects: readonly { id: string; customerId: string | null; milestones: readonly KistLite[] }[],
  guessedCustomerId: string | null,
  settled: number,
): string | null {
  const open = projects.filter((p) => p.milestones.length > 0);
  if (guessedCustomerId) {
    const mine = open.filter((p) => p.customerId === guessedCustomerId);
    if (mine.length === 1) return mine[0].id;
  }
  const fits = open.filter((p) => {
    let sum = 0;
    for (const m of [...p.milestones].sort((a, b) => a.seq - b.seq)) {
      sum += m.remaining;
      if (sum === settled) return true;
      if (sum > settled) return false;
    }
    return false;
  });
  return fits.length === 1 ? fits[0].id : null;
}

export interface KistRow { id: string; seq: number; on: boolean; amount: number; raiseInvoice: boolean }

export interface ProjectReceiptTds { section: string; ratePct: number; amount: number }

export function projectReceiptPayload(input: {
  bankTxnId: string;
  projectId: string;
  rows: readonly KistRow[];
  tds: ProjectReceiptTds | null;
  receivedAt: string | null;
  reference: string | null;
}) {
  return {
    bankTxnId: input.bankTxnId,
    projectId: input.projectId,
    allocations: [...input.rows]
      .filter((r) => r.on && r.amount > 0)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ milestoneId: r.id, amount: Math.round(r.amount), raiseInvoice: r.raiseInvoice })),
    tds: input.tds && input.tds.amount > 0 ? input.tds : null,
    receivedAt: input.receivedAt,
    reference: input.reference,
  };
}

/**
 * The RPC's `hint` (an app path, e.g. '/accounting/banking' or '/projects/<id>') as the
 * "what to do next" link under the error (§24). Anything that is not an in-app path → no link.
 */
export function hintLink(hint: string | null | undefined): { href: string; label: string } | null {
  const h = (hint ?? "").trim();
  if (!h.startsWith("/") || h.startsWith("//")) return null;
  if (h.startsWith("/accounting/banking")) return { href: h, label: "Open Banking" };
  if (/^\/projects\/[^/]+/.test(h)) return { href: h, label: "Open the project" };
  if (h === "/projects") return { href: h, label: "Open Projects" };
  return { href: h, label: "Open" };
}
