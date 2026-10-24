"use client";
/**
 * R-1502: hands the server-read payment mode (layout.tsx) to the client checkout page.
 * Without a provider the page behaves exactly as before this card — "live".
 * R-1769: also whether a laptop with Razorpay TEST keys may open the real test window.
 */
import { createContext, useContext } from "react";
import type { CheckoutPaymentMode } from "@/lib/checkout/checkout-payment-mode";

const PaymentModeContext = createContext<{ mode: CheckoutPaymentMode; razorpayTest: boolean }>({ mode: "live", razorpayTest: false });

export function PaymentModeProvider({ mode, razorpayTest = false, children }: { mode: CheckoutPaymentMode; razorpayTest?: boolean; children: React.ReactNode }) {
  return <PaymentModeContext.Provider value={{ mode, razorpayTest }}>{children}</PaymentModeContext.Provider>;
}

export function usePaymentMode(): CheckoutPaymentMode {
  return useContext(PaymentModeContext).mode;
}

/** R-1769: true only on a laptop that has Razorpay TEST keys (never on a deployment). */
export function useRazorpayTestOffered(): boolean {
  return useContext(PaymentModeContext).razorpayTest;
}
