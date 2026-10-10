/**
 * GSTR-3B worksheet — the boxes, from the period's books.
 *
 * 3B is typed on the portal, one figure per box. This turns the period's rows into those
 * boxes so the owner copies numbers instead of computing them:
 *
 *   3.1(a)  outward taxable supplies (invoices net of credit/debit notes, plus tax on
 *           advances received less advances adjusted — GSTR-1 11A/11B), by head
 *   3.1(b)  zero-rated supplies — exports (GSTR-1 Table 6A / EXP): taxable value and the
 *           IGST on exports WITH payment (zero under LUT)
 *   3.2     of 3.1(a), inter-state supplies to UNREGISTERED persons, by place of supply
 *           (taxable value + IGST) — the portal auto-fills this from GSTR-1 B2CL/B2CS and
 *           it must match
 *   3.1(d)  inward supplies liable to reverse charge — imported services (Google Ireland,
 *           Meta, AWS): taxable value and the IGST the buyer pays HIMSELF, in cash
 *   4(A)(3) ITC on that reverse-charge tax (the same amount comes back as credit)
 *   4(A)(5) all other ITC — everything on a proper tax invoice from a GSTIN vendor,
 *           INCLUDING the s.17(5) blocked part (Circular 170/2022: report gross, then reverse)
 *   4(B)(1) ITC reversed — the s.17(5) part (staff welfare, business promotion…)
 *   6.1     tax paid through ITC — the s.49 / Rule 88A set-off (`setOffItc`, R-258)
 *   net     tax payable in cash per head AFTER that set-off: RCM tax always in cash, plus
 *           whatever output tax the credit does not cover; unused credit carried forward
 *
 * Expenses on a kaccha bill or from a vendor with no GSTIN never reach the table: they
 * are not in GSTR-2B and cannot be claimed; `notIn2b` says how much that is.
 */

export interface Heads { igst: number; cgst: number; sgst: number }
const Z: Heads = { igst: 0, cgst: 0, sgst: 0 };
const add = (a: Heads, b: Heads): Heads => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst });

export interface Gstr3bOutput {
  taxableValue: number;
  heads: Heads;
  /** Export (zero-rated) → 3.1(b), not 3.1(a). */
  zeroRated?: boolean;
  /** Inter-state supply to an unregistered person: its place of supply ("27-Maharashtra") → 3.2. */
  unregInterPos?: string | null;
  /** R-521: a tax-on-advance row — "11A" received this period with no invoice yet (positive),
   *  "11B" received earlier and adjusted on this period's invoice (negative). Counted in
   *  3.1(a) like any output, and also totalled on its own so the page can NAME it. */
  advance?: "11A" | "11B";
}

export interface Gstr3bInput {
  /** Invoices + signed notes, and signed advance rows (11A positive, 11B negative). */
  output: Gstr3bOutput[];
  /** claimable ITC rows (bills + eligible expenses), by head */
  itc: Heads[];
  /** s.17(5) blocked ITC rows, by head — reported in 4(A)(5) and reversed in 4(B)(1) */
  blocked17: Heads[];
  /** GST on kaccha / no-GSTIN bills — never in the return */
  notIn2b: number;
  /** reverse-charge imports: ₹ value and self-assessed IGST */
  rcm: { amount: number; tax: number }[];
}

