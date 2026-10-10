"use client";

/**
 * AI Help — a chat icon on every app page (R-158, 5 Oct 2026), now a test co-pilot (R-162).
 *
 * R-158: ask what a screen does or why something looks wrong; when the chat finds a bug, the
 * AI drafts a proper report, the person reads it and presses "File this report", and it lands
 * in Admin → Feedback under THEIR name, marked "🤖 AI-drafted after chat".
 *
 * R-162 ("testing ko fast aur fully automate karo, human intervention kam se kam"):
 *  • a TRAIL of this tab — pages, clicks, errors shown, JS errors, failed API calls — so the
 *    tester never writes steps; the AI writes them from the trail (lib/ai/test-trail.ts);
 *  • the button turns red the moment something breaks, and "Report it" drafts the report
 *    from the trail without a single typed word;
 *  • "Check this page" scans the screen (page-scan.ts) and the AI says what is really wrong
 *    plus what to test next on it;
 *  • a draft that looks like an open report says so before anyone files it twice.
 *
 * Nothing is filed without the person's press: the draft is shown in full first. The trail
 * and chat live only in this tab (memory, not storage); text is PII-masked before it is kept.
 */
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { toast } from "sonner";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useSubmitFeedback } from "@/lib/queries/feedback";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { maskPII } from "@/lib/ux/signals";
import { loadLastPageTestRun, lastTestedLine, summarizeRun, type PageTestRun } from "@/lib/ai/page-test-runs";
import { bugReportText, cleanSteps, AI_FILED_TAG, askAboutSelection, buildTestRunPrompt, type BugDraft, type HelpMessage, type HelpMode, type HelpAction } from "@/lib/ai/app-help";
import { pushTrail, isProblem, classifyToast, NEEDS_INPUT_CLASS, apiFailureWorthNoting, apiFailText, isInPageUrl, trailForPrompt, looksLikeSameBug, type TrailEvent, type TrailKind } from "@/lib/ai/test-trail";
import { scanPage } from "@/components/shared/page-scan";
import { IconButton } from "@/components/ui/button";
import { CropOverlay, HELP_SELF, captureViewport, toShot, type Shot } from "@/components/shared/help-shot";
import { HelpReportTab } from "@/components/shared/help-report-tab";
import { installHelpPanelGuard } from "@/components/ui/help-panel-guard";

/* Open/closed and "an error was caught" live outside the component (5 Oct 2026, Pardeep:
   "ai help button ko top me chhota sa icon laga do"). The big floating button covered page
   buttons (the Payment runs "Create" bar, list rows on phone); the trigger is now a small
   icon in the top bar, which needs to open the same panel and show the same red dot. */
/* R-383 (7 Oct 2026, Pardeep: "dono me farak kya, merge karke behtar"): the header's separate
   "Report Bug" button is gone. This one Help button opens a panel with two tabs — "Ask" (the
   AI chat, as before) and "Report a problem" (a plain form that always submits). Ctrl+Shift+B
   opens the Report tab straight away. */
export type HelpTab = "ask" | "report";
/* R-827: "minimized" = the panel folds to a small bar; the chat and the report draft stay. */
type HelpUi = { open: boolean; alert: string | null; tab: HelpTab; minimized: boolean };
let helpUi: HelpUi = { open: false, alert: null, tab: "ask", minimized: false };
const helpListeners = new Set<() => void>();
const setHelpUi = (patch: Partial<HelpUi>) => { helpUi = { ...helpUi, ...patch }; helpListeners.forEach((l) => l()); };
const subscribeHelpUi = (l: () => void) => { helpListeners.add(l); return () => { helpListeners.delete(l); }; };
const SERVER_UI: HelpUi = { open: false, alert: null, tab: "ask", minimized: false };
const useHelpUi = () => React.useSyncExternalStore(subscribeHelpUi, () => helpUi, () => SERVER_UI);

/** Open Help on the "Report a problem" tab (phone More menu, other callers). */
export function openHelpReport() { setHelpUi({ open: true, minimized: false, tab: "report" }); }
/** Ctrl+Shift+B: open on the Report tab; pressed again while that tab is showing, close. */
export function toggleHelpReport() {
  if (helpUi.open && !helpUi.minimized && helpUi.tab === "report") setHelpUi({ open: false, minimized: false });
  else openHelpReport();
}

