/**
 * Read / switch the public website's theme (Settings → Branding, owner of the website's
 * workspace only). Talks to /api/settings/website-theme, which decides who may see and use it.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { toastError } from "@/lib/errors/toast-error";
import { WEBSITE_THEME_LABELS, parseWebsiteTheme, type WebsiteTheme } from "@/lib/website-theme";

const KEY = ["website-theme"] as const;

export interface WebsiteThemeState {
  /** False for everyone except the owner of the website's workspace — the card stays hidden. */
  visible: boolean;
  /** False until the database has the column (or when the saved value is unreadable). */
  ready: boolean;
  theme: WebsiteTheme | null;
  error: string | null;
}

export function useWebsiteTheme() {
  return useQuery({
    queryKey: KEY,
    staleTime: 30_000,
    queryFn: async (): Promise<WebsiteThemeState> => {
      const res = await fetch("/api/settings/website-theme", { credentials: "same-origin", cache: "no-store" });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) throw new Error(`Could not read the website theme (HTTP ${res.status}). Reload the page.`);
      return {
        visible: body.visible === true,
        ready: body.ready === true,
        theme: parseWebsiteTheme(body.theme),
        error: typeof body.error === "string" ? body.error : null,
      };
    },
  });
}

export function useSetWebsiteTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (theme: WebsiteTheme): Promise<WebsiteTheme> => {
      const res = await fetch("/api/settings/website-theme", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; theme?: unknown; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error ?? `The theme was not saved (HTTP ${res.status}). Try again.`);
      const saved = parseWebsiteTheme(body.theme);
      if (!saved) throw new Error("The server answered without a theme. Reload Settings to see what is saved.");
      return saved;
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(`Website switched to ${WEBSITE_THEME_LABELS[saved].name}`, {
        description: "Visitors see it on their next page load. You can switch back any time.",
      });
    },
    onError: (err) => toastError(err),
  });
}
