/**
 * Workspace tabs — the React layer over the two state machines.
 *
 * All the decisions live in `lib/workspace/tabs.ts` and `lib/workspace/history.ts`,
 * which are pure and tested. This file does only the things that need a browser:
 * persistence, the browser history calls, the keyboard, and the confirm dialog.
 *
 * ─── WHY sessionStorage AND NOT localStorage ─────────────────────────────────
 * sessionStorage is scoped to one BROWSER tab. That is exactly right here: two
 * browser windows are two separate workspaces, and localStorage would have them
 * overwriting each other's open tabs and drafts — the sort of bug that looks like
 * the app randomly losing work.
 *
 * It does mean a draft survives a reload, which is the point, and that draft
 * values (a half-typed quote, a customer's details) sit in sessionStorage until
 * the browser tab closes. That is a deliberate trade: the alternative is losing
 * someone's work every time they refresh.
 *
 * ─── Ctrl+W AND Ctrl+Tab ARE NOT OURS TO TAKE ────────────────────────────────
 * The brief asked for both. Chrome, Edge and Firefox refuse `preventDefault` on
 * them in a normal browser tab — binding Ctrl+W would mean the browser closes the
 * whole window, taking every open draft with it. The manifest sets
 * `display: standalone`, so in an INSTALLED PWA they can sometimes be caught.
 *
 * So both are attempted (harmless where blocked) AND real alternatives ship
 * alongside, which is the only version that works everywhere:
 *
 *   Alt+1 … Alt+8      jump to a tab by position
 *   Ctrl+Alt+→ / ←     next / previous tab
 *   Ctrl+Alt+W         close the current tab
 */
"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useConfirm } from "./confirm-provider";
import {
  tabsReducer, forceClose, tabIdFor, emptyTabs, MAX_TABS,
  type TabsState, type TabsAction, type WorkspaceTab,
} from "@/lib/workspace/tabs";
import {
  seekTo, resolvePopState, historyOpFor,
  type TabHistory,
} from "@/lib/workspace/history";
import { recordAddress, urlForTabSwitch } from "@/lib/workspace/address-sync";
import { hasDirtyForm } from "@/lib/hooks/dirty-forms";

const STORAGE_KEY = "ros.workspace.tabs.v1";

interface Persisted {
  tabs: TabsState;
  histories: Record<string, TabHistory>;
}

interface WorkspaceTabsApi {
  tabs: WorkspaceTab[];
  activeId: string | null;
  open: (url: string, title: string, icon?: string) => void;
  activate: (id: string) => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  /** Mark the active tab dirty (or clean) and stash what was typed. */
  setDraft: (id: string, isDraft: boolean, formState?: Record<string, unknown>) => void;
  rename: (id: string, title: string) => void;
  /** Values previously stashed for a tab, for a form to restore from. */
  draftFor: (id: string) => Record<string, unknown> | undefined;
  /** True while a tab switch is still resolving. Exists because without it a
   *  slow route makes a working tab strip look broken: the highlight moves
   *  instantly and the page arrives seconds later, so the user concludes
   *  nothing happened and clicks again. */
  isNavigating: boolean;
}

const Ctx = React.createContext<WorkspaceTabsApi | null>(null);

export function useWorkspaceTabs(): WorkspaceTabsApi {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useWorkspaceTabs must be used inside <WorkspaceTabsProvider>");
  return ctx;
}

/**
 * A readable tab title for a path.
 *
 * NOT `document.title`: every page here is titled "ResellerOS — …", so the adopted
 * tab came out labelled "ResellerOS", which tells the reader nothing and is
 * identical for every tab. Seen in the browser, not in a test.
 *
 * The page's own <h1> is preferred because it is what the user is looking at; the
 * prettified path is the fallback.
 */