/** The top-bar trigger: the one Help button, with a red dot while an unseen error waits. */
export function AiHelpButton() {
  const { open, alert, minimized } = useHelpUi();
  /* R-827: a minimized panel counts as closed here — pressing the icon brings it back. */
  const showing = open && !minimized;
  return (
    <div className="relative">
      <IconButton
        icon={alert ? "alert" : "message"}
        aria-label={alert ? "Help — an error was caught, open to report it" : "Help — ask AI or report a problem"}
        title={alert ? `Error caught: ${alert}` : "Help — ask AI or report a problem (Ctrl+Shift+B to report)"}
        aria-pressed={showing}
        data-topbar="help"
        onClick={() => setHelpUi(showing ? { open: false, minimized: false } : { open: true, minimized: false, tab: alert ? "report" : helpUi.tab })}
        className={alert ? "text-rose" : undefined}
      />
      {alert && <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-rose ring-2 ring-paper animate-pulse pointer-events-none" aria-hidden="true" />}
    </div>
  );
}

/* R-223 (tester, staging: "AI Help panel fixed width/height, bada karne ka option nahi"):
   on a desktop the panel has two sizes ("Bigger" / "Smaller") and can be dragged larger or
   smaller from its left edge, bottom edge or bottom-left corner (it is pinned top-right, so
   those are the edges that move). The size is kept in this browser. On a phone the panel is
   a full-screen sheet — no sizes there. */
export interface PanelSize { w: number; h: number }
export const PANEL_NORMAL: PanelSize = { w: 420, h: 600 };
/* R-360: "Expand" = about double the width and the full height of the window; the clamp
   below trims it to whatever the screen allows. */
export const PANEL_LARGE: PanelSize = { w: PANEL_NORMAL.w * 2, h: 10_000 };
export const PANEL_MIN: PanelSize = { w: 360, h: 360 };
const PANEL_MAX_W = 900;
/** Width never passes this share of the window (R-360: 360px .. min(900px, 90vw)). */
const PANEL_MAX_VW = 0.9;
/** md:top-16 (64px) above the panel + a 16px gap below it. */
const PANEL_TOP_AND_GAP = 80;
const PANEL_SIZE_KEY = "reselleros.aiHelp.size";
/** One arrow-key press on the resize handle moves the edge this far. */
export const PANEL_KEY_STEP = 40;

/** Widest the panel may be in this window. */
export const panelMaxWidth = (vp: { w: number }) => Math.max(PANEL_MIN.w, Math.floor(Math.min(PANEL_MAX_W, vp.w * PANEL_MAX_VW)));

/** Keep a size inside the window: never below PANEL_MIN, never past min(900px, 90vw) / the screen bottom. */
export function clampPanelSize(s: PanelSize, vp: { w: number; h: number }): PanelSize {
  const maxW = panelMaxWidth(vp);
  const maxH = Math.max(PANEL_MIN.h, vp.h - PANEL_TOP_AND_GAP);
  const w = Number.isFinite(s.w) ? s.w : PANEL_NORMAL.w;
  const h = Number.isFinite(s.h) ? s.h : PANEL_NORMAL.h;
  return {
    w: Math.round(Math.min(maxW, Math.max(PANEL_MIN.w, w))),
    h: Math.round(Math.min(maxH, Math.max(PANEL_MIN.h, h))),
  };
}

/** R-360: keyboard on the left-edge handle — ← widens, → narrows, Home = narrowest, End = widest. Null = not a resize key. */
export function keyResize(s: PanelSize, key: string, vp: { w: number; h: number }): PanelSize | null {
  const w = key === "ArrowLeft" ? s.w + PANEL_KEY_STEP
    : key === "ArrowRight" ? s.w - PANEL_KEY_STEP
    : key === "Home" ? PANEL_MIN.w
    : key === "End" ? panelMaxWidth(vp)
    : null;
  return w === null ? null : clampPanelSize({ w, h: s.h }, vp);
}

export type ResizeEdge = "left" | "bottom" | "corner";

/** New size after dragging an edge by (dx, dy) px. Pulling left widens; pulling down makes it taller. */
export function dragResize(start: PanelSize, edge: ResizeEdge, dx: number, dy: number, vp: { w: number; h: number }): PanelSize {
  return clampPanelSize({
    w: edge === "bottom" ? start.w : start.w - dx,
    h: edge === "left" ? start.h : start.h + dy,
  }, vp);
}

/** "Bigger" shows while the panel is at (or near) the normal size; anything larger offers "Smaller". */
export const isLargePanel = (s: PanelSize) => s.w > PANEL_NORMAL.w + 20 || s.h > PANEL_NORMAL.h + 20;

function readPanelSize(): PanelSize | null {
  try {
    const raw = window.localStorage.getItem(PANEL_SIZE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PanelSize>;
    return typeof v.w === "number" && typeof v.h === "number" && Number.isFinite(v.w) && Number.isFinite(v.h) ? { w: v.w, h: v.h } : null;
  } catch { return null; }
}
function savePanelSize(s: PanelSize) {
  try { window.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(s)); } catch { /* private window — size just isn't remembered */ }
}
const viewport = () => (typeof window === "undefined" ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight });

/** R-827: room a dialog needs left of the docked panel (max-w-xl 576px + margins). */
export const DIALOG_ROOM = 640;
/** How far dialogs shift for the docked panel: its width on a desktop with room to spare, else 0 (dialog stays centred). */
export function helpDockWidth(panelW: number, vpW: number): number {
  return vpW >= 768 && vpW - panelW >= DIALOG_ROOM ? panelW : 0;
}

/**
 * R-352: "Last tested 7 Oct, 10:52 · 5 ✓ 1 ✗" at the top of AI Help, with the failed tests
 * named — so the person sees what the browser run already covered before asking for more.
 */
export function LastTestedNote({ run }: { run: PageTestRun | null }) {
  if (!run) return null;
  const { failedTests } = summarizeRun(run);
  return (
    <div data-testid="ai-help-last-tested" className="px-3 py-1.5 border-b border-hairline text-2xs text-ink-2">
      <div className="font-semibold">{lastTestedLine(run)}</div>
      {failedTests.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 text-rose">
          {failedTests.slice(0, 3).map((f, i) => <li key={i} className="break-words">✗ {f}</li>)}
          {failedTests.length > 3 && <li>+{failedTests.length - 3} more</li>}
        </ul>
      )}
    </div>
  );
}

