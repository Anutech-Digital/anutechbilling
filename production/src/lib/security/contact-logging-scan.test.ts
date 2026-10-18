/**
 * R-1610 (19 Oct 2026): no server log line prints a customer's email or phone unmasked.
 *
 * Every SMTP send logged "[email/send] smtp sent to <full address>" — every invoice, reminder
 * and OTP mail put the recipient into Cloud Logging, where it stays for months and anyone with
 * a GCP viewer role can read it (DPDP). The fix is one helper, lib/security/redact-contact.ts
 * (maskEmail / maskPhone / maskContactValue / redactContacts), used at every such line.
 *
 * This scan reads every console.log/info/warn/error/debug call in the folders that handle
 * customer contact data and fails when an argument or a template `${…}` names an email/phone/
 * recipient value without passing it through a mask/redact call. Ids, statuses and counts
 * stay in the logs — they are what makes a failure diagnosable.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["src/lib/email", "src/lib/messaging", "src/lib/hosting", "src/app/api"];

/**
 * Known lines in folders other sessions own (R-1610 follow-up). Each entry is
 * "<file>|<variable>" — shrink this list, never grow it.
 */
const KNOWN: readonly string[] = [
  /* api/webhooks belongs to the webhooks worker this week; the masked line is a one-word change there. */
  "src/app/api/webhooks/whatsapp/route.ts|phone",
  "src/app/api/webhooks/razorpay/webhook.server.ts|to",
];

/** The last identifier of an expression names contact data. */
const CONTACT_NAME = /^(?:.*[._])?(e-?mail|emails|email_?address|customerEmail|toEmail|ownerEmail|phone|phones|mobile|msisdn|wa_?id|whatsapp(?:Number)?|recipient|recipients|to)$/i;
const MASKED = /\b(mask\w*|redact\w*)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/** Source of the call starting at `open` (index of "("), parens balanced, strings skipped. */
function callText(src: string, open: number): string {
  /* A stack of contexts: "(" / "{" brackets, "T" = inside a template's text, "S"/"D" quotes. */
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === "\\") i++;
      else if (c === top) stack.pop();
      continue;
    }
    if (top === "`") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && src[i + 1] === "{") { stack.push("${"); i++; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") stack.push(c);
    else if (c === "(" || c === "{") stack.push(c);
    else if (c === ")" || c === "}") {
      stack.pop();
      if (stack.length === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open, open + 400);
}

/** Expressions a log call prints: template ${…} parts and top-level bare identifiers/members. */
function printedExpressions(call: string): string[] {
  const out: string[] = [];
  for (const m of call.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) out.push(m[1].trim());
  const inner = call.slice(1, -1).replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "\"\"");
  for (const part of inner.split(",")) {
    const t = part.trim();
    if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/.test(t)) out.push(t);
  }
  return out;
}

export function unmaskedContactLogs(src: string): { line: number; expr: string }[] {
  const found: { line: number; expr: string }[] = [];
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, (m, p: string) => p + " ".repeat(m.length - p.length));
  for (const m of clean.matchAll(/console\.(?:log|info|warn|error|debug)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const call = callText(clean, open);
    for (const expr of printedExpressions(call)) {
      if (MASKED.test(expr)) continue;
      const last = expr.replace(/\?\./g, ".").split(/[^\w$]+/).filter(Boolean).pop() ?? "";
      const whole = expr.replace(/\?\./g, ".");
      if (CONTACT_NAME.test(last) || CONTACT_NAME.test(whole)) {
        found.push({ line: clean.slice(0, m.index).split("\n").length, expr });
      }
    }
  }
  return found;
}

describe("R-1610 — the scanner itself", () => {
  it("catches an unmasked recipient, in a template and as a bare argument", () => {
    expect(unmaskedContactLogs("console.info(`sent to ${msg.to} in 3 ms`);")).toHaveLength(1);
    expect(unmaskedContactLogs("console.error('failed for', lead.email, err);")).toHaveLength(1);
    expect(unmaskedContactLogs("console.warn(\n  `voice note from ${phone}: ${outcome.note}`,\n);")).toHaveLength(1);
  });
  it("lets masked values, ids and statuses through", () => {
    expect(unmaskedContactLogs("console.info(`sent to ${maskContactValue(msg.to)} in ${ms} ms`);")).toEqual([]);
    expect(unmaskedContactLogs("console.error(`[x] lead ${leadId}: ${res.status}`, err);")).toEqual([]);
    expect(unmaskedContactLogs("console.error('[x] email to owner failed:', r.reason);")).toEqual([]);
  });
});

describe("R-1610 — no unmasked customer email/phone in server logs", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  it("scans real files", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it("every console line that prints an email/phone/recipient masks it", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split(sep).join("/");
      for (const hit of unmaskedContactLogs(readFileSync(f, "utf8"))) {
        if (KNOWN.includes(`${rel}|${hit.expr}`)) continue;
        offenders.push(`${rel}:${hit.line} prints ${hit.expr} — wrap it in maskContactValue()/redactContacts() (lib/security/redact-contact.ts)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
