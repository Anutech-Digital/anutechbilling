/**
 * R-1624 (24 Oct 2026): the Workspace thanks page called a fully paid order "Partially paid".
 * The GST invoice is issued straight after record_payment and moves the quote to
 * payment_status 'invoiced', and the page treated only 'received' as paid. 'invoiced' alone
 * does not say how much came in (a part-paid quote can be invoiced too), so the state comes
 * from the status AND the money received against the quote's total.
 */
import { describe, it, expect } from "vitest";
import { orderPaymentState, type OrderPaymentState } from "./order-payment-state";

const cases: { name: string; paymentStatus: string | null; amount: number | null; received: number | null; want: OrderPaymentState }[] = [
  { name: "received → paid", paymentStatus: "received", amount: 3186, received: 3186, want: "paid" },
  { name: "received, sum not read → paid (record_payment sets it only on full)", paymentStatus: "received", amount: 3186, received: null, want: "paid" },
  { name: "invoiced and fully paid → paid", paymentStatus: "invoiced", amount: 3186, received: 3186, want: "paid" },
  { name: "invoiced, paid more than the total → paid", paymentStatus: "invoiced", amount: 3186, received: 3200, want: "paid" },
  { name: "invoiced but only part paid → part-paid", paymentStatus: "invoiced", amount: 3186, received: 1000, want: "part-paid" },
  { name: "invoiced, nothing received → pending", paymentStatus: "invoiced", amount: 3186, received: 0, want: "pending" },
  { name: "invoiced, received unknown → never claims paid", paymentStatus: "invoiced", amount: 3186, received: null, want: "pending" },
  { name: "invoiced, total unknown → never claims paid", paymentStatus: "invoiced", amount: null, received: 3186, want: "part-paid" },
  { name: "partial → part-paid", paymentStatus: "partial", amount: 3186, received: 1000, want: "part-paid" },
  { name: "partial, sum not read → part-paid", paymentStatus: "partial", amount: 3186, received: null, want: "part-paid" },
  { name: "awaiting → pending", paymentStatus: "awaiting", amount: 3186, received: 0, want: "pending" },
  { name: "pending → pending", paymentStatus: "pending", amount: 3186, received: null, want: "pending" },
  { name: "missing status → pending", paymentStatus: null, amount: null, received: null, want: "pending" },
];

describe("orderPaymentState — one mapping for an order's payment state (R-1624)", () => {
  it.each(cases)("$name", ({ paymentStatus, amount, received, want }) => {
    expect(orderPaymentState({ paymentStatus, amount, received })).toBe(want);
  });
});
