/**
 * Privacy policy for customers of Anutech Digital — what buying domains, hosting, email
 * and licences shares with us (30 Sep 2026). `/privacy` is a different document: the
 * privacy policy of the ResellerOS software itself, `(public)/privacy`. The site footer,
 * the login page and DMS's old `/privacy` and `/data-deletion` links point here.
 */
import type { Metadata } from "next";
import { LegalDoc } from "@/site/components/legal/LegalDoc";
export const metadata: Metadata = {
  title: { absolute: "Anutech Digital privacy policy" },
  description:
    "How Anutech Digital handles the personal data shared when you buy domains, hosting, email and licences.",
};
export default function PrivacyPolicyPage() { return <LegalDoc page="privacy" />; }
