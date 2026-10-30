/**
 * R-2125 (GP-10, 30 Oct 2026) — the data gateway is DENY-BY-DEFAULT for personal sessions.
 *
 * ══ THE HOLE ═══════════════════════════════════════════════════════════════════════════════
 *   GP-07b (R-2116) closed /api/* to a personal login in middleware, but /api/sb/rest/v1 — the
 *   browser's way to the database — is allowlisted there (supabase-js needs it). Through it a
 *   personal session could still call any table or RPC its grants allow (rpc/generate_invoice,
 *   tenants?select=*,customers(*)), with RLS the only lock left. A free personal account is the
 *   many-user, anyone-can-sign-up case, so it gets a list, not a blocklist.
 *
 * ══ WHO IS "PERSONAL" ══════════════════════════════════════════════════════════════════════
 *   users.role = 'personal' OR the user's tenants.workspace_kind = 'personal' (gatewayRole in
 *   gateway-limits.ts reads both; R-2110). Either one is enough — the stricter answer wins.
 *
 * ══ THE LIST ═══════════════════════════════════════════════════════════════════════════════
 *   PERSONAL_TABLES — table → methods. The personal money tables (RLS: owner_user_id =
 *   auth.uid()) take every method; users / tenants are read-only (the app shell and the vault's
 *   requireIdentity read the caller's own row and workspace); notifications read + mark-read.
 *   PERSONAL_RPCS — personal_* RPCs and the sidebar's get_my_tenant_with_parent.
 *   Embeds (`select=...,customers(*)`) are walked at every depth with parseSelect: the gateway
 *   builder (build.ts) resolves an embed by its exact relation name, so that name must be on
 *   PERSONAL_TABLES too. A select the parser cannot read is refused (we cannot tell what it names).
 *
 * ══ APPEND-ONLY + RATCHET ══════════════════════════════════════════════════════════════════
 *   personal-allowlist.test.ts scans supabase/migrations for `function public.personal_*` and
 *   for functions tagged `-- personal-rpc` (on the create line, the line above it, or as
 *   `-- personal-rpc: name, name`) and fails when one is not on PERSONAL_RPCS. So the card that
 *   adds a personal RPC (GP-12b, GP-14, GP-15, GP-16b, GP-22) appends it here in the same commit
 *   and no page ships with a call the gateway refuses. Entries are never removed (a page breaks):
 *   the test pins a baseline.
 *
 *   Deliberately NOT on the list: personal_vault_pin (PIN hash — /api/vault/personal/pin only),
 *   personal_identity_link (read through the personal_my_* RPCs), nav_badges and the attendance
 *   RPCs (business counts / punches — a personal workspace has none; refused calls just leave
 *   the badge / reminder empty).
 *
 * ══ LOCALHOST PROOF ════════════════════════════════════════════════════════════════════════
 *   The gateway answers only with DATA_GATEWAY=1 (else /api/sb/rest/v1 is a 404 "data gateway
 *   is off" and the browser talks to local PostgREST directly), and it queries through Prisma as
 *   app_runtime — so run it under `npm run dev:local` (scripts/dev-local.mjs creates the
 *   app_runtime/app_jobs logins and sets DATABASE_URL) with DATA_GATEWAY=1 and
 *   NEXT_PUBLIC_DATA_GATEWAY=1: production/.claude/launch.json "ResellerOS local + data gateway
 *   (R-2125)", or in Git Bash `DATA_GATEWAY=1 NEXT_PUBLIC_DATA_GATEWAY=1 npm run dev:local`.
 *   Signed in as a personal user, POST /api/sb/rest/v1/rpc/generate_invoice → 403 ROS_PERSONAL
 *   with a `gateway_refused` … "reason":"personal" line in the server log, and
 *   GET /api/sb/rest/v1/personal_accounts?select=* → 200.
 */
import { parseSelect, type SelectItem } from "./parse";
import type { GatewayRefusal } from "./gateway-limits";

