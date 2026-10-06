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
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useSubmitFeedback } from "@/lib/queries/feedback";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { maskPII } from "@/lib/ux/signals";
import { bugReportText, AI_FILED_TAG, type BugDraft, type HelpMessage, type HelpMode } from "@/lib/ai/app-help";
import { pushTrail, isProblem, classifyToast, NEEDS_INPUT_CLASS, apiFailureWorthNoting, apiFailText, trailForPrompt, looksLikeSameBug, type TrailEvent, type TrailKind } from "@/lib/ai/test-trail";
import { scanPage } from "@/components/shared/page-scan";
import { IconButton } from "@/components/ui/button";

/* Open/closed and "an error was caught" live outside the component (5 Oct 2026, Pardeep:
   "ai help button ko top me chhota sa icon laga do"). The big floating button covered page
   buttons (the Payment runs "Create" bar, list rows on phone); the trigger is now a small
   icon in the top bar, which needs to open the same panel and show the same red dot. */
type HelpUi = { open: boolean; alert: string | null };
let helpUi: HelpUi = { open: false, alert: null };
const helpListeners = new Set<() => void>();
const setHelpUi = (patch: Partial<HelpUi>) => { helpUi = { ...helpUi, ...patch }; helpListeners.forEach((l) => l()); };
const subscribeHelpUi = (l: () => void) => { helpListeners.add(l); return () => { helpListeners.delete(l); }; };
const SERVER_UI: HelpUi = { open: false, alert: null };
const useHelpUi = () => React.useSyncExternalStore(subscribeHelpUi, () => helpUi, () => SERVER_UI);

