/**
 * R-1010 (data-leak audit, 11 Oct 2026): every sign-in leaves one row the owner can see —
 * who, which company, from which IP and device, and when — written by the SERVER.
 *
 * Before: the topbar called the log_activity RPC from the browser once per tab session
 * ("login", no IP, no device). Anything the browser writes, the browser can also skip or
 * fake. Now:
 *   Auth.js (staging, live after R-909)  authorize() / the Google jwt step call recordLogin()
 *                                        directly — the browser is not involved at all.
 *   GoTrue (live today)                  the password check happens at GoTrue, so the app's
 *                                        first server contact is POST /api/auth/login-event;
 *                                        it reads the user and last_sign_in_at from GoTrue
 *                                        itself and records THAT sign-in (the browser sends no
 *                                        body). A once-per-sign-in unique index makes repeats
 *                                        a no-op.
 *   log_activity('login', …) from a browser is ignored by the database (migration
 *   20261023173100_r1010_server_login_log.sql).
 *
 * What the row holds: activity_log (tenant_id, user_id, action 'login', entity 'session',
 * label "Chrome on Windows · IP 203.0.113.7 · password", changes {ip, device, method,
 * signed_in_at}). Never the user-agent string itself, an email, a password, a cookie or a token.
 * Read by owner/manager only (activity_log_sel_owner_manager, R-1002) on /activity.
 * IP = clientIp() — the trusted proxy hop of x-forwarded-for, the same rule as the rate limiter.
 */
import "server-only";
import { clientIp } from "@/lib/security/rate-limit";
import { createAdminClient } from "@/lib/supabase/server";

/** R-1926: "email_link" = signed in by the signup confirm link (server/auth/email-link.ts). */
export type LoginMethod = "password" | "google" | "session" | "email_link";

export interface LoginActivityRow {
  tenant_id: string;
  user_id: string;
  action: "login";
  entity: "session";
  entity_id: null;
  label: string;
  changes: { ip: string; device: string; method: LoginMethod; signed_in_at: string };
}

/** The two database steps recordLogin needs — the admin client in the app, a fake in tests. */
export interface LoginLogStore {
  /** The user's public.users row (company + active flag), or null. */
  userOf(userId: string): Promise<{ tenant_id: string | null; is_active: boolean | null } | null>;
  insert(row: LoginActivityRow): Promise<{ code?: string; message: string } | null>;
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];
const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "Mac"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

/** "Chrome on Windows" — a fixed vocabulary, so nothing the client typed reaches the log. */
export function deviceSummary(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}

/** IPv4 / IPv6 shape only; anything else (a forged header with text in it) → "unknown". */
function safeIp(ip: string): string {
  return /^[0-9a-f.:]{2,45}$/i.test(ip) ? ip : "unknown";
}

export function loginRow(input: {
  userId: string;
  tenantId: string;
  headers: Headers | null | undefined;
  method: LoginMethod;
  signedInAt: string;
}): LoginActivityRow {
  const ip = input.headers ? safeIp(clientIp(input.headers)) : "unknown";
  const device = deviceSummary(input.headers?.get("user-agent"));
  const label = [device, `IP ${ip}`, input.method === "session" ? null : input.method]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 120);
  return {
    tenant_id: input.tenantId,
    user_id: input.userId,
    action: "login",
    entity: "session",
    entity_id: null,
    label,
    changes: { ip, device, method: input.method, signed_in_at: input.signedInAt },
  };
}

function adminStore(): LoginLogStore {
  const admin = createAdminClient();
  return {
    async userOf(userId) {
      const { data } = await admin.from("users").select("tenant_id, is_active").eq("id", userId).maybeSingle();
      return (data as { tenant_id: string | null; is_active: boolean | null } | null) ?? null;
    },
    async insert(row) {
      const { error } = await admin.from("activity_log").insert(row);
      return error ? { code: error.code, message: error.message } : null;
    },
  };
}

/**
 * Record one sign-in. Never throws: a sign-in must not fail because the log could not be written.
 * `signedInAt` = the sign-in's own time (GoTrue's last_sign_in_at) — the once-per-sign-in key.
 */
export async function recordLogin(
  input: { userId: string; headers: Headers | null | undefined; method: LoginMethod; signedInAt?: string | null },
  store?: LoginLogStore,
): Promise<"recorded" | "duplicate" | "no-tenant" | "failed"> {
  try {
    const db = store ?? adminStore();
    // Same rule as log_activity (R-1615): no company or deactivated → nothing is written.
    const user = await db.userOf(input.userId);
    const tenantId = user?.tenant_id && user.is_active !== false ? user.tenant_id : null;
    if (!tenantId) return "no-tenant";
    const row = loginRow({
      userId: input.userId,
      tenantId,
      headers: input.headers,
      method: input.method,
      signedInAt: input.signedInAt ?? new Date().toISOString(),
    });
    const err = await db.insert(row);
    if (!err) return "recorded";
    if (err.code === "23505") return "duplicate";
    console.warn("[login-log] sign-in not recorded:", err.message);
    return "failed";
  } catch (e) {
    console.warn("[login-log] sign-in not recorded:", (e as Error)?.message);
    return "failed";
  }
}