export interface Gstr3b {
  outTaxable: number; out: Heads;                // 3.1(a)
  zeroTaxable: number; zeroIgst: number;         // 3.1(b)
  /** 3.2 — inter-state supplies to unregistered persons, per place of supply, sorted by POS. */
  unregInter: { pos: string; taxable: number; igst: number }[];
  rcmTaxable: number; rcmTax: number;            // 3.1(d) — IGST
  itcRcm: number;                                // 4(A)(3)
  itcAll: Heads;                                 // 4(A)(5) gross (claimable + 17(5))
  rev17: Heads;                                  // 4(B)(1)
  itcNet: Heads;                                 // 4(C) = 4(A) − 4(B), by head (incl. RCM credit in IGST)
  pay: Heads;                                    // cash, per head (after set-off, incl. RCM)
  /** R-258: how the credit was set off — per head credit used, cash, carried forward. */
  setOff: SetOff;
  notIn2b: number;
  /** R-521: of 3.1(a), tax on advances received with no invoice yet (GSTR-1 Table 11A). */
  adv11a: { taxable: number; heads: Heads };
  /** R-521: of 3.1(a), advances adjusted on this period's invoices (GSTR-1 Table 11B) — positive, deducted. */
  adv11b: { taxable: number; heads: Heads };
}

export function computeGstr3b(i: Gstr3bInput): Gstr3b {
  const domestic = i.output.filter((r) => !r.zeroRated);
  const zero = i.output.filter((r) => r.zeroRated);
  const outTaxable = domestic.reduce((s, r) => s + r.taxableValue, 0);
  const out = domestic.reduce((h, r) => add(h, r.heads), Z);
  const zeroTaxable = zero.reduce((s, r) => s + r.taxableValue, 0);
  const zeroIgst = zero.reduce((s, r) => s + r.heads.igst, 0);
  const byPos = new Map<string, { pos: string; taxable: number; igst: number }>();
  for (const r of domestic) {
    if (!r.unregInterPos) continue;
    const cur = byPos.get(r.unregInterPos) ?? { pos: r.unregInterPos, taxable: 0, igst: 0 };
    cur.taxable += r.taxableValue;
    cur.igst += r.heads.igst;
    byPos.set(r.unregInterPos, cur);
  }
  const unregInter = [...byPos.values()].filter((p) => p.taxable !== 0 || p.igst !== 0).sort((a, b) => a.pos.localeCompare(b.pos));
  /* Exports with payment: their IGST is output tax too — paid like any other. */
  const outAll = add(out, { igst: zeroIgst, cgst: 0, sgst: 0 });
  const rcmTaxable = i.rcm.reduce((s, r) => s + Math.max(0, r.amount), 0);
  const rcmTax = i.rcm.reduce((s, r) => s + Math.max(0, r.tax), 0);
  const itcClaim = i.itc.reduce((h, r) => add(h, r), Z);
  const rev17 = i.blocked17.reduce((h, r) => add(h, r), Z);
  const itcAll = add(itcClaim, rev17);
  const itcNet = { igst: itcClaim.igst + rcmTax, cgst: itcClaim.cgst, sgst: itcClaim.sgst };
  /* R-258: credit is set off across heads in the statutory order (s.49(5) / Rule 88A).
     RCM tax is never set off — it is paid in cash, then comes back as credit (in itcNet). */
  const setOff = setOffItc(outAll, itcNet);
  const pay = { igst: rcmTax + setOff.cash.igst, cgst: setOff.cash.cgst, sgst: setOff.cash.sgst };
  const advOf = (kind: "11A" | "11B", sign: 1 | -1) => {
    const rows = domestic.filter((r) => r.advance === kind);
    const h = rows.reduce((acc, r) => add(acc, r.heads), Z);
    return { taxable: sign * rows.reduce((s, r) => s + r.taxableValue, 0), heads: { igst: sign * h.igst, cgst: sign * h.cgst, sgst: sign * h.sgst } };
  };
  return {
    outTaxable, out, zeroTaxable, zeroIgst, unregInter, rcmTaxable, rcmTax, itcRcm: rcmTax, itcAll, rev17, itcNet, pay, setOff,
    notIn2b: Math.max(0, i.notIn2b), adv11a: advOf("11A", 1), adv11b: advOf("11B", -1),
  };
}

