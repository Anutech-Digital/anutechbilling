/**
 * R-2692: social-publish and meta-leads-pull are company jobs, OFF until switched on (R-897).
 * Like social-drafts (its screen switch turns its own job on), the act that asks for the job
 * turns it on: approving a post WITH a post time → social-publish; saving chosen lead forms →
 * meta-leads-pull. The database decides (public.ensure_social_automation_on): only the OWNER's
 * act switches (R-897 — only the owner turns automations on), these two jobs only, and never over
 * a switch a person set — an owner who turned it off on /automation keeps it off. For a manager
 * it changes nothing and only answers whether the job is on, so the screen can say "ask the owner".
 *
 * Returns true = the job is on now, false = it stays off (a person turned it off), null = could
 * not check. Never throws: the approval / the saved forms stand either way.
 */
import "server-only";
import { createClient } from "@/lib/supabase/server";

export type SocialJob = "social-publish" | "meta-leads-pull";

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

export async function ensureSocialJobOn(job: SocialJob): Promise<boolean | null> {
  try {
    const client = createClient();
    /* ensure_social_automation_on is newer than the generated Database types (same untyped rpc
       as set_automation_job in the social-drafts settings route). */
    const rpc = client.rpc as unknown as Rpc;
    const { data, error } = await rpc.call(client, "ensure_social_automation_on", { p_job: job });
    if (error) {
      console.error(`[automation] could not turn on ${job}:`, error.message);
      return null;
    }
    return data === true;
  } catch (e) {
    console.error(`[automation] turning on ${job} crashed:`, e instanceof Error ? e.message : "unknown");
    return null;
  }
}
