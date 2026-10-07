/**
 * R-112: the owner's morning digest as an email body — subject, plain text and HTML from
 * ONE OwnerDigest, so the dry-run preview (?dryRun=1 on /api/cron/health-digest) shows
 * exactly what the 8 AM mail would say. Pure: no DB, no sender, no clock.
 *
 * HTML is deliberately plain (inline styles, one table, no images): mail clients strip
 * <style> blocks and block remote images, and a digest that only renders in one client
 * stops being read.
 */
import { inr, ownerDigestSubject, ownerDigestText, type OwnerDigest } from "./owner-digest";

export interface DigestEmail {
  subject: string;
  text: string;
  html: string;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Reasons come from ai_action_log (AI-written text) — never trust them as HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function link(appUrl: string, path: string): string {
  return appUrl ? `${appUrl.replace(/\/$/, "")}${path}` : path;
}

interface Row { label: string; value: string; detail: string; path: string; alert: boolean; notes?: string[] }

function rows(d: OwnerDigest): Row[] {
  return [
    {
      label: "Money in yesterday", value: inr(d.moneyIn.value),
      detail: `from ${plural(d.moneyIn.count, "payment")}`, path: "/payments", alert: false,
    },
    {
      label: "Overdue invoices", value: String(d.overdue.count),
      detail: `${inr(d.overdue.value)} still owed`, path: "/invoices?tab=overdue", alert: d.overdue.count > 0,
    },
    {
      label: "Waiting on you", value: String(d.waiting.total),
      detail: `${plural(d.waiting.held, "AI action")} held, ${plural(d.waiting.quotes, "quote")} to approve`,
      path: "/quotes", alert: d.waiting.total > 0, notes: d.waiting.examples.map((e) => e.slice(0, 140)),
    },
    {
      label: "Renewals in 30 days (or lapsed)", value: String(d.renewals.count),
      detail: `${inr(d.renewals.value)} MRR at stake`, path: "/subscriptions?tab=expiring", alert: d.renewals.count > 0,
    },
  ];
}

export function ownerDigestHtml(d: OwnerDigest, appUrl: string): string {
  const body = rows(d).map((r) => {
    const href = escapeHtml(link(appUrl, r.path));
    const color = r.alert ? "#b42318" : "#101828";
    const notes = (r.notes ?? [])
      .map((n) => `<div style="color:#475467;font-size:13px;margin-top:4px">&bull; ${escapeHtml(n)}</div>`)
      .join("");
    return (
      `<tr><td style="padding:12px 0;border-bottom:1px solid #eaecf0">` +
      `<div style="color:#475467;font-size:13px">${escapeHtml(r.label)}</div>` +
      `<div style="color:${color};font-size:22px;font-weight:600">${escapeHtml(r.value)}</div>` +
      `<div style="color:#475467;font-size:13px">${escapeHtml(r.detail)} &middot; <a href="${href}" style="color:#1d4ed8">Open</a></div>` +
      notes +
      `</td></tr>`
    );
  }).join("");
  return (
    `<!doctype html><html><body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;background:#ffffff">` +
    `<div style="max-width:560px;margin:0 auto">` +
    `<p style="color:#101828;font-size:15px;margin:0 0 8px">Good morning. Your day at a glance ` +
    `(${escapeHtml(d.day)} = yesterday, IST).</p>` +
    `<table role="presentation" style="width:100%;border-collapse:collapse">${body}</table>` +
    `</div></body></html>`
  );
}

/** Everything the 8 AM mail would carry — the preview and the real send use this one function. */
export function buildDigestEmail(d: OwnerDigest, appUrl: string): DigestEmail {
  return { subject: ownerDigestSubject(d), text: ownerDigestText(d, appUrl), html: ownerDigestHtml(d, appUrl) };
}