interface ChatItem extends HelpMessage {
  /** R-189: screenshot sent with this message */
  image?: string;
  draft?: BugDraft | null;
  filedId?: string;
  page?: string | null;
  checklist?: string[];
  /** R-189: fixes the AI offers — nothing runs until the person presses one */
  actions?: HelpAction[];
  /** R-353: tap-to-ask next questions — shown only under the LAST answer */
  followUps?: string[];
  similar?: { id: string; title: string }[];
  /** the trail as it was when this answer came back — filed with the report */
  recorded?: string | null;
}

const SEV_LABEL: Record<BugDraft["severity"], string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const TYPE_LABEL: Record<BugDraft["type"], string> = { bug: "Bug", feature: "Feature", ui_improvement: "UI improvement" };
const SELF = HELP_SELF;
const CONTROL = "a,button,input,select,textarea,label,summary,[role=button],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch]";

function controlLabel(el: Element): string {
  const h = el as HTMLElement;
  const t = h.getAttribute("aria-label") || h.getAttribute("title") || (h.innerText || "").trim().split("\n")[0] || h.getAttribute("placeholder") || h.getAttribute("name") || h.tagName.toLowerCase();
  return `${h.tagName.toLowerCase() === "a" ? "link" : h.getAttribute("role") || h.tagName.toLowerCase()} "${(maskPII(t, 60) ?? "").slice(0, 60)}"`;
}

/** Records the tab's trail. Returns the live list (ref) and how many problems arrived unseen. */
function useTrail(pathname: string) {
  const trail = React.useRef<TrailEvent[]>([]);
  const pathRef = React.useRef(pathname);
  const [unseen, setUnseen] = React.useState<TrailEvent | null>(null);

  const add = React.useCallback((kind: TrailKind, text: string | null | undefined) => {
    if (!text) return;
    const ev: TrailEvent = { kind, at: Date.now(), text: maskPII(text, 200) ?? "", path: pathRef.current };
    trail.current = pushTrail(trail.current, ev);
    if (isProblem(ev)) setUnseen(ev);
  }, []);

  React.useEffect(() => { pathRef.current = pathname; add("page", pathname); }, [pathname, add]);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!(t instanceof Element) || t.closest(SELF)) return;
      const c = t.closest(CONTROL);
      if (c) add("click", controlLabel(c));
    };
    const onError = (e: ErrorEvent) => add("error", e.message);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string } | string | undefined;
      add("error", typeof r === "string" ? r : r?.message ?? "Unhandled promise rejection");
    };
    const mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of Array.from(m.addedNodes)) {
        if (!(n instanceof Element)) continue;
        const toastEl = n.matches?.("[data-sonner-toast][data-type=error]") ? n : n.querySelector?.("[data-sonner-toast][data-type=error]");
        /* R-176: "please fill X" is recorded for the steps, but does not turn AI Help red. */
        if (toastEl) add(classifyToast(toastEl.textContent || "", toastEl.classList.contains(NEEDS_INPUT_CLASS)), (toastEl.textContent || "").trim());
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    /* Failed requests: wrap fetch once. The wrapper only reads the method, URL and status —
       never a body — and our own AI Help calls are not recorded. */
    const w = window as Window & { __aiHelpFetch?: typeof fetch };
    const original = w.__aiHelpFetch ?? window.fetch;
    w.__aiHelpFetch = original;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
      try {
        const res = await original(input, init);
        if (!url.includes("/api/ai/help") && apiFailureWorthNoting(url, res.status)) add("api_fail", apiFailText(method, url, res.status));
        return res;
      } catch (err) {
        /* R-365: a refused data:/blob: fetch (the PDF engine's inlined wasm) is not an API call. */
        if (!(err instanceof DOMException && err.name === "AbortError") && !url.includes("/api/ai/help") && !isInPageUrl(url)) add("api_fail", apiFailText(method, url, 0));
        throw err;
      }
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      mo.disconnect();
      window.fetch = original;
    };
  }, [add]);

  return { trail, unseen, clearUnseen: () => setUnseen(null) };
}

