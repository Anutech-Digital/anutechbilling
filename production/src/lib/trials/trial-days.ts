/**
 * R-1117 — how long each free trial lasts, in ONE place.
 *
 * The Workspace trial is 14 days and the hosting trial is 15. Both numbers used to be typed
 * by hand in routes, emails, landing pages, the cart and the checkout, so a page could say
 * one thing while the server set up another. Every page, route and email reads these now;
 * `trial-days.test.ts` fails if a hard-coded "14-day" / "15 days" comes back.
 *
 * Changing a number here changes what customers are promised — that is Pardeep's call.
 */

/** Google Workspace free trial (buy page, Ads landing pages, /leads Start trial, quote trial default). */
export const WORKSPACE_TRIAL_DAYS = 14;

/** Starter web-hosting free trial (hosting page, cart, checkout, done page, trial emails). */
export const HOSTING_TRIAL_DAYS = 15;
