/**
 * POST /api/dev/test-login  { role: "owner" | "manager" | "accountant" | "sales" }
 *
 * R-281: local-only sign-in as a seeded E2E test account. Rules and the why: ./rules.ts.
 * Anywhere but `npm run dev:local` on localhost it answers 404. The password is read here on
 * the server (env, else the E2E_* lines of the gitignored .env.test) and never sent back.
 */
import { NextResponse, type NextRequest } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@/lib/supabase/server";
import {
  testLoginAllowed, isTestLoginRole, testLoginCreds, e2eVarsFromEnvText,
} from "./rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

function e2eEnv(): Record<string, string | undefined> {
  const file = join(process.cwd(), ".env.test");
  const fromFile = existsSync(file) ? e2eVarsFromEnvText(readFileSync(file, "utf8")) : {};
  /* Existing env wins, as in playwright.config.ts. */
  return { ...fromFile, ...process.env };
}

export async function POST(request: NextRequest) {
  if (!testLoginAllowed({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    nodeEnv: process.env.NODE_ENV,
    host: request.headers.get("host"),
  })) return notFound();

  const body: unknown = await request.json().catch(() => null);
  const role = body && typeof body === "object" ? (body as { role?: unknown }).role : undefined;
  if (!isTestLoginRole(role)) {
    return NextResponse.json({ error: "Unknown test role." }, { status: 400 });
  }

  const { email, password } = testLoginCreds(role, e2eEnv());
  /* Test accounts only — the .test TLD can never be a real person's mailbox. */
  if (!email.endsWith(".test")) {
    return NextResponse.json({ error: `E2E_${role.toUpperCase()}_EMAIL is not a .test address — refusing.` }, { status: 400 });
  }
  if (!password) {
    return NextResponse.json(
      { error: `E2E_${role.toUpperCase()}_PASSWORD is not set (.env.test). Run the E2E seed first.` },
      { status: 412 },
    );
  }

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return NextResponse.json({ error: `Test ${role} could not sign in: ${error.message}` }, { status: 401 });
  }
  return NextResponse.json({ ok: true, role, email });
}
