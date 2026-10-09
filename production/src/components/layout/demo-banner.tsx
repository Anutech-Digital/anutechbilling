"use client";

/**
 * R-524: the strip a "Try the demo" visitor sees on every app page, and the friendly message
 * when they try to change something.
 *
 * Renders nothing unless the ros_demo cookie is there (set only by /api/demo/session). The
 * cookie is NOT what keeps the demo read-only — the database and the middleware do that
 * (lib/demo/demo-account.ts). This only explains it: a refused request (403 with
 * x-demo-readonly from the middleware, or PostgREST's 25006 "read-only transaction") shows
 * "This is a demo — sign up to do this." instead of a raw error.
 */
import * as React from "react";
import { toast } from "sonner";
import { DEMO_COOKIE, DEMO_REFUSAL, DEMO_REFUSAL_HEADER, isReadOnlyRefusal } from "@/lib/demo/demo-account";

function hasDemoCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((c) => c.trim().startsWith(`${DEMO_COOKIE}=`) && c.trim().length > DEMO_COOKIE.length + 1);
}

function sayDemo() {
  toast.info(DEMO_REFUSAL, { id: "demo-readonly", description: "Nothing in the demo can be changed, sent or exported." });
}

export function DemoBanner() {
  const [on, setOn] = React.useState(false);

  React.useEffect(() => {
    if (!hasDemoCookie()) return;
    setOn(true);
    const original = window.fetch;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await original(...args);
      if (res.ok) return res;
      if (res.headers.get(DEMO_REFUSAL_HEADER) === "1") {
        sayDemo();
      } else if (supabaseUrl && res.url.startsWith(supabaseUrl)) {
        const body: unknown = await res.clone().json().catch(() => null);
        if (isReadOnlyRefusal(body)) sayDemo();
      }
      return res;
    };
    return () => { window.fetch = original; };
  }, []);

  if (!on) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber bg-amber-soft px-4 py-2 text-sm text-amber-ink"
    >
      <span>
        <b>Demo workspace</b> — sample data, read-only. Nothing you do here is saved or sent.
      </span>
      <span className="flex gap-2">
        <form action="/api/demo/end?next=/signup" method="post">
          <button type="submit" className="min-h-9 rounded-md bg-amber px-3 font-medium text-white hover:bg-amber/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber">
            Sign up free
          </button>
        </form>
        <form action="/api/demo/end" method="post">
          <button type="submit" className="min-h-9 rounded-md border border-amber px-3 font-medium hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber">
            Exit demo
          </button>
        </form>
      </span>
    </div>
  );
}
