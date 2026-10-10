/**
 * Two-step sign-in (R-048) on Auth.js, stored in GoTrue's own auth.mfa_factors table so a
 * factor enrolled before the switch keeps working, and after it if we switch back.
 *
 * A code is accepted once: the step it belonged to is stored in last_challenged_at and an
 * equal-or-older step is refused — GoTrue did not stop a replay inside the 30-second window.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { withAuthStore } from "@/server/db/auth-store";
import { matchStep, newSecret, otpauthUri } from "./totp";

export interface Factor {
  id: string;
  friendly_name: string | null;
  factor_type: "totp";
  status: "verified" | "unverified";
  created_at: string;
  updated_at: string;
}

interface FactorRow {
  id: string;
  friendly_name: string | null;
  status: "verified" | "unverified";
  secret: string | null;
  created_at: Date;
  updated_at: Date;
  last_challenged_at: Date | null;
}

const toFactor = (r: FactorRow): Factor => ({
  id: r.id, friendly_name: r.friendly_name, factor_type: "totp", status: r.status,
  created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
});

const SELECT = `select id::text as id, friendly_name, status::text as status, secret, created_at, updated_at, last_challenged_at
                  from auth.mfa_factors where user_id = $1::uuid and factor_type = 'totp'`;

export async function listFactors(userId: string): Promise<Factor[]> {
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<FactorRow[]>(`${SELECT} order by created_at`, userId));
  return rows.map(toFactor);
}

export async function hasVerifiedFactor(userId: string): Promise<boolean> {
  return (await listFactors(userId)).some((f) => f.status === "verified");
}

/** Start enrolling: a new unverified factor (older unverified ones are dropped), plus the QR to scan. */
export async function enroll(userId: string, email: string, friendlyName?: string) {
  const secret = newSecret();
  const id = randomUUID();
  await withAuthStore(async (tx) => {
    await tx.$executeRawUnsafe(`delete from auth.mfa_factors where user_id = $1::uuid and status = 'unverified'`, userId);
    await tx.$executeRawUnsafe(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
       values ($1::uuid, $2::uuid, $3, 'totp', 'unverified', $4, now(), now())`,
      id, userId, friendlyName ?? null, secret);
  });
  const uri = otpauthUri(secret, email);
  const svg = await QRCode.toString(uri, { type: "svg", margin: 1 });
  return { id, type: "totp" as const, friendly_name: friendlyName ?? null, totp: { secret, uri, qr_code: `data:image/svg+xml;utf-8,${svg}` } };
}

/**
 * Check a code against one factor (enrollment) or any verified factor (sign-in).
 * On success an unverified factor becomes verified. Returns false for a wrong or replayed code.
 */
export async function verifyCode(userId: string, code: string, factorId?: string): Promise<boolean> {
  return withAuthStore(async (tx) => {
    const rows = await tx.$queryRawUnsafe<FactorRow[]>(
      factorId ? `${SELECT} and id = $2::uuid for update` : `${SELECT} and status = 'verified' for update`,
      ...(factorId ? [userId, factorId] : [userId]));
    for (const r of rows) {
      if (!r.secret) continue;
      const step = matchStep(r.secret, code.trim());
      if (step === null) continue;
      const lastStep = r.last_challenged_at ? Math.floor(r.last_challenged_at.getTime() / 30_000) : -1;
      if (step <= lastStep) return false; // replay
      await tx.$executeRawUnsafe(
        `update auth.mfa_factors set status = 'verified', last_challenged_at = to_timestamp($2::bigint * 30), updated_at = now()
          where id = $1::uuid`, r.id, step);
      return true;
    }
    return false;
  });
}

export async function unenroll(userId: string, factorId: string): Promise<boolean> {
  const n = await withAuthStore((tx) => tx.$executeRawUnsafe(
    `delete from auth.mfa_factors where id = $1::uuid and user_id = $2::uuid`, factorId, userId));
  return Number(n) > 0;
}
