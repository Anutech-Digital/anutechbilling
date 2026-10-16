/**
 * Terms and conditions for what customers BUY from Anutech Digital — domains, hosting,
 * email, SSL and licences (30 Sep 2026). `/terms` is a different document: the terms of
 * the ResellerOS software itself, `(public)/terms`. The checkout agreement, the site
 * footer and DMS's old `/terms-and-conditions` link all point here.
 */
import type { Metadata } from "next";
import { LegalDoc } from "@/site/components/legal/LegalDoc";
export const metadata: Metadata = { title: { absolute: "Anutech Digital terms and conditions" } };
export default function TermsAndConditionsPage() { return <LegalDoc page="terms" />; }
