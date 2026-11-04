/**
 * /privacy/request — R-2013 (2 Nov 2026, goal G-DPDP). The public "Your data" form: see,
 * correct or delete my data, withdraw my consent, or nominate someone. Linked from
 * "Your rights" on /privacy-policy and /privacy. The email is confirmed with a 6-digit code;
 * the request then reaches the company's Settings → Privacy requests with a due-by date.
 */
import type { Metadata } from "next";
import { PrivacyRequestClient } from "./request-client";

export const metadata: Metadata = {
  title: "Your data — make a request",
  description: "Ask to see, correct or delete your personal data, withdraw your consent, or nominate someone.",
};

export default function PrivacyRequestPage() {
  return <PrivacyRequestClient />;
}
