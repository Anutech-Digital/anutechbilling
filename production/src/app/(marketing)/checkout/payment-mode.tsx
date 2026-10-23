"use client";
/**
 * R-1502: hands the server-read payment mode (layout.tsx) to the client checkout page.
 * Without a provider the page behaves exactly as before this card — "live".
 */
import { createContext, useContext } from "react";
import type { CheckoutPaymentMode } from "@/lib/checkout/checkout-payment-mode";

const PaymentModeContext = createContext<CheckoutPaymentMode>("live");

export function PaymentModeProvider({ mode, children }: { mode: CheckoutPaymentMode; children: React.ReactNode }) {
  return <PaymentModeContext.Provider value={mode}>{children}</PaymentModeContext.Provider>;
}

export function usePaymentMode(): CheckoutPaymentMode {
  return useContext(PaymentModeContext);
}
