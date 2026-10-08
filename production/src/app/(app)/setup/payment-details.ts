/**
 * R-260 — optional "How customers pay you" block on setup step 1.
 *
 * Uses the tenant columns Settings → Company already edits (upi_vpa, remit_*), so no
 * migration. Same rules as the Settings form: the UPI ID must pass the SAME check the
 * invoice QR uses, and IFSC has a fixed shape. Everything is optional.
 */
import { isValidVpa } from "@/lib/payments/upi";

export interface PaymentDetails {
  upiVpa: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  ifsc: string;
}

const IFSC_RE = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;

/** First problem to show, or null when the block can be saved (blank is fine). */
export function paymentDetailsProblem(p: PaymentDetails): string | null {
  const vpa = p.upiVpa.trim();
  if (vpa && !isValidVpa(vpa)) return "Enter a valid UPI ID, e.g. yourname@okhdfcbank";
  const ifsc = p.ifsc.trim();
  if (ifsc && !IFSC_RE.test(ifsc)) return "IFSC is 11 characters, e.g. HDFC0001234";
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
