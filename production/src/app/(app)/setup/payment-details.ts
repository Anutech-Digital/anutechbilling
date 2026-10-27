/**
 * R-260 — optional "How customers pay you" block on setup step 1.
 *
 * Uses the tenant columns Settings → Company already edits (upi_vpa, remit_*), so no
 * migration. Same rules as the Settings form: the UPI ID must pass the SAME check the
 * invoice QR uses, and IFSC has a fixed shape. Everything is optional.
 */
import { isValidVpa } from "@/lib/payments/upi";
import { ifscProblem } from "@/lib/banking/bank-details";

export interface PaymentDetails {
  upiVpa: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  ifsc: string;
}

/** First problem to show, or null when the block can be saved (blank is fine). */
export function paymentDetailsProblem(p: PaymentDetails): string | null {
  const vpa = p.upiVpa.trim();
  if (vpa && !isValidVpa(vpa)) return "Enter a valid UPI ID, e.g. yourname@okhdfcbank";
  const ifsc = p.ifsc.trim();
  /* R-1905: the same IFSC message as the vendor form (says the length and the rule). */
  const ifscBad = ifscProblem(ifsc);
  if (ifscBad) return ifscBad;
  if (p.accountNumber.trim() && !ifsc) return "Add the IFSC for this bank account";
  return null;
}

/** Tenant patch — blank boxes save as null, like Settings → Company. */
export function paymentDetailsPatch(p: PaymentDetails) {
  return {
    upi_vpa:              p.upiVpa.trim()        || null,
    remit_bank_name:      p.bankName.trim()      || null,
    remit_account_name:   p.accountName.trim()   || null,
    remit_account_number: p.accountNumber.trim() || null,
    remit_ifsc:           p.ifsc.trim().toUpperCase() || null,
  };
}
