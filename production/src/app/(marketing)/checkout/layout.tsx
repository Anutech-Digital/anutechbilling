import type { Metadata } from "next";
import { loadCheckoutPaymentSetup } from "@/lib/checkout/checkout-payment-mode.server";
import { PaymentModeProvider } from "./payment-mode";

/**
 * R-1479: the checkout page is a client component, so its title lives here. It is
 * per-visitor, and robots.txt already keeps /checkout out of search.
 */
export const metadata: Metadata = {
  title: "Checkout",
  description: "Who the invoice is for, then payment.",
  robots: { index: false, follow: true },
};

/* R-1502: whether Razorpay is set up is read per request — keys added in Settings must show
   on the next visit, not after a rebuild. */
export const dynamic = "force-dynamic";

export default async function CheckoutLayout({ children }: { children: React.ReactNode }) {
  const { mode, razorpayTest } = await loadCheckoutPaymentSetup();
  return <PaymentModeProvider mode={mode} razorpayTest={razorpayTest}>{children}</PaymentModeProvider>;
}
