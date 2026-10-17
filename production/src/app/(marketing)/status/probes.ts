/**
 * R-1503 — the live probes behind the public /status page. Server only.
 *
 * Each probe answers one question cheaply and safely:
 *   database  — `select 1` through the app's own DB pool (pingDb). No tenant, no rows.
 *   payments  — Razorpay keys are set AND api.razorpay.com answers. An unauthenticated GET of
 *               the API root: no key is sent, no order or payment endpoint is touched.
 *   registrar — ResellerClub credentials are set AND the registrar API host answers. The
 *               request carries NO credentials (they would sit in the URL), so it costs nothing.
 *   email     — a platform sender is configured AND the SMTP server accepts a TCP connection
 *               (closed straight away — no mail is sent) / the Resend API host answers.
 *
 * A probe never returns an error message or a secret — only a state. Timeouts and "slow"
 * are decided by checks.ts, so every probe is just "did it work".
 */
import "server-only";
import { connect } from "node:net";
import { pingDb } from "@/server/db";
import { smtpConfigFromEnv } from "@/lib/email/smtp-transport";
import { rcConfigured } from "@/lib/resellerclub";

export type ProbeResult = { state: "ok" } | { state: "error" } | { state: "not-configured" };
export type ProbeKey = "database" | "payments" | "registrar" | "email";

const OK: ProbeResult = { state: "ok" };
const ERROR: ProbeResult = { state: "error" };
const NOT_CONFIGURED: ProbeResult = { state: "not-configured" };

const has = (v: string | undefined) => Boolean(v && v.trim());

/** Any HTTP answer below 500 means the service is up (401/404 for an unauthenticated GET is fine). */
async function reachable(url: string): Promise<ProbeResult> {
  const res = await fetch(url, { method: "GET", cache: "no-store", redirect: "manual" });
  // Drain nothing we do not need — the body of an API root is irrelevant.
  await res.body?.cancel().catch(() => {});
  return res.status < 500 ? OK : ERROR;
}

function tcpReachable(host: string, port: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (r: ProbeResult) => { socket.destroy(); resolve(r); };
    socket.setTimeout(3_000, () => done(ERROR));
    socket.once("connect", () => done(OK));
    socket.once("error", () => done(ERROR));
  });
}

async function database(): Promise<ProbeResult> {
  if (!has(process.env.DATABASE_URL)) return NOT_CONFIGURED;
  await pingDb();
  return OK;
}

async function payments(): Promise<ProbeResult> {
  if (!has(process.env.RAZORPAY_KEY_ID) || !has(process.env.RAZORPAY_KEY_SECRET)) return NOT_CONFIGURED;
  return reachable("https://api.razorpay.com/v1/");
}

async function registrar(): Promise<ProbeResult> {
  if (!rcConfigured()) return NOT_CONFIGURED;
  const base = (process.env.RESELLERCLUB_API_URL?.trim() || "https://httpapi.com").replace(/\/+$/, "");
  return reachable(`${base}/`);
}

async function email(): Promise<ProbeResult> {
  // Same rule as isEmailConfigured() in lib/email/send: SMTP first, else Resend.
  const smtp = smtpConfigFromEnv(process.env);
  if (smtp) return tcpReachable(smtp.host, smtp.port);
  if (has(process.env.RESEND_API_KEY)) return reachable("https://api.resend.com/");
  return NOT_CONFIGURED;
}

export const STATUS_PROBES: Record<ProbeKey, () => Promise<ProbeResult>> = {
  database,
  payments,
  registrar,
  email,
};
