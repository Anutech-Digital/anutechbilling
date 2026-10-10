/**
 * Accounts — the rows GoTrue kept in auth.users, now read and written by the app itself.
 *
 * Same table, same columns, same bcrypt hashes: every existing password keeps working, and
 * because GoTrue's own format is preserved, switching AUTH_PROVIDER back to gotrue loses
 * nothing. Returned objects have the shape of a supabase-js `User`, so the ~190 call sites
 * that read `user.id`, `user.email`, `user.user_metadata` need no change.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { withAuthStore } from "@/server/db/auth-store";

export interface AuthUser {
  id: string;
  aud: "authenticated";
  role: "authenticated";
  email: string;
  email_confirmed_at: string | null;
  confirmed_at: string | null;
  phone: string;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  identities: unknown[];
  is_anonymous: false;
  banned_until?: string | null;
}

interface Row {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: Date | null;
  last_sign_in_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  banned_until: Date | null;
}

const COLS = `id::text as id, email, encrypted_password, email_confirmed_at, last_sign_in_at, created_at, updated_at,
              raw_app_meta_data, raw_user_meta_data, banned_until`;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const GOTRUE_INSTANCE = "00000000-0000-0000-0000-000000000000";
const BCRYPT_COST = 10; // GoTrue's default

function toUser(r: Row): AuthUser {
  return {
    id: r.id,
    aud: "authenticated",
    role: "authenticated",
    email: r.email ?? "",
    email_confirmed_at: iso(r.email_confirmed_at),
    confirmed_at: iso(r.email_confirmed_at),
    phone: "",
    last_sign_in_at: iso(r.last_sign_in_at),
    created_at: iso(r.created_at) ?? new Date(0).toISOString(),
    updated_at: iso(r.updated_at) ?? new Date(0).toISOString(),
    app_metadata: r.raw_app_meta_data ?? { provider: "email", providers: ["email"] },
    user_metadata: r.raw_user_meta_data ?? {},
    identities: [],
    is_anonymous: false,
    banned_until: iso(r.banned_until),
  };
}

export const normalise = (email: string) => email.trim().toLowerCase();

export async function getUserById(id: string): Promise<AuthUser | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(`select ${COLS} from auth.users where id = $1::uuid`, id));
  return rows[0] ? toUser(rows[0]) : null;
}

export async function getUserByEmail(email: string): Promise<AuthUser | null> {
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(
    `select ${COLS} from auth.users where lower(email) = $1 order by created_at limit 1`, normalise(email)));
  return rows[0] ? toUser(rows[0]) : null;
}

export async function listUsers(page = 1, perPage = 50): Promise<{ users: AuthUser[]; total: number }> {
  return withAuthStore(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Row[]>(`select ${COLS} from auth.users order by created_at desc limit $1 offset $2`,
      Math.min(Math.max(perPage, 1), 1000), Math.max(page - 1, 0) * perPage);
    const t = await tx.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int as n from auth.users`);
    return { users: rows.map(toUser), total: Number(t[0]?.n ?? 0) };
  });
}

const isBanned = (u: AuthUser) => Boolean(u.banned_until && new Date(u.banned_until).getTime() > Date.now());

export type PasswordCheck =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: "invalid_credentials" | "email_not_confirmed" | "banned" };

// A real bcrypt hash of a random string: comparing against it costs the same as a real check,
// so "no such account" and "wrong password" take the same time.
let dummyHash: string | undefined;
const dummy = () => (dummyHash ??= bcrypt.hashSync(randomUUID(), BCRYPT_COST));

export async function checkPassword(email: string, password: string): Promise<PasswordCheck> {
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(
    `select ${COLS} from auth.users where lower(email) = $1 and deleted_at is null order by created_at limit 1`, normalise(email)));
  const row = rows[0];
  const hash = row?.encrypted_password || dummy();
  const match = await bcrypt.compare(password, hash.replace(/^\$2y\$/, "$2b$"));
  if (!row || !row.encrypted_password || !match) return { ok: false, reason: "invalid_credentials" };
  const user = toUser(row);
  if (isBanned(user)) return { ok: false, reason: "banned" };
  if (!user.email_confirmed_at) return { ok: false, reason: "email_not_confirmed" };
  return { ok: true, user };
}

export async function recordSignIn(id: string): Promise<void> {
  await withAuthStore((tx) => tx.$executeRawUnsafe(`update auth.users set last_sign_in_at = now() where id = $1::uuid`, id));
}

export interface CreateUserInput {
  email: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

/** `id` is only for linking a login to an existing public.users profile (linkOAuthUser). */
export async function createUser(input: CreateUserInput, id?: string): Promise<AuthUser> {
  const email = normalise(input.email);
  if (id !== undefined && !/^[0-9a-f-]{36}$/i.test(id)) throw new AuthError("invalid user id", "validation_failed", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("Unable to validate email address: invalid format", "email_address_invalid", 400);
  const hash = input.password ? await bcrypt.hash(input.password, BCRYPT_COST) : null;
  return withAuthStore(async (tx) => {
    const existing = await tx.$queryRawUnsafe<{ id: string }[]>(`select id::text as id from auth.users where lower(email) = $1 limit 1`, email);
    if (existing.length) throw new AuthError("A user with this email address has already been registered", "email_exists", 422);
    const provider = (input.app_metadata?.provider as string | undefined) ?? "email";
    const rows = await tx.$queryRawUnsafe<Row[]>(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                               raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
       values ($1::uuid, $2::uuid, 'authenticated', 'authenticated', $3, $4, $5::timestamptz, $6::jsonb, $7::jsonb, now(), now(), false, false)
       returning ${COLS}`,
      GOTRUE_INSTANCE, id ?? randomUUID(), email, hash, input.email_confirm ? new Date().toISOString() : null,
      JSON.stringify({ provider, providers: [provider], ...(input.app_metadata ?? {}) }),
      JSON.stringify(input.user_metadata ?? {}),
    );
    return toUser(rows[0]);
  });
}

export interface UpdateUserInput {
  email?: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  /** GoTrue style: "none" to unban, or "<hours>h" e.g. "876000h". */
  ban_duration?: string;
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<AuthUser> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  const add = (sql: string, v: unknown) => { params.push(v); sets.push(sql.replace("?", `$${params.length}`)); };
  if (input.email !== undefined) add("email = ?", normalise(input.email));
  if (input.password !== undefined) add("encrypted_password = ?", await bcrypt.hash(input.password, BCRYPT_COST));
  if (input.email_confirm === true) sets.push("email_confirmed_at = coalesce(email_confirmed_at, now())");
  if (input.email_confirm === false) sets.push("email_confirmed_at = null");
  if (input.user_metadata) add("raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || ?::jsonb", JSON.stringify(input.user_metadata));
  if (input.app_metadata) add("raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || ?::jsonb", JSON.stringify(input.app_metadata));
  if (input.ban_duration !== undefined) {
    if (input.ban_duration === "none") sets.push("banned_until = null");
    else {
      const hours = /^(\d+)h$/.exec(input.ban_duration)?.[1];
      if (!hours) throw new AuthError("ban_duration must be 'none' or '<hours>h'", "validation_failed", 400);
      add("banned_until = now() + (? || ' hours')::interval", hours);
    }
  }
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(
    `update auth.users set ${sets.join(", ")} where id = $1::uuid returning ${COLS}`, ...params));
  if (!rows[0]) throw new AuthError("User not found", "user_not_found", 404);
  return toUser(rows[0]);
}

export async function deleteUser(id: string): Promise<void> {
  await withAuthStore((tx) => tx.$executeRawUnsafe(`delete from auth.users where id = $1::uuid`, id));
}

/* ── OAuth sign-in → the EXISTING account (R-529) ────────────────────────────────────────
   9 Oct 2026, staging: Pardeep signed in with Google and got a brand-new auth.users id, not
   linked to his public.users row — no tenant, "Loading…", every list empty. The old code only
   looked in auth.users by email and created a row when that missed. GoTrue linked a Google
   login by its IDENTITY first (auth.identities: provider + Google `sub`), and the app's data
   hangs off public.users.id — so those are what decide the id now, in this order:

     1. auth.identities (provider, sub)    — exactly the link GoTrue used
     2. public.users with this email       — the profile that carries tenant_id + role
                                             (via public.login_profile_id_for_email; app_auth
                                             cannot read public tables directly)
     3. auth.users with this email
     4. none of these → a new account (no tenant; the normal join/onboarding flow follows)

   Never a second account for an address that already has one; an unverified address is
   refused before any lookup. */

export type OAuthLink =
  | { ok: true; user: AuthUser; how: "identity" | "profile" | "email" | "created" }
  | { ok: false; reason: "unverified" | "banned" | "conflict" };

export interface OAuthLinkInput {
  email: string;
  emailVerified: boolean;
  name: string | null;
  provider: string;
  /** The provider's stable account id (Google `sub`). */
  subject?: string | null;
}

/** The lookups linkOAuthUser needs — the real ones talk to the database, tests pass fakes. */
export interface OAuthStore {
  userIdForIdentity(provider: string, subject: string): Promise<string | null>;
  profileIdForEmail(email: string): Promise<string | null>;
  byEmail(email: string): Promise<AuthUser | null>;
  byId(id: string): Promise<AuthUser | null>;
  create(input: CreateUserInput, id?: string): Promise<AuthUser>;
  /** Confirm the address. A password set before it was ever confirmed is dropped (pre-hijack). */
  confirm(id: string): Promise<AuthUser>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function linkOAuthUser(input: OAuthLinkInput, store: OAuthStore): Promise<OAuthLink> {
  const email = normalise(input.email ?? "");
  if (input.emailVerified !== true || !EMAIL_RE.test(email)) return { ok: false, reason: "unverified" };

  const finish = async (u: AuthUser, how: "identity" | "profile" | "email"): Promise<OAuthLink> => {
    if (isBanned(u)) return { ok: false, reason: "banned" };
    return { ok: true, user: u.email_confirmed_at ? u : await store.confirm(u.id), how };
  };

  if (input.subject) {
    const id = await store.userIdForIdentity(input.provider, input.subject);
    const u = id ? await store.byId(id) : null;
    if (u) return finish(u, "identity");
  }

  const profileId = await store.profileIdForEmail(email);
  const byEmail = await store.byEmail(email);
  const fresh = (): CreateUserInput => ({
    email, email_confirm: true,
    user_metadata: input.name ? { full_name: input.name, name: input.name } : {},
    app_metadata: { provider: input.provider },
  });

  if (profileId) {
    const owner = await store.byId(profileId);
    if (owner) return finish(owner, "profile");
    // The profile has no login row, and a DIFFERENT login holds the address: refuse rather
    // than fork the account. db/ops/22-r529-merge-duplicate-google-login.sql repairs this.
    if (byEmail) return { ok: false, reason: "conflict" };
    return { ok: true, user: await store.create(fresh(), profileId), how: "created" };
  }
  if (byEmail) return finish(byEmail, "email");
  return { ok: true, user: await store.create(fresh()), how: "created" };
}

/** A lookup the login role may not be granted yet (db/ops/21) — treated as "no match", loudly. */
async function optionalLookup<T>(what: string, fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/permission denied|does not exist|42501|42883|42P01/i.test(msg)) {
      console.warn(`[auth] ${what} unavailable (run db/ops/21-auth-login-link.sql): ${msg.slice(0, 160)}`);
      return null;
    }
    throw e;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dbOAuthStore: OAuthStore = {
  userIdForIdentity: (provider, subject) => optionalLookup("auth.identities", async () => {
    const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<{ id: string }[]>(
      `select i.user_id::text as id from auth.identities i
         join auth.users u on u.id = i.user_id and u.deleted_at is null
        where i.provider = $1 and i.provider_id = $2 limit 1`, provider, subject));
    return rows[0]?.id ?? null;
  }),
  profileIdForEmail: (email) => optionalLookup("public.login_profile_id_for_email", async () => {
    const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<{ id: string | null }[]>(
      `select public.login_profile_id_for_email($1)::text as id`, email));
    const id = rows[0]?.id ?? null;
    return id && UUID_RE.test(id) ? id : null;
  }),
  async byEmail(email) {
    const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(
      `select ${COLS} from auth.users where lower(email) = $1 and deleted_at is null order by created_at limit 1`, normalise(email)));
    return rows[0] ? toUser(rows[0]) : null;
  },
  byId: getUserById,
  create: (input, id) => createUser(input, id),
  async confirm(id) {
    const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(
      `update auth.users
          set encrypted_password = case when email_confirmed_at is null then null else encrypted_password end,
              email_confirmed_at = coalesce(email_confirmed_at, now()),
              updated_at = now()
        where id = $1::uuid returning ${COLS}`, id));
    if (!rows[0]) throw new AuthError("User not found", "user_not_found", 404);
    return toUser(rows[0]);
  },
};

/** Google (or another OAuth provider) proved this address: the existing account, or a new confirmed one. */
export function ensureOAuthUser(input: OAuthLinkInput): Promise<OAuthLink> {
  return linkOAuthUser(input, dbOAuthStore);
}

export class AuthError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "AuthApiError";
  }
}
