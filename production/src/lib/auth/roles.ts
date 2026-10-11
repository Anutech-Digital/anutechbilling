/**
 * Roles and what each one is allowed to do — the single source of truth.
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * Before it there were TWO `UserRole` unions that disagreed: `types.ts` said
 * owner|sales|accountant|support, `nav.ts` said eight different values. Nothing
 * imported the `types.ts` one, so the disagreement was invisible — but a second
 * definition of "who is allowed here" is the kind of thing that gets imported by
 * accident later, and then two guards on the same route reach opposite answers.
 * Both now re-export from here.
 *
 * ─── ROUTES vs PERMISSIONS ARE DIFFERENT QUESTIONS ───────────────────────────
 * `nav.ts` answers "which PAGES can this role open" and middleware enforces it.
 * This file answers "what can this role DO once it is on a page it may open" —
 * export a CSV, read an unmasked phone number, reveal a vault secret. Route
 * access does not imply data access: `delivery` can open the vault page and must
 * still only ever see masked values.
 *
 * ─── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * `customer_admin` is NOT a UserRole. The customer portal under (public)/portal
 * carries its own session keyed on `customerId` and never reads `users.role`; a
 * portal user has no row in `users` at all. Adding it here would invent a role
 * that nothing sets and imply internal-app access that does not exist. See
 * EXTERNAL_ACTORS below for the map.
 *
 * ─── THIS IS NOT THE LAST LINE OF DEFENCE ────────────────────────────────────
 * Everything here is app-layer. A flag that is false hides a button and refuses
 * an API call, and that is worth having — but the row-level guarantee is RLS in
 * Postgres. When a flag here protects tenant data, there must be a policy that
 * says the same thing. A check that only exists in TypeScript is a check that
 * stops at the first `curl`.
 */

/**
 * Every role that can appear in `users.role`.
 *
 * `accountant` and `support` are retained deliberately. They predate the current
 * matrix and real rows may still carry them; dropping them from the union would
 * make `ROLE_HOME[role]` undefined for those people and bounce them between a
 * redirect and a guard until they gave up. They are removed by migrating the
 * rows first, not by deleting a string.
 */
