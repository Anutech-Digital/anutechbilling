/**
 * The wording of the trial confirmation page, per ?confirmed=<status> (set by
 * api/public/trial/hosting/confirm). Kept apart from the page so it can be tested
 * without loading the page's web font.
 */
import { TRIAL_PLAN_NAME } from "@/lib/hosting/trial-plan";

export interface TrialStatus {
  ok: boolean;
  title: string;
  body: string;
  /** The account exists in DMS, so the Customer Portal login is the next step. */
  portal?: boolean;
}

export const TRIAL_STATUSES: Record<string, TrialStatus> = {
  provisioned: {
    ok: true, portal: true,
    title: "Your hosting is live.",
    body: `Your ${TRIAL_PLAN_NAME} hosting is ready. We've emailed you a link to set your Customer Portal password — open it, then log in to manage your hosting, email and WordPress.`,
  },
  already: {
    ok: true, portal: true,
    title: "Your trial is already active.",
    body: "Your hosting is set up. Log in to the Customer Portal to manage it — first time there? Sign in with the one-time password we emailed you, then choose your own.",
  },
  pending: {
    ok: true,
    title: "Email confirmed — we're setting up your account.",
    body: "Thanks! Our team is creating your hosting account and will email your Customer Portal login within 1 working day. No credit card is charged.",
  },
  needdomain: { ok: true, title: "Email confirmed — one thing left.", body: "You told us you still need a domain. We'll be in touch shortly to help you pick one, then set up your trial." },
  notrialplan: { ok: true, title: "Email confirmed — we'll call you about the plan.", body: `The free trial is now only on the ${TRIAL_PLAN_NAME} plan, and you asked for a bigger one. We'll be in touch shortly to start a ${TRIAL_PLAN_NAME} trial or set up the plan you picked. Nothing is charged.` },
  error: { ok: false, title: "Almost there — we'll finish this by hand.", body: "We hit a snag setting things up automatically, so our team will complete it and email your Customer Portal login within 1 working day. Nothing is wrong on your end." },
  expired: { ok: false, title: "That link has expired.", body: "Confirmation links are valid for 48 hours. Start the trial again from the hosting page and we'll send a fresh one." },
  invalid: { ok: false, title: "That link didn't work.", body: "Start the trial again from the hosting page to get a new confirmation link." },
};
