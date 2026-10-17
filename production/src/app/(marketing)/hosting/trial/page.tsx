import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HostingTrialStatus } from "@/site/components/hosting/HostingTrialStatus";

/**
 * /hosting/trial — only where the trial's "confirm your email" link lands
 * (?confirmed=<status>, set by api/public/trial/hosting/confirm).
 *
 * It used to be the trial form. Since 24 Sep 2026 "Start free trial" puts the
 * trial in the cart and checkout collects the details, so a visit with no status
 * — an old bookmark, or a link carrying ?plan= — goes to the plans, where the
 * button is. noindex: it is a status page, not a page to rank.
 */
export const metadata: Metadata = {
  title: "Your hosting trial",
  robots: { index: false, follow: true },
};

export default async function HostingTrialPage(props: { searchParams: Promise<{ confirmed?: string }> }) {
  const searchParams = await props.searchParams;
  const status = typeof searchParams.confirmed === "string" ? searchParams.confirmed : "";
  if (!status) redirect("/hosting#choose");
  return <HostingTrialStatus status={status} />;
}