/** Rows for the worksheet CSV / table: [box, description, taxable, igst, cgst, sgst]. */
export function gstr3bRows(g: Gstr3b): (string | number)[][] {
  const rows: (string | number)[][] = [
    ["3.1(a)", "Outward taxable supplies (other than zero/nil/exempt)", g.outTaxable, g.out.igst, g.out.cgst, g.out.sgst],
  ];
  /* R-521: name the advance part of 3.1(a), so 3.1(a) = invoices/notes + these lines on the page. */
  const a = g.adv11a, b = g.adv11b;
  const any = (x: { taxable: number; heads: Heads }) => x.taxable !== 0 || x.heads.igst !== 0 || x.heads.cgst !== 0 || x.heads.sgst !== 0;
  if (any(a)) rows.push(["—", "of 3.1(a): tax on advances received, not yet invoiced (GSTR-1 Table 11A)", a.taxable, a.heads.igst, a.heads.cgst, a.heads.sgst]);
  if (any(b)) rows.push(["—", "of 3.1(a): less advances adjusted on this period's invoices (GSTR-1 Table 11B)", -b.taxable, -b.heads.igst, -b.heads.cgst, -b.heads.sgst]);
  if (g.zeroTaxable !== 0 || g.zeroIgst !== 0) rows.push(["3.1(b)", "Outward zero-rated supplies (exports)", g.zeroTaxable, g.zeroIgst, 0, 0]);
  if (g.rcmTaxable > 0) rows.push(["3.1(d)", "Inward supplies liable to reverse charge (imported services)", g.rcmTaxable, g.rcmTax, 0, 0]);
  for (const p of g.unregInter) rows.push(["3.2", `Inter-state supplies to unregistered persons — POS ${p.pos}`, p.taxable, p.igst, "", ""]);
  if (g.itcRcm > 0) rows.push(["4(A)(3)", "ITC — inward supplies liable to reverse charge", "", g.itcRcm, 0, 0]);
  rows.push(["4(A)(5)", "ITC — all other ITC (gross, incl. s.17(5) part)", "", g.itcAll.igst, g.itcAll.cgst, g.itcAll.sgst]);
  if (g.rev17.igst + g.rev17.cgst + g.rev17.sgst > 0) rows.push(["4(B)(1)", "ITC reversed — s.17(5) (staff welfare, business promotion…)", "", g.rev17.igst, g.rev17.cgst, g.rev17.sgst]);
  rows.push(["4(C)", "Net ITC available", "", g.itcNet.igst, g.itcNet.cgst, g.itcNet.sgst]);
  const u = g.setOff.used;
  if (u.igst.igst + u.igst.cgst + u.igst.sgst > 0) rows.push(["6.1", "Paid through ITC — IGST credit (IGST first, then CGST / SGST)", "", u.igst.igst, u.igst.cgst, u.igst.sgst]);
  if (u.cgst.igst + u.cgst.cgst > 0) rows.push(["6.1", "Paid through ITC — CGST credit (CGST, then IGST; never SGST)", "", u.cgst.igst, u.cgst.cgst, ""]);
  if (u.sgst.igst + u.sgst.sgst > 0) rows.push(["6.1", "Paid through ITC — SGST credit (SGST, then IGST; never CGST)", "", u.sgst.igst, "", u.sgst.sgst]);
  rows.push(["Net", "Tax payable in cash (after ITC set-off; RCM always cash)", "", g.pay.igst, g.pay.cgst, g.pay.sgst]);
  const cf = g.setOff.carryForward;
  if (cf.igst + cf.cgst + cf.sgst > 0) rows.push(["C/F", "Unused credit carried forward to next month", "", cf.igst, cf.cgst, cf.sgst]);
  if (g.notIn2b > 0) rows.push(["—", "GST on kaccha / no-GSTIN bills — not in the return, stays a cost", "", g.notIn2b, "", ""]);
  return rows;
}