export function AiHelp() {
  const pathname = usePathname() || "/";
  const router = useRouter();
  /** "<message index>:<action index>" → done / failed */
  const [acted, setActed] = React.useState<Record<string, "done" | "busy" | "failed">>({});

  /* R-189: run one offered fix, as the signed-in person (RLS decides what they may change). */
  async function runAction(key: string, a: HelpAction) {
    if (a.kind === "open") { setOpen(false); router.push(a.href as never); return; }
    setActed((s) => ({ ...s, [key]: "busy" }));
    const supabase = createClient();
    const name = GST_STATE_BY_CODE[a.stateCode] ?? null;
    const q = a.kind === "set_customer_state"
      ? supabase.from("customers").update({ state_code: a.stateCode, state: name }).eq("id", a.customerId).select("id")
      : supabase.from("tenants").update({ state_code: a.stateCode, state: name }).eq("id", currentUser?.tenantId ?? "").select("id");
    const { data, error } = await q;
    if (error || !data?.length) {
      setActed((s) => ({ ...s, [key]: "failed" }));
      toast.error("Could not make that change.", { description: `${error?.message ?? "You may not have permission for this."} — do it from the page instead.` });
      return;
    }
    setActed((s) => ({ ...s, [key]: "done" }));
    toast.success("Done.", { description: a.label });
  }
  const { data: currentUser } = useCurrentUser();
  const submit = useSubmitFeedback();
  const { trail, unseen, clearUnseen } = useTrail(pathname);
  const { open, tab, minimized } = useHelpUi();
  const setOpen = React.useCallback((v: boolean) => setHelpUi({ open: v, minimized: false }), []);
  /* R-827: the panel is shown in full (not closed, not folded to the small bar). */
  const showing = open && !minimized;
  /* R-827: help stays usable over an open dialog (shared guard — see ui/help-panel-guard). */
  const rootRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => (rootRef.current ? installHelpPanelGuard(rootRef.current) : undefined), []);
  React.useEffect(() => { setHelpUi({ alert: unseen?.text ?? null }); }, [unseen]);
  /* R-223: panel size (desktop). Read after mount so the server render never touches storage. */
  const [size, setSize] = React.useState<PanelSize>(PANEL_NORMAL);
  const [, setVpTick] = React.useState(0);
  React.useEffect(() => { const saved = readPanelSize(); if (saved) setSize(saved); }, []);
  React.useEffect(() => {
    if (!open) return;
    const onResize = () => setVpTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);
  const shownSize = clampPanelSize(size, viewport());
  const large = isLargePanel(shownSize);
  /* R-827: the panel is docked on the right. When the window is wide enough, dialogs centre
     in the space left of it (ui/dialog reads --ai-help-dock), so both are visible side by side. */
  const dockW = showing ? helpDockWidth(shownSize.w, viewport().w) : 0;
  React.useEffect(() => {
    const root = document.documentElement;
    if (dockW > 0) root.style.setProperty("--ai-help-dock", `${dockW}px`);
    else root.style.removeProperty("--ai-help-dock");
    return () => { root.style.removeProperty("--ai-help-dock"); };
  }, [dockW]);
  function toggleSize() {
    /* Kept unclamped: "Expand" stays full height when the window later grows (clamped on show). */
    const next = large ? PANEL_NORMAL : PANEL_LARGE;
    setSize(next);
    savePanelSize(next);
  }
  const drag = React.useRef<{ edge: ResizeEdge; x: number; y: number; start: PanelSize; last: PanelSize } | null>(null);
  const startDrag = (edge: ResizeEdge) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { edge, x: e.clientX, y: e.clientY, start: shownSize, last: shownSize };
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.last = dragResize(d.start, d.edge, e.clientX - d.x, e.clientY - d.y, viewport());
    setSize(d.last);
  };
  const endDrag = () => {
    if (!drag.current) return;
    savePanelSize(drag.current.last);
    drag.current = null;
  };
  const onResizeKey = (e: React.KeyboardEvent) => {
    const next = keyResize(shownSize, e.key, viewport());
    if (!next) return;
    e.preventDefault();
    setSize(next);
    savePanelSize(next);
  };
  /* R-352: this page's last browser test run. Read with the person's login (owner/manager by
     RLS); no table yet, no run or no access → nothing is shown. */
  const [lastRun, setLastRun] = React.useState<PageTestRun | null>(null);
  const tenantId = currentUser?.tenantId ?? null;
  React.useEffect(() => {
    if (!open || !tenantId) return;
    let live = true;
    void loadLastPageTestRun(createClient(), tenantId, pathname).then((r) => { if (live) setLastRun(r); });
    return () => { live = false; setLastRun(null); };
  }, [open, tenantId, pathname]);
  const [items, setItems] = React.useState<ChatItem[]>([]);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState<false | HelpMode>(false);
  const [filing, setFiling] = React.useState<number | null>(null);
  /** "Test next" marks, keyed "<message index>:<line index>". */
  const [checks, setChecks] = React.useState<Record<string, "ok" | "fail">>({});
  const [shot, setShot] = React.useState<Shot | null>(null);
  const [capturing, setCapturing] = React.useState(false);
  const [cropSrc, setCropSrc] = React.useState<HTMLCanvasElement | null>(null);
  /* R-195: a small "Ask AI" button above selected text, anywhere in the app. */
  const [askAt, setAskAt] = React.useState<{ x: number; y: number; q: string } | null>(null);
  React.useEffect(() => {
    const onUp = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(SELF) || target?.closest?.("input,textarea,[contenteditable=true]")) return;
      setTimeout(() => {
        const sel = window.getSelection();
        const q = askAboutSelection(sel?.toString());
        if (!sel || !q || sel.rangeCount === 0) { setAskAt(null); return; }
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (!r.width && !r.height) { setAskAt(null); return; }
        setAskAt({ x: Math.min(window.innerWidth - 90, Math.max(8, r.left + r.width / 2 - 40)), y: Math.max(8, r.top - 40), q });
      }, 10);
    };
    const onScroll = () => setAskAt(null);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchend", onUp);
    window.addEventListener("scroll", onScroll, true);
    return () => { document.removeEventListener("mouseup", onUp); document.removeEventListener("touchend", onUp); window.removeEventListener("scroll", onScroll, true); };
  }, []);
  /* R-196: copy the "Test next" list as a prompt for a new Claude session to run in its browser. */
  async function copyTestRun(page: string, tests: string[]) {
    const prompt = buildTestRunPrompt({ pagePath: page, tests, tenantId: currentUser?.tenantId ?? null });
    let ok = false;
    try { await navigator.clipboard.writeText(prompt); ok = true; } catch {
      try {
        const ta = document.createElement("textarea"); ta.value = prompt; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); document.body.removeChild(ta);
      } catch { ok = false; }
    }
    if (ok) toast.success("Test prompt copied.", { description: "Open a new Claude Code session and paste it — it runs these tests in its browser on the local app and writes the result on the work board." });
    else toast.warning("Browser blocked copying.", { description: "Ask Claude in chat to run these tests instead." });
  }

  function askSelection() {
    if (!askAt) return;
    setText(askAt.q);
    setAskAt(null);
    window.getSelection()?.removeAllRanges();
    setHelpUi({ open: true, minimized: false, tab: "ask" });
    setTimeout(() => inputRef.current?.focus(), 80);
  }
  async function finishCrop(c: HTMLCanvasElement) {
    setCropSrc(null);
    const s = await toShot(c);
    if (s) setShot(s); else toast.warning("Screenshot is too large.", { description: "Choose a smaller part." });
  }

  /* R-189 (Pardeep, 6 Oct: "screenshot ka bhi option ho"): photo of the page behind the
     panel. The panel itself is left out of the picture (ignoreElements). */
  async function captureScreen() {
    if (capturing) return;
    setCapturing(true);
    const canvas = await captureViewport();
    setCapturing(false);
    if (canvas) setCropSrc(canvas);
    else toast.warning("Could not take a screenshot.", { description: "Paste one with Ctrl+V instead (Win+Shift+S takes one)." });
  }

  async function onPaste(e: React.ClipboardEvent) {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    const s = await toShot(file).catch(() => null);
    if (s) setShot(s); else toast.warning("Could not read that image.", { description: "Try another screenshot." });
  }
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [items, busy, showing]);
  React.useEffect(() => { if (showing) setTimeout(() => inputRef.current?.focus(), 50); }, [showing]);

  async function ask(mode: HelpMode, typed?: string, image?: Shot | null) {
    if (busy) return;
    const shown = mode === "scan" ? "🔍 Is page ko jaancho" : mode === "error" ? "⚠️ Abhi wale error ki report banao" : mode === "check_failed" ? `✗ Test fail: ${typed ?? ""}` : typed ?? "";
    const prior = items.map(({ role, text: t }) => ({ role, text: t }));
    const messages = mode === "chat" ? [...prior, { role: "user" as const, text: shown }] : prior;
    let scan: ReturnType<typeof scanPage> | null = null;
    if (mode === "scan") { try { scan = scanPage(trail.current, pathname); } catch { scan = { findings: [], outline: "" }; } }
    if (mode === "error") clearUnseen();
    setItems((s) => [...s, { role: "user", text: shown, page: pathname, ...(image ? { image: image.dataUrl } : {}) }]);
    setBusy(mode);
    const recorded = trailForPrompt(trail.current.slice(-15));
    try {
      const res = await fetch("/api/ai/help", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages, pagePath: pathname, mode, trail: trail.current,
          ...(scan ? { findings: scan.findings, outline: scan.outline } : {}),
          ...(mode === "check_failed" ? { failedCheck: typed } : {}),
          ...(image ? { image: { mimeType: image.mimeType, base64: image.base64 } } : {}),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { reply?: string; bugDraft?: BugDraft | null; checklist?: string[]; actions?: HelpAction[]; followUps?: string[]; similar?: { id: string; title: string }[]; error?: string; ai?: boolean };
      let reply = j.reply || j.error || "No answer came back — please try again.";
      if (scan && scan.findings.length && j.ai !== true) reply += `\n\nAutomatic jaanch ne ${scan.findings.length} cheez(ein) pakdi:\n` + scan.findings.map((f) => `• ${f.detail}`).join("\n");
      setItems((s) => {
        /* The same bug drafted earlier in THIS chat (an error report, then a page scan that
           finds the same failed call) is a duplicate too — say so on the new draft. */
        const earlier = j.bugDraft
          ? s.filter((x) => x.draft && looksLikeSameBug({ title: j.bugDraft!.title, pagePath: pathname }, { title: x.draft.title, page_path: x.page ?? null }))
              .map((x) => ({ id: x.filedId ?? "draft", title: x.draft!.title }))
          : [];
        return [...s, { role: "assistant", text: reply, draft: j.bugDraft ?? null, checklist: j.checklist ?? [], actions: j.actions ?? [], followUps: Array.isArray(j.followUps) ? j.followUps.filter((f): f is string => typeof f === "string" && f.trim() !== "").slice(0, 3) : [], similar: [...earlier, ...(j.similar ?? [])].slice(0, 3), page: pathname, recorded }];
      });
    } catch {
      setItems((s) => [...s, { role: "assistant", text: "Could not connect — please try again. You can still send it from the Report a problem tab." }]);
    } finally {
      setBusy(false);
    }
  }

  function send(e?: React.FormEvent, chip?: string) {
    e?.preventDefault();
    const q = chip ?? (text.trim() || (shot ? "What is wrong in this screenshot?" : ""));
    if (!q || busy) return;
    /* R-353: a chip is sent exactly like a typed question; whatever is half-typed stays. */
    if (!chip) setText("");
    const s = shot;
    setShot(null);
    void ask("chat", q, s);
  }

  /* R-353: chips belong to the last answer only — any new message (typed, chip, scan, error)
     makes them disappear, and they are hidden while an answer is on its way. */
  const last = items[items.length - 1];
  const followUps = !busy && last?.role === "assistant" ? last.followUps ?? [] : [];

  async function file(idx: number) {
    const it = items[idx];
    if (!it?.draft || it.filedId) return;
    setFiling(idx);
    try {
      const result = await submit.mutateAsync({
        tenantId: currentUser?.tenantId ?? "",
        reportedType: it.draft.type,
        reportedSeverity: it.draft.severity,
        text: bugReportText(it.draft, { pagePath: it.page ?? pathname, reporterName: currentUser?.fullName ?? null, recorded: it.recorded ?? null }),
        pagePath: it.page ?? pathname,
        reporterId: currentUser?.userId ?? null,
        reporterName: currentUser?.fullName ?? null,
        reporterEmail: currentUser?.authEmail ?? null,
        /* R-189: every screenshot shared in this chat goes with the report. */
        screenshots: items.filter((x) => x.image).slice(-3).map((x, n) => ({ name: `ai_help_screen_${n + 1}.jpg`, dataUrl: x.image! })),
        filedVia: "ai-chat",
        aiChatSummary: it.draft.chatSummary || null,
      });
      setItems((s) => s.map((x, i) => (i === idx ? { ...x, filedId: result.id } : x)));
      toast.success("Report filed in your name", { description: `${AI_FILED_TAG}. It appears in Admin → Feedback.` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Report was not filed — please try again.");
    } finally {
      setFiling(null);
    }
  }

  return (
    /* R-827: pointer-events auto — an open modal dialog sets body pointer-events:none, and
       help must stay clickable over it. The wrapper itself has no size, so it blocks nothing. */
    <div data-ai-help ref={rootRef} style={{ pointerEvents: "auto" }}>
      {askAt && (
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={askSelection}
          style={{ left: askAt.x, top: askAt.y }}
          className="fixed z-[55] inline-flex items-center gap-1 rounded-full bg-ink text-paper text-xs font-semibold px-3 py-1.5 shadow-lg hover:opacity-90"
          aria-label="Ask AI about the selected text">
          <Icon name="sparkles" size={12} /> Ask AI
        </button>
      )}
      {cropSrc && <CropOverlay src={cropSrc} onDone={(c) => void finishCrop(c)} onCancel={() => setCropSrc(null)} />}
      {open && (
        <section
          role="dialog"
          aria-label="Help"
          data-size={large ? "large" : "normal"}
          hidden={minimized}
          style={{ "--ai-w": `${shownSize.w}px`, "--ai-h": `${shownSize.h}px` } as React.CSSProperties}
          /* R-827: docked to the right edge (not floating over the middle) and above dialog
             overlays (z-50), so a dialog and help can be used side by side. */
          className={`fixed z-[65] inset-0 md:inset-auto md:right-0 md:top-16 md:w-[var(--ai-w)] md:h-[var(--ai-h)] ${minimized ? "hidden" : "flex"} flex-col md:rounded-l-2xl md:border-y md:border-l border-hairline bg-paper shadow-2xl overflow-hidden`}
        >
          {/* R-223: drag handles (desktop). The panel is pinned top-right, so its left and bottom edges move. */}
          {/* R-360: the left edge is also a keyboard control (Tab to it, ← / → / Home / End). */}
          <div data-resize="left" role="separator" tabIndex={0} aria-orientation="vertical"
            aria-label="Resize panel width — left arrow wider, right arrow narrower"
            aria-valuemin={PANEL_MIN.w} aria-valuemax={panelMaxWidth(viewport())} aria-valuenow={shownSize.w}
            onPointerDown={startDrag("left")} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={onResizeKey}
            className="hidden md:block absolute left-0 top-0 bottom-3 w-1.5 z-10 cursor-ew-resize touch-none hover:bg-amber/30 focus:outline-none focus-visible:bg-amber/60" />
          <div aria-hidden="true" data-resize="bottom" onPointerDown={startDrag("bottom")} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
            className="hidden md:block absolute bottom-0 left-3 right-0 h-1.5 z-10 cursor-ns-resize touch-none hover:bg-amber/30" />
          <div aria-hidden="true" data-resize="corner" onPointerDown={startDrag("corner")} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
            className="hidden md:block absolute left-0 bottom-0 w-3 h-3 z-10 cursor-nesw-resize touch-none hover:bg-amber/40" />
          <header className="flex items-center gap-2 px-4 py-3 border-b border-hairline bg-paper-2/60">
            <Icon name="sparkles" size={16} className="text-amber-ink" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-ink">Help</div>
              <div className="text-2xs text-ink-3 truncate">On this page: {pathname}</div>
            </div>
            {tab === "ask" && items.length > 0 && (
              <button type="button" className="text-2xs text-ink-3 hover:text-ink" onClick={() => { setItems([]); setChecks({}); setActed({}); }}>New chat</button>
            )}
            <button type="button" className="hidden md:inline rounded px-1 text-2xs text-ink-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              aria-pressed={large}
              aria-label={large ? "Collapse panel to normal size" : "Expand panel"}
              title={large ? "Back to the normal size" : "Make the panel bigger — or drag its left or bottom edge"}
              onClick={toggleSize}>{large ? "Smaller" : "Expand"}</button>
            {/* R-827: fold to a small bar to work on the page; the chat is kept. Phone too. */}
            <button type="button" className="rounded px-1 min-h-8 text-2xs text-ink-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              aria-label="Minimize help"
              title="Fold help to a small bar — your chat stays"
              onClick={() => setHelpUi({ minimized: true })}>Minimize</button>
            <button type="button" aria-label="Close" className="p-1 text-ink-3 hover:text-ink" onClick={() => setOpen(false)}>
              <Icon name="x" size={16} />
            </button>
          </header>

          {/* R-383: one Help panel, two tabs. Arrow keys move between them (WAI-ARIA tabs). */}
          <div role="tablist" aria-label="Help" className="flex border-b border-hairline px-2"
            onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const next = tab === "ask" ? "report" : "ask"; setHelpUi({ tab: next }); document.getElementById(`help-tab-${next}`)?.focus(); } }}>
            {(["ask", "report"] as const).map((t) => (
              <button key={t} type="button" role="tab" id={`help-tab-${t}`} aria-selected={tab === t} aria-controls={`help-panel-${t}`} tabIndex={tab === t ? 0 : -1}
                onClick={() => setHelpUi({ tab: t })}
                className={`min-h-10 px-3 text-xs font-semibold border-b-2 -mb-px focus:outline-none focus-visible:ring-2 focus-visible:ring-amber ${tab === t ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}>
                {t === "ask" ? "Ask" : "Report a problem"}
                {t === "report" && unseen && <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-rose align-middle" aria-label="error caught" />}
              </button>
            ))}
          </div>

          {tab === "ask" ? (
          <div role="tabpanel" id="help-panel-ask" aria-labelledby="help-tab-ask" className="flex-1 min-h-0 flex flex-col">
          {unseen && (
            <div className="px-3 py-2 border-b border-hairline bg-red-50 text-red-900 text-xs flex items-start gap-2">
              <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Error caught</div>
                <div className="break-words">{unseen.text}</div>
              </div>
              <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void ask("error")}>Report it</Button>
              <button type="button" aria-label="Dismiss" className="p-1 opacity-70 hover:opacity-100" onClick={clearUnseen}><Icon name="x" size={12} /></button>
            </div>
          )}

          <div className="px-3 py-2 border-b border-hairline flex gap-2">
            <Button size="sm" variant="outline" icon="search" loading={busy === "scan"} disabled={!!busy} onClick={() => void ask("scan")}>
              Check this page
            </Button>
          </div>
          <LastTestedNote run={lastRun} />

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {items.length === 0 && (
              <div className="text-sm text-ink-2 space-y-2 p-1">
                <p>Press <b>Check this page</b>: I check the screen and tell you what is wrong and what to test next.</p>
                <p>I remember your clicks and errors. Found a bug? Just write "this is wrong" — I will write the steps. The AI Help icon turns red when an error happens.</p>
                <p>Press 📷 or paste a screenshot with <b>Ctrl+V</b> — I will look at the screen and answer.</p>
                <p className="text-ink-3 text-xs">A report is sent only when you review the draft and press <b>File</b> — in your name.</p>
              </div>
            )}
            {items.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[90%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-ink text-paper" : "bg-paper-2 text-ink"}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {m.image && <img src={m.image} alt="Screenshot sent with this message" className="mb-1.5 max-h-40 rounded-md border border-hairline" />}
                  {m.text}
                  {m.actions && m.actions.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Fix it here</div>
                      {m.actions.map((a, j) => {
                        const k = `${i}:${j}`;
                        const st = acted[k];
                        return (
                          <Button key={j} size="sm" variant={a.kind === "open" ? "outline" : "primary"}
                            className="justify-start text-left h-auto py-1.5 whitespace-normal"
                            loading={st === "busy"} disabled={st === "done" || st === "busy"}
                            onClick={() => void runAction(k, a)}>
                            {st === "done" ? "✓ " : a.kind === "open" ? "→ " : ""}{a.label}
                          </Button>
                        );
                      })}
                      {m.actions.some((a) => a.kind !== "open") && <div className="text-2xs text-ink-3">Nothing changes until you press a button. It saves as you.</div>}
                    </div>
                  )}
                  {m.checklist && m.checklist.length > 0 && (
                    <div className="mt-2 rounded-lg border border-hairline bg-paper p-2.5 text-ink">
                      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Test next</div>
                      <ul className="text-xs space-y-1">
                        {/* Each suggested test can be marked (5 Oct 2026, Pardeep): ✓ passed, or
                            ✗ failed — which drafts the bug report for that test straight away. */}
                        {m.checklist.map((c, j) => {
                          const k = `${i}:${j}`;
                          const st = checks[k];
                          return (
                            <li key={j} className="flex items-start gap-1.5">
                              <span className={`flex-1 ${st === "ok" ? "line-through text-ink-3" : st === "fail" ? "text-rose" : ""}`}>{c}</span>
                              <span className="flex gap-1 shrink-0">
                                <button type="button" aria-label={`Passed: ${c}`} title="Worked"
                                  disabled={!!st || !!busy}
                                  onClick={() => setChecks((s) => ({ ...s, [k]: "ok" }))}
                                  className={`w-6 h-6 rounded-md border text-xs font-bold ${st === "ok" ? "bg-emerald text-white border-emerald" : "border-hairline text-emerald hover:bg-emerald-soft"} disabled:opacity-60`}>✓</button>
                                <button type="button" aria-label={`Failed: ${c}`} title="Did not work — draft a bug report"
                                  disabled={!!st || !!busy}
                                  onClick={() => { setChecks((s) => ({ ...s, [k]: "fail" })); void ask("check_failed", c); }}
                                  className={`w-6 h-6 rounded-md border text-xs font-bold ${st === "fail" ? "bg-rose text-white border-rose" : "border-hairline text-rose hover:bg-rose-soft"} disabled:opacity-60`}>✗</button>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      <Button size="sm" variant="outline" className="mt-2" icon="copy"
                        title="Copies a prompt — paste it in a new Claude Code session; it runs these tests in its own browser on the local app"
                        onClick={() => void copyTestRun(m.page ?? pathname, m.checklist ?? [])}>
                        Run these tests in browser
                      </Button>
                    </div>
                  )}
                  {m.draft && (
                    <div className="mt-2 rounded-lg border border-hairline bg-paper p-2.5 text-ink space-y-1.5">
                      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Bug report — draft</div>
                      <div className="font-semibold">{m.draft.title}</div>
                      <div className="text-2xs text-ink-3">{TYPE_LABEL[m.draft.type]} · {SEV_LABEL[m.draft.severity]} · {m.page ?? pathname}</div>
                      <div className="text-xs"><b>What happened:</b> {m.draft.actual}</div>
                      {m.draft.expected && <div className="text-xs"><b>Expected:</b> {m.draft.expected}</div>}
                      {m.draft.steps.length > 0 && (
                        <ol data-testid="ai-help-draft-steps" className="text-xs list-decimal pl-4 space-y-0.5">{cleanSteps(m.draft.steps).map((s, j) => <li key={j}>{s}</li>)}</ol>
                      )}
                      {m.recorded && <div className="text-2xs text-ink-3">+ the app&apos;s record of your last steps is attached</div>}
                      {items.some((x) => x.image) && <div className="text-2xs text-ink-3">+ screenshots from this chat are attached</div>}
                      {m.similar && m.similar.length > 0 && !m.filedId && (
                        <div className="text-xs rounded-md bg-amber-50 text-amber-900 px-2 py-1.5">
                          <b>Already reported?</b> Same as: {m.similar.map((x) => `“${x.title}”`).join(", ")}. File only if this is different.
                        </div>
                      )}
                      <div className="text-2xs text-ink-3">{AI_FILED_TAG} · filed by: {currentUser?.fullName ?? "—"}</div>
                      {m.filedId ? (
                        <div className="text-xs font-semibold text-emerald">✓ File ho gayi — Admin → Feedback</div>
                      ) : (
                        <Button size="sm" variant="primary" loading={filing === i} disabled={filing !== null} onClick={() => file(i)}>File this report</Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="text-xs text-ink-3 px-1">{busy === "scan" ? "Page jaanch raha hoon…" : busy === "error" ? "Report bana raha hoon…" : "AI soch raha hai…"}</div>}
            <div ref={endRef} />
          </div>

          {followUps.length > 0 && (
            <div data-testid="ai-help-followups" role="group" aria-label="Suggested next questions" className="border-t border-hairline px-2 pt-2 flex flex-wrap gap-1.5">
              {followUps.map((f) => (
                <button key={f} type="button" onClick={() => send(undefined, f)}
                  aria-label={`Ask: ${f}`}
                  className="min-h-10 max-w-full rounded-full border border-hairline bg-paper-2 px-3 py-1.5 text-left text-xs text-ink hover:bg-amber-soft hover:border-amber focus:outline-none focus-visible:ring-2 focus-visible:ring-amber">
                  {f}
                </button>
              ))}
            </div>
          )}
          {shot && (
            <div className="border-t border-hairline px-2 pt-2 flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shot.dataUrl} alt="Screenshot to send" className="h-14 rounded-md border border-hairline" />
              <span className="text-2xs text-ink-3 flex-1">Screenshot goes with your next message.</span>
              <button type="button" aria-label="Remove screenshot" className="p-1 text-ink-3 hover:text-ink" onClick={() => setShot(null)}><Icon name="x" size={14} /></button>
            </div>
          )}
          <form onSubmit={send} className="border-t border-hairline p-2 flex gap-2 items-end">
            <IconButton
              type="button"
              icon="camera"
              aria-label="Take a screenshot of this page"
              title="Screenshot this page — or paste one into the box"
              onClick={() => void captureScreen()}
              disabled={capturing || !!busy}
            />
            <label htmlFor="ai-help-input" className="sr-only">Your question</label>
            <textarea
              id="ai-help-input"
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              onPaste={(e) => void onPaste(e)}
              rows={2}
              maxLength={1500}
              placeholder="e.g. Why is the GST wrong on this invoice?"
              className="flex-1 resize-none rounded-lg border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber"
            />
            <Button type="submit" size="sm" variant="primary" loading={busy === "chat"} disabled={(!text.trim() && !shot) || !!busy}>Send</Button>
          </form>
          </div>
          ) : (
            <div role="tabpanel" id="help-panel-report" aria-labelledby="help-tab-report" className="flex-1 min-h-0 flex flex-col">
              <HelpReportTab pathname={pathname} getTrail={() => trail.current} caughtError={unseen?.text ?? null} onCaughtErrorUsed={clearUnseen} onFiled={() => setOpen(false)} />
            </div>
          )}
        </section>
      )}
      {open && minimized && (
        /* R-827: the small bar — bottom right, above the phone tab bar. */
        <div role="region" aria-label="Help (minimized)"
          className="fixed z-[65] right-3 bottom-[calc(var(--bottom-nav-h,56px)+0.75rem)] md:bottom-4 md:right-4 flex items-center gap-1 rounded-full border border-hairline bg-paper shadow-2xl pl-1 pr-1">
          <button type="button" aria-label="Open help"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-ink hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            onClick={() => setHelpUi({ minimized: false })}>
            <Icon name="sparkles" size={14} className="text-amber-ink" />
            Help
            {busy ? <span className="font-normal text-ink-3">· answering…</span>
              : items.length > 0 ? <span className="font-normal text-ink-3">· {items.length} {items.length === 1 ? "message" : "messages"}</span> : null}
            {unseen && <span className="w-2 h-2 rounded-full bg-rose" aria-label="error caught" />}
          </button>
          <button type="button" aria-label="Close help" className="p-2 rounded-full text-ink-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber" onClick={() => setOpen(false)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