export const USER_ROLES = [
  "owner",
  "manager",
  "sales_senior",
  "sales",
  "billing",
  "delivery",
  "accountant",
  "support",
  "partner_agent",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Runtime guard. `users.role` IS constrained in Postgres (enum
 * `public.user_role`, extended by 0111 and 0223) — but a stale session, a
 * hand-edited row, or a value added to the enum ahead of this file can all
 * still arrive here, so the check stays.
 */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Roles an INVITE may assign today — i.e. what the `public.user_role` enum
 * actually accepts.
 *
 * `partner_agent` is deliberately absent. It exists in USER_ROLES because nav,
 * ROLE_HOME and PERMISSIONS all need to describe it, but the database enum does
 * not have the value yet (migration 0240 adds it). Typing invites against the
 * full union would let the OAuth callback insert a role Postgres rejects, and
 * the person would land on /login?error=provision_failed with no clue why.
 * Narrow it here and the compiler says so instead.
 */
export const INVITABLE_ROLES = USER_ROLES.filter((r) => r !== "partner_agent") as readonly Exclude<UserRole, "partner_agent">[];
export type InvitableRole = Exclude<UserRole, "partner_agent">;

/**
 * What each role is CALLED on screen.
 *
 * Here rather than in a page, for the reason this file already exists: role
 * vocabulary that lives in more than one place drifts. The /team page had its
 * own copy, so the Claim-a-colleague card next to it offered "sales_senior" and
 * "billing" while the table underneath said "Sales Senior" and "Billing /
 * Accounts" — one screen, two vocabularies, and only one of them is a word.
 *
 * A role added to USER_ROLES without an entry here fails the type check.
 */
export const ROLE_LABEL: Record<UserRole, string> = {
  owner:         "Owner",
  manager:       "Manager",
  sales_senior:  "Sales Senior",
  sales:         "Sales",
  billing:       "Billing / Accounts",
  delivery:      "Delivery (Projects)",
  accountant:    "Accountant / CA",
  support:       "Support",
  partner_agent: "Partner Agent",
};

/** Label for a role that may not be a known one (a stale row, a new enum value). */
export function roleLabel(role: string | null | undefined): string {
  return ROLE_LABEL[(role ?? "") as UserRole] ?? (role || "Member");
}

/**
 * External actors that are NOT `users.role` values, recorded so the next reader
 * does not "fix" their absence.
 */
export const EXTERNAL_ACTORS = {
  /** (public)/portal — own session on `customerId`, no `users` row. */
  customer_admin: "portal session (customerId)",
} as const;

/**
 * What a role may DO. Named as questions about actions, not about screens.
 *
 * Every flag defaults to the most restrictive answer: a role added to
 * USER_ROLES without an entry below fails the type check rather than silently
 * inheriting someone else's permissions.
 */
export interface Permissions {
  /**
   * Bulk export — CSV download buttons and the export API routes.
   *
   * The threat here is not a mistake, it is a leaving employee with a laptop:
   * one click on "Export CSV" is the entire customer list, with phone numbers.
   * Restricted to the two roles that already have every record on screen anyway.
   */
  can_export_data: boolean;
  /** See a customer's real phone / email, rather than a masked form. */
  can_view_contact_details: boolean;
  /** Reveal a vault secret in clear text. `false` still permits masked viewing. */
  can_reveal_vault: boolean;
  /** P&L, balance sheet, bank reconciliation — the books. */
  can_view_financials: boolean;
  /** Invite, offboard, and change roles. */
  can_manage_team: boolean;
  /** API keys, integration secrets, tenant-wide configuration. */
  can_manage_secrets: boolean;
}

/** The most restrictive possible answer — the base every role is built from. */
const NONE: Permissions = {
  can_export_data:          false,
  can_view_contact_details: false,
  can_reveal_vault:         false,
  can_view_financials:      false,
  can_manage_team:          false,
  can_manage_secrets:       false,
};

/**
 * The matrix. `Record<UserRole, …>` is load-bearing: add a role to USER_ROLES
 * and this object stops compiling until somebody decides what that role may do.
 * That is the point — an unlisted role must not default to anything.
 */
export const PERMISSIONS: Record<UserRole, Permissions> = {
  owner: {
    can_export_data:          true,
    can_view_contact_details: true,
    can_reveal_vault:         true,
    can_view_financials:      true,
    can_manage_team:          true,
    can_manage_secrets:       true,
  },
  manager: {
    ...NONE,
    can_export_data:          true,
    can_view_contact_details: true,
    can_reveal_vault:         true,
    can_manage_team:          true,
  },
  // Owns named corporate accounts, so needs the real contact details — but a
  // senior seller is also the likeliest person to leave with the book, which is
  // exactly why export stays off.
  sales_senior: {
    ...NONE,
    can_view_contact_details: true,
  },
  // The tightest internal role: assigned leads and tasks only. Contact details
  // stay masked until an explicit call/email action, so a browse of the list
  // cannot become a copied phone book.
  sales: { ...NONE },
  billing: {
    ...NONE,
    can_view_contact_details: true,
    can_view_financials:      true,
  },
  // Can open the vault (needs to know an account exists) but never sees a
  // secret in clear text.
  delivery: {
    ...NONE,
    can_view_contact_details: true,
  },
  accountant: {
    ...NONE,
    can_view_financials: true,
  },
  support: {
    ...NONE,
    can_view_contact_details: true,
  },
  // External-facing internal role: sees only its own referred leads and payouts
  // under /partners. No customer data, no export, nothing else.
  partner_agent: { ...NONE },
};

/**
 * Can this role do this thing?
 *
 * Takes `string | null | undefined` on purpose — callers read the role off a
 * session or a DB row where it is nullable and untyped. An unknown or missing
 * role answers `false` for everything rather than throwing, because a guard that
 * throws on bad input is a guard that turns a stale session into a 500 instead
 * of a redirect.
 */
export function can(role: string | null | undefined, permission: keyof Permissions): boolean {
  if (!isUserRole(role)) return false;
  return PERMISSIONS[role][permission];
}

/**
 * Mask a phone number or email for roles that may not see it.
 *
 * Masking happens where the value is RENDERED, but the value must also not be
 * sent to a client that may not see it — a masked string in the DOM with the
 * real one in the JSON payload is not masking, it is a longer path to the same
 * leak. Use this for display; keep the API from selecting the column at all
 * where that is possible.
 */
export function maskContact(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "—";
  if (v.includes("@")) {
    const [user, domain] = v.split("@");
    const head = user.slice(0, 2);
    return `${head}${"•".repeat(Math.max(user.length - 2, 3))}@${domain}`;
  }
  // Phone: keep the last 4 so a rep can confirm they are looking at the right
  // record without being able to dial it from the screen.
  const digits = v.replace(/\D/g, "");
  if (digits.length < 5) return "•".repeat(v.length);
  return `${"•".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * R-718 (11 Oct 2026, Pardeep's role table): who may do money actions. The database refuses
 * everyone else (migration 20261011120000_r718_money_roles), so the buttons are hidden too.
 *   MONEY_RECORD_ROLES — record a payment, credit / debit note, direct invoice, bank match /
 *                        booking, vendor bill / referral payout, transfer, use customer credit.
 *   MONEY_DELETE_ROLES — delete a payment, an invoice or a subscription.
 * Sales, support, delivery and the partner agent: view only.
 */
export const MONEY_RECORD_ROLES: readonly UserRole[] = ["owner", "manager", "accountant", "billing"];
export const MONEY_DELETE_ROLES: readonly UserRole[] = ["owner", "accountant"];

/** True when the role may record money. An unknown role (still loading) counts as allowed —
 *  like canWriteMoney, so owners never see the buttons flicker; the database is the guard. */
export function canRecordMoney(role: string | null | undefined): boolean {
  if (!role) return true;
  return (MONEY_RECORD_ROLES as readonly string[]).includes(role);
}

/** True when the role may delete a payment, invoice or subscription. Unknown role → allowed
 *  (still loading), same reason as canRecordMoney. */
export function canDeleteMoney(role: string | null | undefined): boolean {
  if (!role) return true;
  return (MONEY_DELETE_ROLES as readonly string[]).includes(role);
}