/* ── R-258: ITC set-off — s.49(5), s.49A and Rule 88A (CGST Act / Rules) ──────────────
 *
 * The page used to net output and credit PER HEAD (floored at 0), so ₹10,000 of IGST
 * credit sat unused next to ₹6,000 CGST + ₹6,000 SGST output and the worksheet said
 * ₹12,000 cash. The law lets that IGST credit pay CGST and SGST — the real cash is ₹2,000.
 *
 * Order (whole rupees; a liability or credit below 0 counts as 0):
 *   1. IGST credit → IGST liability first; what is left → CGST and SGST (Rule 88A: in any
 *      order and proportion). s.49A: IGST credit is used up before any CGST/SGST credit.
 *      The remainder goes first to the CGST / SGST their own credit CANNOT cover (so cash
 *      is never paid while credit is carried forward), then to the rest, CGST before SGST.
 *   2. CGST credit → CGST, then IGST.
 *   3. SGST credit → SGST, then IGST.
 *   CGST credit NEVER pays SGST and SGST credit NEVER pays CGST (s.49(5)(e)/(f)).
 *   Unused credit stays in its own head and is carried forward; cash is never negative.
 */
export interface SetOff {
  liability: Heads;
  credit: Heads;
  /** used[creditHead][liabilityHead] — rupees of `creditHead` credit applied to `liabilityHead`. */
  used: { igst: Heads; cgst: Heads; sgst: Heads };
  /** Liability paid through credit, per liability head. */
  paidByCredit: Heads;
  /** Cash payable per head (≥ 0). */
  cash: Heads;
  /** Credit left in each head after set-off — carried to the next month. */
  carryForward: Heads;
}

const rupees = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const wholeHeads = (h: Heads): Heads => ({ igst: rupees(h.igst), cgst: rupees(h.cgst), sgst: rupees(h.sgst) });

export function setOffItc(liabilityIn: Heads, creditIn: Heads): SetOff {
  const liability = wholeHeads(liabilityIn);
  const credit = wholeHeads(creditIn);
  const due = { ...liability };
  const left = { ...credit };
  const used = { igst: { ...Z }, cgst: { ...Z }, sgst: { ...Z } };
  const apply = (from: keyof Heads, to: keyof Heads, cap = Number.POSITIVE_INFINITY) => {
    const x = Math.min(left[from], due[to], cap);
    if (x <= 0) return;
    left[from] -= x; due[to] -= x; used[from][to] += x;
  };

  /* 1. IGST credit: IGST first, then the CGST/SGST own credit cannot cover, then the rest. */
  apply("igst", "igst");
  apply("igst", "cgst", Math.max(0, due.cgst - left.cgst));
  apply("igst", "sgst", Math.max(0, due.sgst - left.sgst));
  apply("igst", "cgst");
  apply("igst", "sgst");
  /* 2./3. Own head first, then IGST. There is deliberately no cgst→sgst or sgst→cgst. */
  apply("cgst", "cgst");
  apply("sgst", "sgst");
  apply("cgst", "igst");
  apply("sgst", "igst");

  const paidByCredit = {
    igst: used.igst.igst + used.cgst.igst + used.sgst.igst,
    cgst: used.igst.cgst + used.cgst.cgst,
    sgst: used.igst.sgst + used.sgst.sgst,
  };
  return { liability, credit, used, paidByCredit, cash: due, carryForward: left };
}

/**
 * R-258: heads for an expense whose bill gave no IGST/CGST split. The old guess was always
 * intra-state (CGST+SGST). A vendor GSTIN from ANOTHER state than ours means the vendor
 * charged IGST, so the guessed tax goes to IGST. A measured split is never touched, and an
 * unknown state on either side keeps the intra-state guess.
 */
export function expenseHeadsByState(
  h: Heads & { measured: boolean },
  vendorStateCode: string | null,
  ownStateCode: string | null,
): Heads {
  if (h.measured || !vendorStateCode || !ownStateCode || vendorStateCode === ownStateCode) return { igst: h.igst, cgst: h.cgst, sgst: h.sgst };
  return { igst: h.igst + h.cgst + h.sgst, cgst: 0, sgst: 0 };
}
