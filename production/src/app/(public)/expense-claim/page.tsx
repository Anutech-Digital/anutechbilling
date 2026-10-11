/**
 * Public expense-claim form — /expense-claim?tid=<tenant>&exp=<unix>&sig=<hmac>
 *
 * An employee opens this link (WhatsApp), picks their name, enters their
 * attendance PIN, and logs what they spent from their expense advance. The
 * submission creates a PENDING claim; the owner approves it in-app before it
 * touches the books. No login — the HMAC token routes to the right reseller
 * and the PIN authenticates the employee (both verified server-side).
 */
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/server";
import { claimTokenError, claimTokenStatus } from "@/lib/claim-token";
import { ExpenseClaimClient } from "./expense-claim-client";

export const metadata: Metadata = {
  title: "Submit an expense",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ExpenseClaimPage(
  props: {
    searchParams: Promise<{ tid?: string; sig?: string; exp?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const tid = (searchParams.tid ?? "").trim();
  const sig = (searchParams.sig ?? "").trim();
  const exp = (searchParams.exp ?? "").trim();
  const linkStatus = claimTokenStatus(tid, sig, exp);

  if (linkStatus !== "ok") {
    return <ExpenseClaimError message={claimTokenError(linkStatus)} />;
  }

  const admin = createAdminClient();
  const [{ data: tenant }, { data: employees }] = await Promise.all([
    admin.from("tenants").select("name").eq("id", tid).maybeSingle(),
    admin.from("employees").select("id, name").eq("tenant_id", tid).eq("is_active", true).order("name"),
  ]);

  if (!tenant) {
    return <ExpenseClaimError message="We couldn't find this business. Please ask the office for a fresh link." />;
  }

  return (
    <ExpenseClaimClient
      tid={tid}
      sig={sig}
      exp={exp}
      brandName={tenant.name}
      employees={(employees ?? []).map((e) => ({ id: e.id, name: e.name }))}
    />
  );
}

function ExpenseClaimError({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-paper flex items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <div className="text-3xl mb-3">🔒</div>
        <h1 className="font-serif text-2xl text-ink mb-2">Link not valid</h1>
        <p className="text-sm text-ink-3">{message}</p>
      </div>
    </div>
  );
}
