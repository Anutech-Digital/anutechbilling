/**
 * Is this tenant allowed to issue a tax invoice yet?
 *
 * ─── THE BUG THIS REPLACES ──────────────────────────────────────────────────
 * The invoice dialog used to do this:
 *
 *     const meTenant = me || {
 *       tenantName: "Demo Co Pvt Ltd",
 *       tenantGstin: "27AABCE9876D1Z3",
 *       tenantStateCode: "27", …
 *     };
 *
 * A fallback that looks harmless and is not. Three separate problems, worst last:
 *
 *   1. Wrong company. Demo Co is HISTORICAL (CLAUDE.md §1) — the entity
 *      is ANUTECH DIGITAL PVT LTD. A customer receiving that invoice sees a supplier
 *      they have no relationship with.
 *
 *   2. A FABRICATED GSTIN. `27AABCE9876D1Z3` belongs to nobody. On a document headed
 *      "Tax Invoice" that is not a placeholder, it is a false declaration — and the
 *      customer will try to claim input credit against it and fail.
 *
 *   3. THE TAX SPLIT FLIPS. This is the expensive one. `tenantStateCode` decides
 *      inter-state vs intra-state (isInterStateSupply, lib/gst/place-of-supply.ts).
 *      ANUTECH is Delhi, **07**. The fallback claims Maharashtra, **27**. So for a
 *      Delhi customer — an intra-state sale that must carry CGST 9% + SGST 9% — the
 *      fallback makes 07 ≠ 27 and the invoice charges **IGST 18%** instead.
 *
 *      Same total rupees, wrong tax heads, and the wrong government gets paid. The
 *      customer's GSTR-2B will not reconcile, and correcting it means a credit note
 *      plus a fresh invoice, not an edit.
 *
 * And it only appears while `useCurrentUser` is in flight — a deep link into an
 * invoice on a slow connection — so it is invisible in testing and reproducible in
 * front of a customer.
 *
 * ─── THE RULE: NEVER INVENT A TAX IDENTITY ──────────────────────────────────
 * An unknown identity is reported, never substituted. There is no safe default for
 * "who is selling this" — every possible guess is a false statement on a legal
 * document. `null` and a named list of what is missing is the honest answer, and it
 * is the only one that leads the operator to the fix.
 *
 * Fields are the ones CGST Rule 46 requires of the supplier: name, address, GSTIN,
 * and the state + code that determine place of supply.
 */
import type { CurrentUserInfo } from "@/lib/hooks/useCurrentUser";

export interface SupplierIdentity {
  name:      string;
  gstin:     string;
  address:   string;
  state:     string;
  stateCode: string;
  email:     string | null;
  phone:     string | null;
}

/** A missing field, in the operator's words plus where to fix it. */
export interface MissingField {
  field: keyof SupplierIdentity;
  label: string;
  why:   string;
}

export type SupplierIdentityResult =
  | { ok: true;  supplier: SupplierIdentity }
  | { ok: false; missing: MissingField[]; hasSession: boolean };

/* Ordered so the operator reads the most consequential gap first — the two that
   change what the tax on the document IS, before the two that change how it reads. */
const REQUIRED: MissingField[] = [
  { field: "gstin", label: "GSTIN",
    why: "A tax invoice without the supplier's GSTIN is not a tax invoice — your customer cannot claim input credit from it." },
  { field: "stateCode", label: "State code",
    why: "This decides IGST versus CGST+SGST. Guess it and the right amount goes to the wrong government." },
  { field: "name", label: "Registered business name",
    why: "It must be the name on the GST registration, not a trading name." },
  { field: "address", label: "Registered address",
    why: "CGST Rule 46 requires the supplier's address on every tax invoice." },
  { field: "state", label: "State",
    why: "Printed beside the state code, and the two must agree." },
];

/** Blank, whitespace and the string "null" all mean absent. */
function present(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.trim().toLowerCase() !== "null";
}

/**
 * Resolve the supplier from the signed-in user's tenant, or say precisely what is
 * missing.
 *
 * `hasSession: false` distinguishes "still loading / nobody signed in" from "signed
 * in but the tenant's tax details were never filled". Those need different words:
 * one is wait, the other is go to Settings.
 */
export function supplierIdentity(
  me: CurrentUserInfo | null | undefined,
): SupplierIdentityResult {
  if (!me) return { ok: false, missing: REQUIRED, hasSession: false };

  const candidate = {
    name:      me.tenantName,
    gstin:     me.tenantGstin,
    address:   me.tenantAddress,
    state:     me.tenantState,
    stateCode: me.tenantStateCode,
  };

  const missing = REQUIRED.filter((r) => {
    const v = candidate[r.field as keyof typeof candidate];
    return !present(v);
  });
  if (missing.length > 0) return { ok: false, missing, hasSession: true };

  return {
    ok: true,
    supplier: {
      name:      candidate.name.trim(),
      gstin:     candidate.gstin!.trim().toUpperCase(),
      address:   candidate.address!.trim(),
      state:     candidate.state!.trim(),
      stateCode: candidate.stateCode!.trim(),
      email:     present(me.tenantEmail) ? me.tenantEmail.trim() : null,
      phone:     present(me.tenantPhone) ? me.tenantPhone.trim() : null,
    },
  };
}

/**
 * One line for the operator. §24: what happened, why, what to do — the caller adds
 * the button to /settings.
 */
export function supplierIdentityMessage(r: SupplierIdentityResult): string | null {
  if (r.ok) return null;
  if (!r.hasSession) {
    return "Loading your business details — an invoice cannot be prepared until they arrive.";
  }
  const names = r.missing.map((m) => m.label).join(", ");
  return `Your business is missing ${names}. A tax invoice cannot be issued without ${
    r.missing.length === 1 ? "it" : "them"
  } — add ${r.missing.length === 1 ? "it" : "them"} in Settings first.`;
}
