/**
 * A PostgREST-compatible request handler running on Prisma — so every existing
 * `supabase.from(...)` / `supabase.rpc(...)` call keeps working when the VM's PostgREST is
 * switched off. Same URLs, headers, status codes, JSON and error shapes as PostgREST v12.2.3
 * (what production runs), checked side by side against a real PostgREST in
 * tests/isolation/postgrest-parity.test.ts.
 *
 * WHO the request runs as is decided by the caller (route.ts / the server clients) from the
 * verified session — never from anything in the request. RLS then does what it always did.
 */
import "server-only";
import { withIdentity, type Identity } from "@/server/db/gateway";
import { getCatalog } from "./catalog";
import { buildDelete, buildInsert, buildRead, buildRpc, buildUpdate, type Built } from "./build";
import { PgrstError, parseAccept, parsePrefer, parseQuery } from "./parse";

export interface GatewayRequest {
  method: string;
  /** Path after /rest/v1/, e.g. "leads" or "rpc/record_payment". */
  path: string;
  search: URLSearchParams;
  headers: Headers;
  body: string | null;
}

const JSON_TYPE = "application/json; charset=utf-8";

function errorResponse(e: PgrstError): Response {
  return new Response(JSON.stringify({ code: e.code, details: e.details, hint: e.hint, message: e.message }), {
    status: e.status, headers: { "Content-Type": JSON_TYPE },
  });
}

/** SQLSTATE → HTTP status, as PostgREST maps them. */
function statusFor(code: string, anon: boolean): number {
  if (code === "42501") return anon ? 401 : 403;
  if (code === "23503" || code === "23505") return 409;
  if (code === "42883" || code === "42P01") return 404;
  if (code === "25006") return 405;
  if (code.startsWith("08") || code === "53300" || code === "57P01") return 503;
  if (code === "57014") return 500;
  if (/^(22|23|42|2F|P0|0L|0P)/.test(code)) return 400;
  return 500;
}

/** Pull SQLSTATE / message / detail / hint out of whatever the Prisma adapter threw. */
export function asPgrstError(e: unknown, anon: boolean): PgrstError {
  if (e instanceof PgrstError) return e;
  const err = (e ?? {}) as Record<string, unknown> & { meta?: Record<string, unknown>; cause?: unknown };
  const candidates = [err.meta?.driverAdapterError, (err.meta?.driverAdapterError as Record<string, unknown> | undefined)?.cause, err.cause, err.meta, err]
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  for (const c of candidates) {
    const code = String(c.originalCode ?? (typeof c.code === "string" ? c.code : ""));
    // A SQLSTATE — but not one of Prisma's own codes (P1xxx/P2xxx/P3xxx); P0xxx are PL/pgSQL's.
    if (/^[0-9A-Z]{5}$/.test(code) && !/^P[1-9][0-9]{3}$/.test(code)) {
      const message = String(c.originalMessage ?? c.message ?? err.message ?? "");
      return new PgrstError(statusFor(code, anon), code, message, (c.detail as string | undefined) ?? null, (c.hint as string | undefined) ?? null);
    }
  }
  return new PgrstError(500, "PGRST000", String(err.message ?? "Internal error"));
}

class Rollback extends Error {
  constructor(readonly response: PgrstError) { super(response.message); }
}

