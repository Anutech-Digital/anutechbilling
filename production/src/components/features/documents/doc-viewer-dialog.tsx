/**
 * DocViewerDialog — preview a stored document INSIDE the app.
 *
 * Fetches the file's signed URL, loads the bytes, and renders it in a modal:
 *   • PDF   → rendered page-by-page to <canvas> via pdf.js (does NOT depend on
 *             the browser's native PDF plugin, so it works everywhere).
 *   • image → shown in an <img>.
 *   • other → a Download button.
 * A Download button is always available too.
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  mimeType?: string | null;
  fileName?: string | null;
  filePath: string;
  /** Returns a fresh short-lived signed URL for the given storage path. */
  signer: (filePath: string) => Promise<string | null>;
}

export function DocViewerDialog({ open, onOpenChange, title, mimeType, fileName, filePath, signer }: Props) {
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<"pdf" | "image" | "other">("other");
  const [imgUrl, setImgUrl] = React.useState<string | null>(null);
  const [dlUrl, setDlUrl] = React.useState<string | null>(null);
  const canvasWrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const created: string[] = [];
    setLoading(true); setErr(null); setImgUrl(null); setDlUrl(null); setKind("other");

    (async () => {
      try {
        const url = await signer(filePath);
        if (!url) throw new Error("Couldn't get a link for this file.");
        const res = await fetch(url);
        if (!res.ok) throw new Error("Couldn't load this file.");
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        const lname = (fileName ?? "").toLowerCase();
        const isPdf = (mimeType ?? "").includes("pdf") || lname.endsWith(".pdf");
        const isImg = (mimeType ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(lname);
        const dlType = isPdf ? "application/pdf" : (mimeType || "application/octet-stream");
        const dlObj = URL.createObjectURL(new Blob([buf], { type: dlType }));
        created.push(dlObj);
        if (cancelled) { created.forEach(URL.revokeObjectURL); return; }
        setDlUrl(dlObj);

        if (isImg) { setKind("image"); setImgUrl(dlObj); setLoading(false); return; }

        if (isPdf) {
          setKind("pdf");
          const pdfjs = await import("pdfjs-dist");
          // Serve the worker from /public (copied there) rather than bundling it
          // via `new URL(...import.meta.url)` — the latter makes Next's Terser
          // choke on the pre-minified worker at build time.
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const pdf = await pdfjs.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise;
          if (cancelled) return;
          const wrap = canvasWrapRef.current;
          if (wrap) wrap.innerHTML = "";
          const maxPages = Math.min(pdf.numPages, 25);
          for (let i = 1; i <= maxPages; i++) {
            if (cancelled) return;
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.className = "mx-auto mb-3 max-w-full h-auto rounded shadow-sm bg-white";
            const ctx = canvas.getContext("2d");
            if (ctx && wrap && !cancelled) {
              wrap.appendChild(canvas);
              await page.render({ canvasContext: ctx, viewport }).promise;
            }
          }
          if (!cancelled) setLoading(false);
          return;
        }

        setKind("other"); setLoading(false);
      } catch (e) {
        if (!cancelled) { setErr((e as Error).message || "Couldn't open this file."); setLoading(false); }
      }
    })();

    return () => { cancelled = true; created.forEach(URL.revokeObjectURL); };
    // signer is a stable module function; re-run only when the file changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filePath]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-4xl p-0 gap-0 flex flex-col max-h-[92vh]">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-hairline flex-row items-center justify-between gap-3 space-y-0">
          <DialogTitle className="text-base truncate">{title}</DialogTitle>
          {dlUrl && (
            <a
              href={dlUrl}
              download={fileName ?? title}
              className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:border-hairline-strong shrink-0 mr-8"
            >
              <Icon name="download" size={13} /> Download
            </a>
          )}
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto bg-paper-2/40 p-4" style={{ height: "78vh" }}>
          {err ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <Icon name="alert" size={22} className="text-rose mb-2" />
              <p className="text-sm text-ink-2">{err}</p>
            </div>
          ) : (
            <>
              {loading && (
                <div className="space-y-3">
                  <Skeleton className="h-72 w-full" />
                  <p className="text-center text-2xs text-ink-3">Loading preview…</p>
                </div>
              )}
              {!loading && kind === "image" && imgUrl && (
                <div className="h-full flex items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imgUrl} alt={title} className="max-w-full max-h-full object-contain" />
                </div>
              )}
              {!loading && kind === "other" && (
                <div className="h-full flex flex-col items-center justify-center text-center px-6">
                  <Icon name="file" size={22} className="text-ink-3 mb-2" />
                  <p className="text-sm text-ink-2">This file type can&apos;t be previewed — use Download.</p>
                </div>
              )}
              {/* Always mounted so the render loop can append canvases. */}
              <div ref={canvasWrapRef} className={kind === "pdf" && !err ? "block" : "hidden"} />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
