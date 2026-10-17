import type { Metadata } from "next";
import { LegalDoc } from "@/site/components/legal/LegalDoc";
export const metadata: Metadata = {
  title: "Refund policy",
  description: "Anutech Digital's refund policy: what is refundable, what is not, and how long it takes.",
};
export default function RefundPage() { return <LegalDoc page="refund" />; }