function titleForPath(pathname: string): string {
  if (typeof document !== "undefined") {
    const h1 = document.querySelector("h1")?.textContent?.trim();
    if (h1 && h1.length <= 40) return h1;
  }
  const last = pathname.split("?")[0].split("/").filter(Boolean).pop() ?? "";
  if (!last) return "Home";
  // "/accounting/saas-metrics" → "Saas metrics"; an id segment stays as-is.
  const words = last.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Safe read — a corrupt or foreign payload must not take the app down on boot. */
function loadPersisted(): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed || !Array.isArray(parsed.tabs?.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function WorkspaceTabsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const confirm = useConfirm();
  // startTransition keeps the click responsive AND gives us isNavigating,
  // which is the only way the strip can admit it is still working.
  const [isNavigating, startNavigation] = React.useTransition();

  const [state, setState] = React.useState<TabsState>(emptyTabs);
  const [histories, setHistories] = React.useState<Record<string, TabHistory>>({});
  const hydrated = React.useRef(false);

  // Refs so the popstate and keyboard listeners always see current values without
  // being torn down and rebuilt on every state change.
  const stateRef = React.useRef(state);
  const historiesRef = React.useRef(histories);
  stateRef.current = state;
  historiesRef.current = histories;

  // ── Hydrate once ────────────────────────────────────────────────────────
  React.useEffect(() => {
    const saved = loadPersisted();
    if (saved) {
      /* R-490: no form survives a reload (useDraftGuard stashes no values), so a restored
         draft flag would guard nothing and still nag on tab close. Start clean. */
      saved.tabs = { ...saved.tabs, tabs: saved.tabs.tabs.map((t) => (t.isDraft ? { ...t, isDraft: false, formState: undefined } : t)) };
      setState(saved.tabs);
      setHistories(saved.histories ?? {});
      // The adopt and record effects below run in this same pass and read the refs; left
      // stale they saw an empty workspace, and adopt overwrote the saved tabs.
      stateRef.current = saved.tabs;
      historiesRef.current = saved.histories ?? {};
    }
    hydrated.current = true;
  }, []);

  // ── Persist ─────────────────────────────────────────────────────────────
  React.useEffect(() => {
    // Skipped until hydration finishes, or the initial empty state would
    // immediately overwrite a perfectly good saved workspace.
    if (!hydrated.current) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: state, histories }));
    } catch {
      // Quota exceeded, or storage disabled. Tabs still work for this session;
      // failing the whole provider over persistence would be worse.
    }
  }, [state, histories]);

  const dispatch = React.useCallback((action: TabsAction) => {
    const result = tabsReducer(stateRef.current, action);
    if (result.needsConfirm) {
      const { kind, tabId, message } = result.needsConfirm;
      void confirm({
        title: kind === "close_draft" ? "Unsaved changes" : "All tabs have unsaved changes",
        body: message,
        confirmLabel: kind === "close_draft" ? "Close anyway" : "OK",
        danger: kind === "close_draft",
      }).then((ok) => {
        if (ok && kind === "close_draft" && tabId) {
          setState((s) => forceClose(s, tabId));
        }
      });
      return;
    }
    setState(result.state);
  }, [confirm]);

  // ── Keep the URL in step with the active tab ────────────────────────────
  // R-068: ONLY on a genuine switch of the active tab. This used to replace to the stored
  // history cursor on hydration and on every tabs-array change, which navigated users off the
  // page they had just opened (/leads → /renewals, repeatedly). See lib/workspace/address-sync.
  const prevActiveId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!hydrated.current) return;
    const prev = prevActiveId.current;
    prevActiveId.current = state.activeId;
    const target = urlForTabSwitch(
      prev, stateRef.current, historiesRef.current,
      window.location.pathname + window.location.search,
    );
    if (!target) return;
    // replace, not push: switching tabs must not add a history entry. That single
    // choice is what makes Back mean "the previous page in this tab".
    //
    // router.replace, NOT window.history.replaceState. The raw History API was
    // the original implementation and it is why clicking a tab appeared to do
    // nothing: it rewrites the address bar without telling the App Router, so
    // the URL and the highlighted tab both changed while the page underneath
    // stayed exactly where it was. Every tab switch was cosmetic.
    if (historyOpFor("tab_switch") === "replace") {
      startNavigation(() => {
        router.replace(target as never);
      });
    }
  }, [state.activeId, state.tabs, router]);

  // ── Browser Back / Forward ──────────────────────────────────────────────
  React.useEffect(() => {
    const onPop = () => {
      const url = window.location.pathname + window.location.search;
      const outcome = resolvePopState(url, stateRef.current.activeId, historiesRef.current);

      if (outcome.kind === "left_workspace") return;   // let the browser have it

      if (outcome.kind === "switch_tab") {
        // Back has run out of this tab's history and walked into another's. It is
        // followed rather than fought: cancelling would leave Back doing nothing,
        // which is how people stop trusting an app.
        dispatch({ type: "activate", id: outcome.tabId, at: Date.now() });
      }

      setHistories((h) => {
        const target = h[outcome.tabId];
        if (!target) return h;
        const moved = seekTo(target, outcome.url);
        return moved ? { ...h, [outcome.tabId]: moved } : h;
      });
      router.replace(outcome.url as never);
    };

    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [dispatch, router]);

  /**
   * The address as it actually is, QUERY STRING INCLUDED.
   *
   * ─── WHY THIS FUNCTION EXISTS ─────────────────────────────────────────────────
   * Both effects below used to record `pathname` alone. The URL-sync effect above then
   * replaced the address bar with whatever they had recorded — so **every query string in
   * the app was silently deleted a moment after arriving.** Not ignored: deleted, by a
   * `router.replace` the user never asked for.
   *
   * The damage was invisible because it looked like a form that had not been filled in.
   * `/quotes/new?leadId=L-MT6S9CNF` became `/quotes/new`, so the builder's `isLeadMode` was
   * false, `lead_id` was written as NULL, and the quote was never attached to the lead at
   * all. That is the true cause of Darshan's report on 24 Aug: not the stage rule (which was
   * genuinely missing at three of four senders and is now fixed), but that there was no lead
   * on the quote for any stage rule to move. Measured, not reasoned: the network log shows
   * `GET /quotes/new?leadId=L-MT6S9CNF&company=Saroj%20Tech → 200` with no redirect, and
   * `window.location.href` reading `/quotes/new` immediately afterwards.
   *
   * ─── WHY window.location AND NOT useSearchParams() ────────────────────────────
   * `Providers` is mounted in the ROOT layout (app/layout.tsx:95), which wraps the static
   * marketing page as well as the app. `useSearchParams()` there would force that page
   * dynamic and fail the build. Both callers are effects gated on `hydrated.current`, so
   * they only ever run in a browser, where window.location is the more direct truth anyway.
   *
   * The popstate handler at line ~206 already did this correctly — `pathname + search`. One
   * of the three readers of the current URL got it right and the other two did not, which is
   * the same shape as the bug this was found while fixing (AGENTS.md L98).
   */
  const fullPath = React.useCallback(
    () => (typeof window === "undefined" ? pathname : pathname + window.location.search),
    [pathname],
  );

  // ── Adopt the page you are already on ───────────────────────────────────
  // Without this the workspace starts empty: tabs only appeared via Ctrl+click, so
  // the very first one had nothing to sit beside and the strip never showed. The
  // page in front of you IS a tab; it just had not been told so.
  React.useEffect(() => {
    if (!hydrated.current || !pathname) return;
    if (stateRef.current.tabs.length > 0) return;
    dispatch({ type: "open", url: fullPath(), title: titleForPath(pathname), at: Date.now() });
  }, [pathname, dispatch, fullPath]);

  // ── Record navigation inside the active tab ─────────────────────────────
  // R-068: keyed on the ADDRESS only. It was also keyed on state.activeId, so switching or
  // closing a tab pushed the old tab's url into the new tab's history — the source of the
  // alternating "/leads, /renewals, /leads…" stack. An address that is another open tab's
  // own page activates that tab instead of being filed under the active one.
  React.useEffect(() => {
    if (!hydrated.current || !pathname) return;
    const { activateId, histories: next } =
      recordAddress(stateRef.current, historiesRef.current, fullPath());
    if (next !== historiesRef.current) {
      historiesRef.current = next;
      setHistories(next);
    }
    if (activateId) dispatch({ type: "activate", id: activateId, at: Date.now() });
  }, [pathname, fullPath, dispatch]);

  // ── Warn before the browser window closes with unsaved work ─────────────
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // The one guard the in-app prompt cannot provide: closing the BROWSER tab
      // takes every workspace tab with it, drafts included.
      // R-490 (R-472): asks the MOUNTED forms, not the saved tab flags — a flag can outlive
      // its form (sessionStorage, reload), and then "Leave site?" popped on every page.
      if (!hasDirtyForm()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // ── Ctrl+click / middle-click an internal link → new workspace tab ──────
  React.useEffect(() => {
    const handle = (e: MouseEvent) => {
      const isMiddle = e.type === "auxclick" && (e as MouseEvent).button === 1;
      const isModified = e.type === "click" && (e.ctrlKey || e.metaKey);
      if (!isMiddle && !isModified) return;

      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href") ?? "";
      // INTERNAL links only. An external link, a mailto:, a download, or anything
      // with target="_blank" must keep its normal behaviour — hijacking those
      // would break "open this in a real browser tab", which people genuinely
      // want and would have no other way to do.
      if (!href.startsWith("/") || href.startsWith("//")) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      e.preventDefault();
      const title = (anchor.textContent ?? "").trim().slice(0, 40) || href;
      // background: true is load-bearing. Without it the new tab becomes active,
      // the URL-sync effect rewrites the address bar to the new page, and the
      // content stays on the old one — caught in the browser, not by a test.
      dispatch({ type: "open", url: href, title, at: Date.now(), background: true });
      // Deliberately NOT navigating: opening in a background tab is what a
      // modified click means everywhere else, and jumping the user away from what
      // they were reading is the opposite of what they asked for.
    };

    document.addEventListener("click", handle);
    document.addEventListener("auxclick", handle);
    return () => {
      document.removeEventListener("click", handle);
      document.removeEventListener("auxclick", handle);
    };
  }, [dispatch]);

  // ── Keyboard ────────────────────────────────────────────────────────────
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (s.tabs.length === 0) return;

      // Alt+1 … Alt+8 — position jump. Works in every browser.
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-8]$/.test(e.key)) {
        const tab = s.tabs[Number(e.key) - 1];
        if (tab) { e.preventDefault(); dispatch({ type: "activate", id: tab.id, at: Date.now() }); }
        return;
      }

      if (e.ctrlKey && e.altKey) {
        if (e.key === "ArrowRight") { e.preventDefault(); dispatch({ type: "cycle", direction: 1, at: Date.now() }); return; }
        if (e.key === "ArrowLeft")  { e.preventDefault(); dispatch({ type: "cycle", direction: -1, at: Date.now() }); return; }
        if (e.key.toLowerCase() === "w" && s.activeId) {
          e.preventDefault(); dispatch({ type: "close", id: s.activeId }); return;
        }
      }

      // The reserved ones, attempted. Blocked in a browser tab; sometimes caught
      // in the installed PWA. preventDefault is harmless where it is ignored, and
      // this is the only place they can possibly work.
      if (e.ctrlKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        dispatch({ type: "cycle", direction: e.shiftKey ? -1 : 1, at: Date.now() });
        return;
      }
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "w" && s.activeId) {
        e.preventDefault();
        dispatch({ type: "close", id: s.activeId });
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  // ── Stable callbacks ──────────────────────────────────────────────────────
  // These close over `dispatch` (itself stable) and refs only — never over
  // `state` — so each keeps ONE identity for the provider's whole life.
  //
  // They used to be defined inline in the `api` useMemo below, which rebuilt
  // every one of them whenever `state.tabs` changed identity. Any consumer with
  // an effect keyed on one of them therefore re-ran on every unrelated tab
  // change, and `useDraftGuard` — whose effect both depends on `setDraft` AND
  // calls it — turned that into an unbounded render loop (#185, "Maximum update
  // depth exceeded"). The reducer's no-op bailout now breaks that cycle too;
  // this half stops the whole class rather than the one instance, because the
  // next hook to depend on an api callback would have rediscovered it.
  const open = React.useCallback<WorkspaceTabsApi["open"]>((url, title, icon) => {
    dispatch({ type: "open", url, title, icon, at: Date.now() });
    router.push(url as never);
  }, [dispatch, router]);

  const activate = React.useCallback<WorkspaceTabsApi["activate"]>((id) => {
    dispatch({ type: "activate", id, at: Date.now() });
    const h = historiesRef.current[id];
    const url = h?.stack[h.cursor] ?? stateRef.current.tabs.find((t) => t.id === id)?.url;
    if (url) router.push(url as never);
  }, [dispatch, router]);

  const close = React.useCallback<WorkspaceTabsApi["close"]>(
    (id) => dispatch({ type: "close", id }), [dispatch]);
  const closeOthers = React.useCallback<WorkspaceTabsApi["closeOthers"]>(
    (id) => dispatch({ type: "closeOthers", id }), [dispatch]);
  const setDraft = React.useCallback<WorkspaceTabsApi["setDraft"]>(
    (id, isDraft, formState) => dispatch({ type: "setDraft", id, isDraft, formState }), [dispatch]);
  const rename = React.useCallback<WorkspaceTabsApi["rename"]>(
    (id, title) => dispatch({ type: "rename", id, title }), [dispatch]);
  const draftFor = React.useCallback<WorkspaceTabsApi["draftFor"]>(
    (id) => stateRef.current.tabs.find((t) => t.id === id)?.formState, []);

  const api: WorkspaceTabsApi = React.useMemo(() => ({
    tabs: state.tabs,
    activeId: state.activeId,
    isNavigating,
    open, activate, close, closeOthers, setDraft, rename, draftFor,
    // `isNavigating` MUST stay in this list. It was read here but missing from
    // the deps, so the value handed to consumers was whatever it had been when
    // tabs last changed — i.e. the "still working" bar on the tab strip was
    // driven by a stale flag and could simply never appear.
  }), [state.tabs, state.activeId, isNavigating,
       open, activate, close, closeOthers, setDraft, rename, draftFor]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export { MAX_TABS, tabIdFor };
