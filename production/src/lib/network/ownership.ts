/**
 * R-2445 (G-NETWORK) — "Prove you own this GSTIN": what Settings → Network shows the company
 * about its own GSTIN, and the one next step. Pure, so the screen and its test agree.
 *
 * Registered (gstin_verified_at, the GSTN lookup) is not owned: anyone can save another firm's
 * public GSTIN. A company connects only after the ResellerOS platform admin confirmed it owns
 * the GSTIN (gstin_owner_verified_at). Spec: docs/specs/g-network.md → "GSTIN ownership".
 */

export interface GstinOwnership {
  gstin: string | null;
  gstinVerified: boolean;
  ownerVerified: boolean;
  ownerVerifiedAt: string | null;
  ownerVerifiedHow: "platform_admin" | "parent_link" | null;
  claimId: string | null;
  claimStatus: "pending" | "approved" | "rejected" | "withdrawn" | "revoked" | null;
  claimRequestedAt: string | null;
  claimNote: string | null;
  claimDecidedAt: string | null;
  claimDecisionNote: string | null;
  heldByOther: boolean;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null || v === "" ? null : String(v));

export function toOwnership(r: Row | null | undefined): GstinOwnership {
  const x = r ?? {};
  const how = x.owner_verified_how;
  const cs = x.claim_status;
  return {
    gstin: str(x.gstin),
    gstinVerified: Boolean(x.gstin_verified),
    ownerVerified: Boolean(x.owner_verified),
    ownerVerifiedAt: str(x.owner_verified_at),
    ownerVerifiedHow: how === "platform_admin" || how === "parent_link" ? how : null,
    claimId: str(x.claim_id),
    claimStatus: cs === "pending" || cs === "approved" || cs === "rejected" || cs === "withdrawn" || cs === "revoked" ? cs : null,
    claimRequestedAt: str(x.claim_requested_at),
    claimNote: str(x.claim_note),
    claimDecidedAt: str(x.claim_decided_at),
    claimDecisionNote: str(x.claim_decision_note),
    heldByOther: Boolean(x.held_by_other),
  };
}

/** Which box Settings → Network shows — exactly one, in this order. */
export type OwnershipStep =
  | "no_gstin"        // no GSTIN, or not verified with GSTN yet → Settings → Company
  | "owned"           // proved — can connect
  | "held_by_other"   // another business proved this GSTIN → support, with REG-06
  | "pending"         // asked; the ResellerOS team checks
  | "ask"             // never asked (or withdrawn) → "Prove you own this GSTIN"
  | "ask_again";      // rejected / revoked → the reason + ask again

export function ownershipStep(o: GstinOwnership): OwnershipStep {
  if (!o.gstin || !o.gstinVerified) return "no_gstin";
  if (o.ownerVerified) return "owned";
  if (o.heldByOther) return "held_by_other";
  if (o.claimStatus === "pending") return "pending";
  if (o.claimStatus === "rejected" || o.claimStatus === "revoked") return "ask_again";
  return "ask";
}

/** Can this company send / accept a connection now? (The server checks it again.) */
export const mayConnect = (o: GstinOwnership | undefined) => Boolean(o && ownershipStep(o) === "owned");