/** The top-bar trigger: a small chat icon, with a red dot while an unseen error waits. */
export function AiHelpButton() {
  const { open, alert } = useHelpUi();
  return (
    <div className="relative">
      <IconButton
        icon={alert ? "alert" : "message"}
        aria-label={alert ? "AI Help — an error was caught, open to report it" : "AI Help — ask about this page or report a bug"}
        title={alert ? `Error caught: ${alert}` : "AI Help"}
        aria-pressed={open}
        onClick={() => setHelpUi({ open: !open })}
        className={alert ? "text-rose" : undefined}
      />
      {alert && <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-rose ring-2 ring-paper animate-pulse pointer-events-none" aria-hidden="true" />}
    </div>
  );
}

interface ChatItem extends HelpMessage {
  draft?: BugDraft | null;
  filedId?: string;
  page?: string | null;
  checklist?: string[];
  similar?: { id: string; title: string }[];
  /** the trail as it was when this answer came back — filed with the report */
  recorded?: string | null;
}

const SEV_LABEL: Record<BugDraft["severity"], string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const TYPE_LABEL: Record<BugDraft["type"], string> = { bug: "Bug", feature: "Feature", ui_improvement: "UI improvement" };
const SELF = "[data-ai-help]";
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
        if (!(err instanceof DOMException && err.name === "AbortError") && !url.includes("/api/ai/help")) add("api_fail", apiFailText(method, url, 0));
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
  const { data: currentUser } = useCurrentUser();
  const submit = useSubmitFeedback();
  const { trail, unseen, clearUnseen } = useTrail(pathname);
  const { open } = useHelpUi();
  const setOpen = React.useCallback((v: boolean) => setHelpUi({ open: v }), []);
  React.useEffect(() => { setHelpUi({ alert: unseen?.text ?? null }); }, [unseen]);
  const [items, setItems] = React.useState<ChatItem[]>([]);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState<false | HelpMode>(false);
  const [filing, setFiling] = React.useState<number | null>(null);
  /** "Test next" marks, keyed "<message index>:<line index>". */
  const [checks, setChecks] = React.useState<Record<string, "ok" | "fail">>({});
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [items, busy, open]);
  React.useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open]);

  async function ask(mode: HelpMode, typed?: string) {
    if (busy) return;
    const shown = mode === "scan" ? "🔍 Is page ko jaancho" : mode === "error" ? "⚠️ Abhi wale error ki report banao" : mode === "check_failed" ? `✗ Test fail: ${typed ?? ""}` : typed ?? "";
    const prior = items.map(({ role, text: t }) => ({ role, text: t }));
    const messages = mode === "chat" ? [...prior, { role: "user" as const, text: shown }] : prior;
    let scan: ReturnType<typeof scanPage> | null = null;
    if (mode === "scan") { try { scan = scanPage(trail.current, pathname); } catch { scan = { findings: [], outline: "" }; } }
    if (mode === "error") clearUnseen();
    setItems((s) => [...s, { role: "user", text: shown, page: pathname }]);
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
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { reply?: string; bugDraft?: BugDraft | null; checklist?: string[]; similar?: { id: string; title: string }[]; error?: string; ai?: boolean };
      let reply = j.reply || j.error || "Jawab nahi aaya — dobara try karein.";
      if (scan && scan.findings.length && j.ai !== true) reply += `\n\nAutomatic jaanch ne ${scan.findings.length} cheez(ein) pakdi:\n` + scan.findings.map((f) => `• ${f.detail}`).join("\n");
      setItems((s) => {
        /* The same bug drafted earlier in THIS chat (an error report, then a page scan that
           finds the same failed call) is a duplicate too — say so on the new draft. */
        const earlier = j.bugDraft
          ? s.filter((x) => x.draft && looksLikeSameBug({ title: j.bugDraft!.title, pagePath: pathname }, { title: x.draft.title, page_path: x.page ?? null }))
              .map((x) => ({ id: x.filedId ?? "draft", title: x.draft!.title }))
          : [];
        return [...s, { role: "assistant", text: reply, draft: j.bugDraft ?? null, checklist: j.checklist ?? [], similar: [...earlier, ...(j.similar ?? [])].slice(0, 3), page: pathname, recorded }];
      });
    } catch {
      setItems((s) => [...s, { role: "assistant", text: "Connection nahi bana — dobara try karein. Bug ho to 'Report Bug' button bhi chalta hai." }]);
    } finally {
      setBusy(false);
    }
  }

  function send(e?: React.FormEvent) {
    e?.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    void ask("chat", q);
  }

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
        screenshots: [],
        filedVia: "ai-chat",
        aiChatSummary: it.draft.chatSummary || null,
      });
      setItems((s) => s.map((x, i) => (i === idx ? { ...x, filedId: result.id } : x)));
      toast.success("Report file ho gayi — aapke naam se", { description: `${AI_FILED_TAG}. Admin → Feedback mein dikhegi.` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Report file nahi hui — dobara try karein.");
    } finally {
      setFiling(null);
    }
  }

  return (
    <div data-ai-help>
      {open && (
        <section
          role="dialog"
          aria-label="AI Help"
          className="fixed z-50 right-2 left-2 top-14 md:left-auto md:right-5 md:top-16 md:w-[420px] h-[min(600px,calc(100vh-7rem))] flex flex-col rounded-2xl border border-hairline bg-paper shadow-2xl overflow-hidden"
        >
          <header className="flex items-center gap-2 px-4 py-3 border-b border-hairline bg-paper-2/60">
            <Icon name="sparkles" size={16} className="text-amber-ink" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-ink">AI Help</div>
              <div className="text-2xs text-ink-3 truncate">On this page: {pathname}</div>
            </div>
            {items.length > 0 && (
              <button type="button" className="text-2xs text-ink-3 hover:text-ink" onClick={() => { setItems([]); setChecks({}); }}>New chat</button>
            )}
            <button type="button" aria-label="Close" className="p-1 text-ink-3 hover:text-ink" onClick={() => setOpen(false)}>
              <Icon name="x" size={16} />
            </button>
          </header>

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

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {items.length === 0 && (
              <div className="text-sm text-ink-2 space-y-2 p-1">
                <p><b>Check this page</b> dabaiye: main screen jaanch kar bataunga kya galat hai, aur aage kya test karna hai.</p>
                <p>Main aapke clicks aur errors khud yaad rakhta hoon. Bug mile to bas likhiye "ye galat hai" — steps main likh dunga. Error aate hi upar wala AI Help icon laal ho jaayega.</p>
                <p className="text-ink-3 text-xs">Report tabhi jaati hai jab aap draft dekh kar <b>File</b> dabate hain — aapke naam se.</p>
              </div>
            )}
            {items.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[90%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-ink text-paper" : "bg-paper-2 text-ink"}`}>
                  {m.text}
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
                    </div>
                  )}
                  {m.draft && (
                    <div className="mt-2 rounded-lg border border-hairline bg-paper p-2.5 text-ink space-y-1.5">
                      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Bug report — draft</div>
                      <div className="font-semibold">{m.draft.title}</div>
                      <div className="text-2xs text-ink-3">{TYPE_LABEL[m.draft.type]} · {SEV_LABEL[m.draft.severity]} · {m.page ?? pathname}</div>
                      <div className="text-xs"><b>Kya hua:</b> {m.draft.actual}</div>
                      {m.draft.expected && <div className="text-xs"><b>Kya hona chahiye:</b> {m.draft.expected}</div>}
                      {m.draft.steps.length > 0 && (
                        <ol className="text-xs list-decimal pl-4 space-y-0.5">{m.draft.steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
                      )}
                      {m.recorded && <div className="text-2xs text-ink-3">+ the app&apos;s record of your last steps is attached</div>}
                      {m.similar && m.similar.length > 0 && !m.filedId && (
                        <div className="text-xs rounded-md bg-amber-50 text-amber-900 px-2 py-1.5">
                          <b>Already reported?</b> Same as: {m.similar.map((x) => `“${x.title}”`).join(", ")}. File only if this is different.
                        </div>
                      )}
                      <div className="text-2xs text-ink-3">{AI_FILED_TAG} · aapke naam se: {currentUser?.fullName ?? "—"}</div>
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

          <form onSubmit={send} className="border-t border-hairline p-2 flex gap-2 items-end">
            <label htmlFor="ai-help-input" className="sr-only">Aapka sawaal</label>
            <textarea
              id="ai-help-input"
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={2}
              maxLength={1500}
              placeholder="Jaise: Invoice par GST galat kyun aa raha hai?"
              className="flex-1 resize-none rounded-lg border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber"
            />
            <Button type="submit" size="sm" variant="primary" loading={busy === "chat"} disabled={!text.trim() || !!busy}>Send</Button>
          </form>
        </section>
      )}
    </div>
  );
}
