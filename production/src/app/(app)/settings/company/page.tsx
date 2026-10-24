import { redirect } from "next/navigation";

/**
 * R-1670 (item 6): screens say "Settings → Company", so people type /settings/company —
 * which was a 404. Company is the default Settings tab (settings-tab.ts), whose URL is
 * plain /settings; send them there.
 */
export default function CompanySettingsRedirect(): never {
  redirect("/settings");
}
