/**
 * R-2534 — real-shaped bank narrations and the reference key each must give. ONE table for both
 * twins: narration-ref.test.ts runs it through parseNarrationRef, and the SQL test
 * supabase/tests/r2534_bank_ref_key.test.sql carries the same rows for public.normalize_bank_ref
 * (narration-ref.test.ts checks every row below is in that file, so the twins cannot drift).
 * `ref` = the column bank_transactions.reference (the statement's "Chq./Ref.No."), or null.
 * `key` = what bank_transactions.ref_key must hold (null = no reference to trust).
 */
export interface NarrationRefCase {
  bank: string;
  narration: string;
  ref: string | null;
  key: string | null;
  kind: "utr" | "rrn" | "cheque" | null;
}

export const NARRATION_REF_CASES: NarrationRefCase[] = [
  // HDFC — NEFT CR-<IFSC>-<remitter>-<us>-<UTR>
  { bank: "HDFC", narration: "NEFT CR-DBSS0IN0811-SURESH KUMAR AND COMPANY (IMPEX) PR-EXCEL TECHNOLOGIES-0811OP6167031041", ref: "0811OP6167031041", key: "811OP6167031041", kind: "utr" },
  { bank: "HDFC", narration: "NEFT CR-YESB0000001-RAZORPAY SOFTWARE PRIVATE LIMITED-EXCEL TECHNOLOGIES-YESBN12026110612345", ref: null, key: "YESBN12026110612345", kind: "utr" },
  { bank: "HDFC", narration: "NEFT CR-SBIN0001234-GIBI PAUL-EXCEL TECHNOLOGIES-SBIN426310123456", ref: "0000SBIN426310123456", key: "SBIN426310123456", kind: "utr" },
  // HDFC — NEFT DR-<IFSC>-<payee>-NETBANK, MUM-<UTR>-<remark>
  { bank: "HDFC", narration: "NEFT DR-BKID0006087-PRATIK-NETBANK, MUM-N310261234567890-INVOICE 12345678", ref: null, key: "N310261234567890", kind: "utr" },
  // HDFC — RTGS (22-character UTR)
  { bank: "HDFC", narration: "RTGS CR-SBIN0000001-ACME INFRA LTD-EXCEL TECHNOLOGIES-SBINR52026110600012345", ref: null, key: "SBINR52026110600012345", kind: "utr" },
  { bank: "HDFC", narration: "RTGS DR-ICIC0000104-REDINGTON LIMITED-NETBANK, MUM-HDFCR52026110612345678-PO 7781", ref: null, key: "HDFCR52026110612345678", kind: "utr" },
  // HDFC — IMPS-<RRN>-<name>-<bank>-<account>-<remark> (a 14-digit account is not the RRN)
  { bank: "HDFC", narration: "IMPS-621856395591-RAVI KUMAR-ICIC-XX XXXXXX4658-SALARY", ref: "0000621856395591", key: "621856395591", kind: "rrn" },
  { bank: "HDFC", narration: "IMPS-529912345679-SA-HDFC-50100784857169-INV", ref: null, key: "529912345679", kind: "rrn" },
  // HDFC — UPI-<name>-<vpa>-<IFSC>-<RRN>-<remark>; a 12-digit phone VPA is not the RRN
  { bank: "HDFC", narration: "UPI-MOHIT SHARMA-919876543210@PAYTM-PYTM0123456-621812345678-PAYMENT FROM PHONE", ref: "0000621812345678", key: "621812345678", kind: "rrn" },
  { bank: "HDFC", narration: "UPI-GOOGLE INDIA DIGITAL-GOOGLEPAY@AXISBANK-UTIB0000553-530112345601-UPI", ref: null, key: "530112345601", kind: "rrn" },
  // HDFC — cheque: the number sits in the Chq./Ref.No. column
  { bank: "HDFC", narration: "CHQ DEP - MICR CTS - NAGPUR - SHARMA TRADERS", ref: "000000123456", key: "123456", kind: "cheque" },
  { bank: "HDFC", narration: "CHQ PAID-MICR CTS-MU-VERMA CONTRACTORS", ref: "0000000000004521", key: "4521", kind: "cheque" },
  // ICICI
  { bank: "ICICI", narration: "UPI/621856395591/Payment from Ph/ravi@okicici/ICICI Bank", ref: null, key: "621856395591", kind: "rrn" },
  { bank: "ICICI", narration: "MMT/IMPS/530412345678/INV 221/MEHTA TRADERS/HDFC Bank", ref: null, key: "530412345678", kind: "rrn" },
  { bank: "ICICI", narration: "NEFT-HDFCN52026110612345-KAPOOR LEGAL-INV 88-50200012345678-HDFC0000240", ref: null, key: "HDFCN52026110612345", kind: "utr" },
  { bank: "ICICI", narration: "RTGS-UTIBR52026110600054321-ACME INFRA LTD-PO 12-917020012345678-UTIB0000004", ref: null, key: "UTIBR52026110600054321", kind: "utr" },
  { bank: "ICICI", narration: "CLG/SHARMA TRADERS/CHQ NO 004587/HDFC", ref: null, key: "4587", kind: "cheque" },
  // Axis
  { bank: "Axis", narration: "UPI/P2A/530912345678/ASHA DIRECTOR/HDFC BANK/rent", ref: null, key: "530912345678", kind: "rrn" },
  { bank: "Axis", narration: "NEFT/AXISP00123456789/GUPTA PRINT HOUSE/ICICI BANK/INV 44", ref: null, key: "AXISP00123456789", kind: "utr" },
  { bank: "Axis", narration: "IMPS/P2A/531012345678/VERMA CONTRACTORS/9876543210/advance", ref: null, key: "531012345678", kind: "rrn" },
  { bank: "Axis", narration: "INB/NEFT/AXOIC12345678901/SHARMA ASSOCIATES", ref: null, key: "AXOIC12345678901", kind: "utr" },
  { bank: "Axis", narration: "BY CLG/CHEQUE NO. 000781/KAPOOR CA", ref: null, key: "781", kind: "cheque" },
  // SBI
  { bank: "SBI", narration: "BY TRANSFER-NEFT*HDFC0000001*N310261234500001*BETHELSOFT INDIA*", ref: null, key: "N310261234500001", kind: "utr" },
  { bank: "SBI", narration: "TO TRANSFER-UPI/DR/531112345678/RK INFRA/SBIN/rkinfra@sbi/rent", ref: null, key: "531112345678", kind: "rrn" },
  { bank: "SBI", narration: "BY TRANSFER-UPI/CR/531212345678/MS TIWARI/HDFC/tiwari@okhdfcbank/inv", ref: null, key: "531212345678", kind: "rrn" },
  { bank: "SBI", narration: "BY TRANSFER-INB IMPS531312345678/9876543210/XX4521/ash", ref: null, key: "531312345678", kind: "rrn" },
  { bank: "SBI", narration: "CHQ TRANSFER-012345-SHARMA TRADERS", ref: null, key: "12345", kind: "cheque" },
  // No rail → no key (an FD account, a TPT account or interest text is never a reference)
  { bank: "HDFC", narration: "SWEEP TRF FROM FD 50300123456789", ref: "000050300123456789", key: null, kind: null },
  { bank: "HDFC", narration: "50100123456789-TPT-RENT OCT-RAVI KUMAR", ref: "0000000000000000", key: null, kind: null },
  { bank: "HDFC", narration: "INTEREST PAID TILL 31-MAR-2026", ref: null, key: null, kind: null },
  // A rail with no reference anywhere (test fixtures, all-zero ref) → no key
  { bank: "test", narration: "NEFT ACME 1838 SALE", ref: null, key: null, kind: null },
  { bank: "test", narration: "NEFT CR R2364 ZERO REF", ref: "000000000000", key: null, kind: null },
  // A rail whose narration has no reference, but the Ref column does
  { bank: "HDFC", narration: "UPI-ASHA DIRECTOR-ASHA@OKSBI-SBIN0001234-UPI", ref: "0000531412345678", key: "531412345678", kind: "rrn" },
  { bank: "HDFC", narration: "NEFT CR-HDFC0000240-KAPOOR LEGAL-EXCEL TECHNOLOGIES", ref: "HDFCN52026110699999", key: "HDFCN52026110699999", kind: "utr" },
  // Review (R-2534): the FIRST rail word decides — "UPI" inside a remitter's name does not
  { bank: "HDFC", narration: "NEFT CR-ICIC0000104-ABC UPI SOLUTIONS PVT LTD-EXCEL TECHNOLOGIES-ICICN52026110612345", ref: null, key: "ICICN52026110612345", kind: "utr" },
  // Review: an all-digit 16-digit account number is never the UTR; the Ref column is
  { bank: "PNB", narration: "NEFT-PUNB0123400-RAM TRADERS-1234567890123456-INV 9", ref: "0000N310261234567890", key: "N310261234567890", kind: "utr" },
  { bank: "PNB", narration: "NEFT-PUNB0123400-RAM TRADERS-1234567890123456-INV 9", ref: null, key: null, kind: null },
  // Review: a cheque line's Ref column beats a PIN code / date in the narration
  { bank: "HDFC", narration: "CHQ DEP - MICR CTS - 110001 - NEW DELHI - SHARMA", ref: "000000123456", key: "123456", kind: "cheque" },
];
