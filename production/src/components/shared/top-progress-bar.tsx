"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function TopProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const timerRef = React.useRef<NodeJS.Timeout | null>(null);
  const finishTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const safetyTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const lastTriggerTimeRef = React.useRef<number>(0);
  const lastTriggerHrefRef = React.useRef<string>("");

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

    if (finishTimeoutRef.current) clearTimeout(finishTimeoutRef.current);
    finishTimeoutRef.current = setTimeout(() => {
      setLoading(false);
      setTimeout(() => {
        setProgress(0);
        lastTriggerHrefRef.current = "";
      }, 300);
    }, 350);
  }, []);

  const startProgress = React.useCallback(() => {
    if (finishTimeoutRef.current) clearTimeout(finishTimeoutRef.current);
    if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
    if (timerRef.current) clearInterval(timerRef.current);

    setLoading(true);
    setProgress(15);

    timerRef.current = setInterval(() => {
      setProgress((prev) => {
        if (prev < 30) return prev + Math.floor(Math.random() * 8 + 6);
        if (prev < 60) return prev + Math.floor(Math.random() * 6 + 4);
        if (prev < 85) return prev + Math.floor(Math.random() * 3 + 2);
        if (prev < 95) return Math.min(95, prev + 0.5);
        return prev;
      });
    }, 100);

    // FAIL-SAFE: If any navigation, shallow routing or event is slow or drops,
    // auto-complete after 1.8s so the UI NEVER stays permanently stuck at 95%.
    safetyTimeoutRef.current = setTimeout(() => {
      finishProgress();
    }, 1800);
  }, [finishProgress]);

  // When pathname or searchParams change to a new URL, complete the progress bar
  React.useEffect(() => {
    if (prevFullUrlRef.current !== currentFullUrl) {
      prevFullUrlRef.current = currentFullUrl;
      if (loading) {
        finishProgress();
      }
    }
  }, [currentFullUrl, loading, finishProgress]);

  // Intercept pointerdown and click on internal links to start progress immediately (0ms)
  React.useEffect(() => {
    const handleTrigger = (e: MouseEvent | PointerEvent) => {
      // Don't intercept right clicks or secondary buttons
      if ("button" in e && e.button !== 0) return;
      const target = (e.target as HTMLElement).closest("a");
      if (!target) return;

      const href = target.getAttribute("href");
      if (!href) return;

      // Only handle internal links that are not target="_blank" or anchor/download
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

      // If user is already on this exact full destination, don't trigger progress bar
      if (urlWithoutHash === windowFullUrl || urlWithoutHash === currentFullUrl) {
        return;
      }

      lastTriggerTimeRef.current = now;
      lastTriggerHrefRef.current = href;
      startProgress();
    };

    // Global navigation & tab events
    const handleStart = () => startProgress();
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
      className="fixed top-0 left-0 right-0 z-[99999] pointer-events-none transition-opacity duration-300"
      style={{ opacity: loading ? 1 : 0 }}
      aria-hidden="true"
    >
      {/* Background Track */}
      <div className="h-[3.5px] w-full bg-black/5 overflow-visible relative">
        {/* Progress Bar with Glowing Gradient */}
        <div
          className="h-full bg-gradient-to-r from-amber-500 via-blue-600 to-indigo-600 transition-all duration-150 ease-out shadow-[0_0_12px_rgba(37,99,235,0.8),0_0_4px_rgba(245,158,11,0.6)] relative"
          style={{ width: `${progress}%` }}
        >
          {/* Glowing Animated Shimmer at the tip */}
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white blur-[1.5px] opacity-90 shadow-[0_0_8px_#ffffff]" />

          {/* Floating Percent Badge at the head of the progress bar */}
          <div
            className="absolute right-0 top-[7px] flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-900/95 text-white font-mono text-[10px] font-bold shadow-xl border border-white/20 backdrop-blur-md select-none transition-transform duration-100 ease-out"
            style={{
              transform:
                progress > 88
                  ? "translateX(-100%)"
                  : progress < 12
                  ? "translateX(0%)"
                  : "translateX(-50%)",
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>{displayPercent}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
