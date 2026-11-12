import { redirect } from "next/navigation";

/** Old bookmarks go straight to the working Paid ads screen. */
export default function PaidAdsRedirect() {
  redirect("/marketing/ads");
}
