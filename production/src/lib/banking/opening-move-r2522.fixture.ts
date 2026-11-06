/**
 * R-2522 test fixture — the staging HDFC 4523 FY 25-26 statement's shape (paise kept): 20,20,918.96
 * start, rupee-rounded amounts sum ₹2 short of the bank's balance, SUBHVISION NEFT ₹37,170 last
 * (txn 01/04/26, value 31/03/26), closing 9,03,551.93. Same figures as
 * supabase/tests/r2522_bank_opening_meet.test.sql. HDFC's own export columns.
 */
export const SUBHVISION_CSV = [
  "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  "10/04/25,RTGS OUT,F1,10/04/25,500000.50,,1520918.46",
  "21/11/25,FD BOOKED,F2,21/11/25,655236.50,,865681.96",
  "31/03/26,NEFT IN,F3,31/03/26,,1000.47,866682.43",
  "31/03/26,BANK CHARGES,F4,31/03/26,300.50,,866381.93",
  "01/04/26,NEFT CR-SUBHVISION,IN42609055612841,31/03/26,,37170.00,903551.93",
].join("\n");