function build(req: GatewayRequest, cat: Awaited<ReturnType<typeof getCatalog>>): { built: Built; write: boolean; status: number } {
  const method = req.method.toUpperCase();
  const prefer = parsePrefer(req.headers.get("prefer"));
  const accept = parseAccept(req.headers.get("accept"));
  const isRpc = req.path.startsWith("rpc/");
  const name = isRpc ? req.path.slice(4) : req.path;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new PgrstError(404, "PGRST125", "Invalid path specified in request URL");
  const body: unknown = req.body ? JSON.parse(req.body) : undefined;

  if (isRpc) {
    let args: Record<string, unknown> = {};
    let skip = new Set<string>();
    if (method === "GET" || method === "HEAD") {
      const fnArgs = new Set((cat.functions.get(name) ?? []).flatMap((f) => f.args.map((a) => a.name)));
      for (const [k, v] of req.search) if (fnArgs.has(k)) args[k] = v;
      skip = new Set(Object.keys(args));
    } else if (method === "POST") {
      if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body))) {
        throw new PgrstError(400, "PGRST102", "Empty or invalid json");
      }
      args = (body ?? {}) as Record<string, unknown>;
    } else {
      throw new PgrstError(405, "PGRST101", "Only GET and POST are allowed for functions");
    }
    return { built: buildRpc(cat, name, args, parseQuery(req.search, skip), { stripNulls: accept.stripNulls, count: Boolean(prefer.count) }), write: false, status: 200 };
  }
  const pq = parseQuery(req.search);
  switch (method) {
    case "GET":
    case "HEAD":
      return { built: buildRead(cat, name, pq, { count: Boolean(prefer.count), stripNulls: accept.stripNulls }), write: false, status: 200 };
    case "POST":
      return { built: buildInsert(cat, name, pq, prefer, body, accept.stripNulls), write: true, status: 201 };
    case "PATCH":
      return { built: buildUpdate(cat, name, pq, prefer, body, accept.stripNulls), write: true, status: 200 };
    case "DELETE":
      return { built: buildDelete(cat, name, pq, prefer, accept.stripNulls), write: true, status: 200 };
    default:
      throw new PgrstError(405, "PGRST117", `Unsupported HTTP method: ${method}`);
  }
}

export async function handlePostgrest(req: GatewayRequest, identity: Identity): Promise<Response> {
  const anon = identity.mode === "anon";
  const method = req.method.toUpperCase();
  try {
    const cat = await getCatalog();
    const prefer = parsePrefer(req.headers.get("prefer"));
    const accept = parseAccept(req.headers.get("accept"));
    const { built, write, status: okStatus } = build(req, cat);
    const representation = !write || prefer.return === "representation";

    const result = await withIdentity(identity, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ body: string | null; n: number }[]>(built.sql, ...built.params);
      const text = rows[0]?.body ?? (built.shape === "array" ? "[]" : "null");
      const n = Number(rows[0]?.n ?? 0);
      let total: number | undefined;
      if (built.countSql) {
        const c = await tx.$queryRawUnsafe<{ total: number }[]>(built.countSql, ...(built.countParams ?? []));
        total = Number(c[0]?.total ?? 0);
      }
      // One object requested but 0 or 2+ rows: refused — and a write is rolled back, as PostgREST does.
      if (accept.single && built.shape === "array" && representation && n !== 1) {
        throw new Rollback(new PgrstError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned",
          `The result contains ${n} rows`));
      }
      return { text, n, total };
    });

    const headers = new Headers({ "Content-Type": JSON_TYPE });
    if (write) {
      headers.set("Content-Range", `*/${prefer.count ? result.n : "*"}`);
      if (!representation) return new Response(null, { status: method === "POST" ? 201 : 204, headers });
    } else if (built.shape === "array") {
      const t = result.total === undefined ? "*" : String(result.total);
      headers.set("Content-Range", result.n > 0 ? `${built.offset}-${built.offset + result.n - 1}/${t}` : `*/${t}`);
    }
    let status = okStatus;
    if (!write && result.total !== undefined && result.n > 0 && (built.offset > 0 || built.offset + result.n < result.total)) status = 206;
    if (method === "HEAD") return new Response(null, { status, headers });
    const text = accept.single && built.shape === "array" ? JSON.stringify(JSON.parse(result.text)[0] ?? null) : result.text;
    return new Response(text, { status, headers });
  } catch (e) {
    if (e instanceof Rollback) return errorResponse(e.response);
    if (e instanceof SyntaxError) return errorResponse(new PgrstError(400, "PGRST102", "Empty or invalid json", e.message));
    return errorResponse(asPgrstError(e, anon));
  }
}