type Method = "GET" | "HEAD" | "POST" | "PATCH" | "DELETE";
const ALL: readonly Method[] = ["GET", "HEAD", "POST", "PATCH", "DELETE"];
const READ: readonly Method[] = ["GET", "HEAD"];

/** Tables (and views) a personal session may reach, with the methods. Append only. */
export const PERSONAL_TABLES: Readonly<Record<string, readonly Method[]>> = {
  personal_accounts: ALL,
  personal_transactions: ALL,
  personal_holdings: ALL,
  personal_categories: ALL,
  personal_category_rules: ALL,
  personal_import_batches: ALL,
  users: READ,
  tenants: READ,
  notifications: ["GET", "HEAD", "PATCH"],
};

/** RPCs a personal session may call (GET or POST rpc/<name>). Append only — see the ratchet. */
export const PERSONAL_RPCS: readonly string[] = [
  "personal_import_commit",        // GP-12b (R-2121) statement import
  "personal_my_invoices",          // GP-16b (R-2132) linked Anutech customer's bills
  "personal_my_quotes",
  "personal_my_payments",
  "personal_my_subscriptions",
  "get_my_tenant_with_parent",     // Sidebar workspace name (own tenant only, R-1615 gate)
];

function refuse(what: string): GatewayRefusal {
  return {
    status: 403, code: "ROS_PERSONAL", reason: "personal",
    message: `Not available for personal accounts (${what}). Upgrade to a business account to use it.`,
  };
}

/** First embedded relation (any depth) that is not on PERSONAL_TABLES. */
function blockedEmbed(items: SelectItem[]): string | null {
  for (const i of items) {
    if (i.kind !== "embed") continue;
    if (!Object.hasOwn(PERSONAL_TABLES, i.relation)) return i.relation;
    const deeper = blockedEmbed(i.items);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * May a personal caller make this request? `path` is what follows /rest/v1/ ("personal_accounts",
 * "rpc/personal_my_invoices"). null = go ahead; otherwise a 403 refusal.
 */
export function checkPersonalRequest(method: string, path: string, search: URLSearchParams): GatewayRefusal | null {
  const m = method.toUpperCase();
  if (path.startsWith("rpc/")) {
    const fn = path.slice(4);
    if (!PERSONAL_RPCS.includes(fn)) return refuse(fn);
  } else {
    const allowed = Object.hasOwn(PERSONAL_TABLES, path) ? PERSONAL_TABLES[path] : undefined;
    if (!allowed) return refuse(path);
    if (!allowed.includes(m as Method)) return refuse(`${m} ${path}`);
  }
  if (!search.has("select")) return null;
  let items: SelectItem[];
  try {
    items = parseSelect(search.get("select"));
  } catch {
    return refuse("this select");
  }
  const embed = blockedEmbed(items);
  return embed ? refuse(embed) : null;
}

/* ── the ratchet's scan (used by personal-allowlist.test.ts) ─────────────────────────────── */

const CREATE_FN = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/i;

/** Every personal RPC the migrations define: personal_* functions and `-- personal-rpc` tags. */
export function personalRpcsInMigrations(files: { name: string; sql: string }[]): string[] {
  const out = new Set<string>();
  for (const { sql } of files) {
    const lines = sql.split(/\r?\n/);
    lines.forEach((line, i) => {
      const named = /--\s*personal-rpc:\s*([a-z0-9_,\s]+)$/i.exec(line);
      if (named) for (const n of named[1].split(",")) if (n.trim()) out.add(n.trim().toLowerCase());
      const fn = CREATE_FN.exec(line);
      if (!fn) return;
      const name = fn[1].toLowerCase();
      const tagged = /--\s*personal-rpc\s*$/i.test(line) || /^\s*--\s*personal-rpc\s*$/i.test(lines[i - 1] ?? "");
      if (name.startsWith("personal_") || tagged) out.add(name);
    });
  }
  return [...out].sort();
}
