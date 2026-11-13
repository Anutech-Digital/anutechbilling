"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Extract a clean human-readable name from target URL or link text
function deriveTargetName(href: string, linkText?: string): string {
  if (linkText && linkText.length > 1 && linkText.length <= 28) {
    return linkText.replace(/^[+\s•\d()]+|[+\s•\d()]+$/g, "").trim();
  }
  try {
    const url = new URL(href, "http://localhost");
    const tab = url.searchParams.get("tab");
    if (tab) {
      if (tab === "expenses") return "Income & Expenses";
      if (tab === "banks") return "Bank Accounts";
      if (tab === "budget") return "Budget & Overview";
      if (tab === "vault") return "Document Vault";
      if (tab === "tax") return "ITR-1 Tax Assistant";
      return tab.charAt(0).toUpperCase() + tab.slice(1);
    }
    const path = url.pathname.replace(/^\/|\/$/g, "");
    if (!path) return "Home";
    const segment = path.split("/").pop() || "Page";
    return segment
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");
  } catch {
    return "Page";
  }
}

export function TopProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [stageText, setStageText] = React.useState("Connecting");
  const [targetName, setTargetName] = React.useState("");

  const timerRef = React.useRef<NodeJS.Timeout | null>(null);
  const finishTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const safetyTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const lastTriggerTimeRef = React.useRef<number>(0);
  const lastTriggerHrefRef = React.useRef<string>("");
  const navigationStartTimeRef = React.useRef<number>(0);
  const activeFetchesRef = React.useRef<number>(0);

  const currentFullUrl = React.useMemo(() => {
    const search = searchParams?.toString();
    return search ? `${pathname}?${search}` : pathname;
  }, [pathname, searchParams]);

  const prevFullUrlRef = React.useRef(currentFullUrl);

  const finishProgress = React.useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
    }

    setProgress(100);
    setStageText("Ready ✓");

    if (finishTimeoutRef.current) clearTimeout(finishTimeoutRef.current);
    finishTimeoutRef.current = setTimeout(() => {
      setLoading(false);
      setTimeout(() => {
        setProgress(0);
        setStageText("Connecting");
        setTargetName("");
        lastTriggerHrefRef.current = "";
      }, 250);
    }, 300);
  }, []);

  const startProgress = React.useCallback((targetLabel?: string) => {
    if (finishTimeoutRef.current) clearTimeout(finishTimeoutRef.current);
    if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
    if (timerRef.current) clearInterval(timerRef.current);

    const label = targetLabel || "";
    setTargetName(label);
    setLoading(true);
    setProgress(18);
    setStageText(label ? `Loading ${label}` : "Requesting route");
    navigationStartTimeRef.current = Date.now();

    // Realistic lifecycle progression based on time & network state
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - navigationStartTimeRef.current;

      setProgress((prev) => {
        let next = prev;
        if (elapsed < 200) {
          next = Math.min(38, prev + 6);
          setStageText(label ? `Loading ${label}` : "Requesting route");
        } else if (elapsed < 600) {
          // Data fetch / resource compilation stage
          next = Math.min(68, prev + 3.5);
          if (activeFetchesRef.current > 0) {
            setStageText(`Fetching data (${activeFetchesRef.current})`);
          } else {
            setStageText(label ? `Loading ${label}` : "Fetching data");
          }
        } else if (elapsed < 1200) {
          // Layout rendering & hydration stage
          next = Math.min(88, prev + 1.8);
          setStageText(label ? `Rendering ${label}` : "Rendering view");
        } else if (prev < 94) {
          // Finalizing
          next = Math.min(94, prev + 0.5);
          setStageText("Finalizing layout");
        }
        return next;
      });
    }, 80);

    // Fail-safe: auto-complete if navigation completes without an event
    safetyTimeoutRef.current = setTimeout(() => {
      finishProgress();
    }, 1800);
  }, [finishProgress]);

  // Hook into active fetch calls to track actual data queries in progress
  React.useEffect(() => {
    if (typeof window === "undefined" || !(window as any).fetch) return;
    const originalFetch = window.fetch;
    const customFetch = async (...args: Parameters<typeof fetch>) => {
      activeFetchesRef.current += 1;
      try {
        return await originalFetch(...args);
      } finally {
        activeFetchesRef.current = Math.max(0, activeFetchesRef.current - 1);
      }
    };
    window.fetch = customFetch;
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  // When pathname or searchParams change to a new URL, complete the progress bar
  React.useEffect(() => {
    if (prevFullUrlRef.current !== currentFullUrl) {
      prevFullUrlRef.current = currentFullUrl;
      if (loading) {
        // Fast, realistic transition to 100% on route change
        requestAnimationFrame(() => {
          finishProgress();
        });
      }
    }
  }, [currentFullUrl, loading, finishProgress]);

  // Intercept pointerdown and click on internal links to start progress immediately (0ms)
  React.useEffect(() => {
    const handleTrigger = (e: MouseEvent | PointerEvent) => {
      if ("button" in e && e.button !== 0) return;
      const target = (e.target as HTMLElement).closest("a");
      if (!target) return;

      const href = target.getAttribute("href");
      if (!href) return;

      const isInternal = href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/#");
      const isModified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
      const isNewTab = target.target === "_blank";

      if (!isInternal || isModified || isNewTab) return;

      const now = Date.now();
      // Debounce pointerdown + click on the same link within 450ms
      if (lastTriggerHrefRef.current === href && now - lastTriggerTimeRef.current < 450) {
        return;
      }

      const urlWithoutHash = href.split("#")[0];
      const windowFullUrl = typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : "";

      // If already on this exact destination, skip
      if (urlWithoutHash === windowFullUrl || urlWithoutHash === currentFullUrl) {
        return;
      }

      lastTriggerTimeRef.current = now;
      lastTriggerHrefRef.current = href;

      // Extract human-friendly name from link text or attribute
      const linkLabel = target.getAttribute("title") || target.textContent?.trim() || "";
      const derivedName = deriveTargetName(href, linkLabel);

      startProgress(derivedName);
    };

    const handleStart = (e?: Event) => {
      const customDetail = (e as CustomEvent)?.detail;
      const label = typeof customDetail === "string" ? customDetail : "";
      startProgress(label);
    };
    const handleDone = () => finishProgress();

    window.addEventListener("app:navigation-start", handleStart);
    window.addEventListener("app:navigation-end", handleDone);
    window.addEventListener("app:tab-change", handleDone);
    window.addEventListener("popstate", handleDone);

    document.addEventListener("pointerdown", handleTrigger, { capture: true, passive: true });
    document.addEventListener("click", handleTrigger, { capture: true });

    return () => {
      window.removeEventListener("app:navigation-start", handleStart);
      window.removeEventListener("app:navigation-end", handleDone);
      window.removeEventListener("app:tab-change", handleDone);
      window.removeEventListener("popstate", handleDone);
      document.removeEventListener("pointerdown", handleTrigger, { capture: true });
      document.removeEventListener("click", handleTrigger, { capture: true });
      if (timerRef.current) clearInterval(timerRef.current);
      if (finishTimeoutRef.current) clearTimeout(finishTimeoutRef.current);
      if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
    };
  }, [currentFullUrl, startProgress, finishProgress]);

  if (!loading && progress === 0) return null;

  const displayPercent = Math.min(100, Math.round(progress));

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[99999] pointer-events-none transition-opacity duration-250"
      style={{ opacity: loading ? 1 : 0 }}
      aria-hidden="true"
    >
      {/* Background Track */}
      <div className="h-[3.5px] w-full bg-black/5 overflow-visible relative">
        {/* Progress Bar with Glowing Gradient */}
        <div
          className="h-full bg-gradient-to-r from-amber-500 via-blue-600 to-indigo-600 transition-all duration-120 ease-out shadow-[0_0_12px_rgba(37,99,235,0.8),0_0_4px_rgba(245,158,11,0.6)] relative"
          style={{ width: `${progress}%` }}
        >
          {/* Glowing Animated Shimmer at the tip */}
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white blur-[1.5px] opacity-90 shadow-[0_0_8px_#ffffff]" />

          {/* Floating Realistic Badge at the head of the progress bar */}
          <div
            className="absolute right-0 top-[6px] flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-900/95 text-white font-mono text-[10px] font-medium shadow-xl border border-white/20 backdrop-blur-md select-none transition-transform duration-100 ease-out"
            style={{
              transform:
                progress > 85
                  ? "translateX(-100%)"
                  : progress < 15
                  ? "translateX(0%)"
                  : "translateX(-50%)",
            }}
          >
            {/* Status indicator dot */}
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                progress === 100
                  ? "bg-emerald-400"
                  : progress > 65
                  ? "bg-indigo-400 animate-pulse"
                  : progress > 35
                  ? "bg-blue-400 animate-pulse"
                  : "bg-amber-400 animate-pulse"
              }`}
            />
            {/* Percentage */}
            <span className="font-bold font-mono text-white tracking-tight">{displayPercent}%</span>
            {/* Contextual Realistic Stage Text */}
            <span className="text-slate-300 font-sans text-[9px] font-normal truncate max-w-[150px] border-l border-white/20 pl-1.5 ml-0.5">
              {stageText}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
