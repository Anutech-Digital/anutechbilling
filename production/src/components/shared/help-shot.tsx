"use client";

/**
 * Screenshots for the Help panel (R-189, moved out of ai-help.tsx by R-383 so the Ask tab and
 * the "Report a problem" tab share one capture + crop path).
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";

/** Everything inside the Help panel carries this attribute — kept out of captures and the trail. */
export const HELP_SELF = "[data-ai-help]";

/** R-189: one screenshot that goes with the next message (and is filed with the report). */
export interface Shot { dataUrl: string; mimeType: "image/jpeg"; base64: string }

/** Shrink to ≤1280px wide JPEG so a screenshot stays well under the route's 2 MB limit. */
export async function toShot(source: HTMLCanvasElement | Blob): Promise<Shot | null> {
  let canvas: HTMLCanvasElement;
  if (source instanceof HTMLCanvasElement) canvas = source;
  else {
    const bmp = await createImageBitmap(source);
    canvas = document.createElement("canvas");
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext("2d")?.drawImage(bmp, 0, 0);
  }
  const scale = Math.min(1, 1280 / canvas.width);
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale); out.height = Math.round(canvas.height * scale);
  out.getContext("2d")?.drawImage(canvas, 0, 0, out.width, out.height);
  for (const q of [0.72, 0.55, 0.4]) {
    const dataUrl = out.toDataURL("image/jpeg", q);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (base64.length < 1_900_000) return { dataUrl, mimeType: "image/jpeg", base64 };
  }
  return null;
}

/** A picture of the page behind the panel (the panel itself is left out). Null when the browser refuses. */
export async function captureViewport(): Promise<HTMLCanvasElement | null> {
  try {
    const { default: html2canvas } = await import("html2canvas");
    return await html2canvas(document.body, {
      useCORS: true, allowTaint: true, scale: 1,
      ignoreElements: (el) => el instanceof Element && !!el.closest?.(HELP_SELF),
      width: window.innerWidth, height: window.innerHeight, x: window.scrollX, y: window.scrollY,
    });
  } catch {
    return null;
  }
}


/**
 * R-189 (Pardeep, 6 Oct: "poora page na lekar kuch portion ka hi screen lena ho"): after the
 * capture, the picture opens full-screen; drag a box over the part you want, or keep it all.
 * Coordinates are mapped from the displayed image back to the canvas, so the crop is exact
 * at any zoom. Pointer events, so mouse and touch both work.
 */
export function CropOverlay({ src, onDone, onCancel }: { src: HTMLCanvasElement; onDone: (c: HTMLCanvasElement) => void; onCancel: () => void }) {
  const imgRef = React.useRef<HTMLImageElement>(null);
  const [box, setBox] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const start = React.useRef<{ x: number; y: number } | null>(null);
  const url = React.useMemo(() => src.toDataURL("image/png"), [src]);

  const pos = (e: React.PointerEvent) => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)) };
  };
  const down = (e: React.PointerEvent) => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); start.current = pos(e); setBox({ ...start.current, w: 0, h: 0 }); };
  const move = (e: React.PointerEvent) => {
    if (!start.current) return;
    const p = pos(e);
    setBox({ x: Math.min(p.x, start.current.x), y: Math.min(p.y, start.current.y), w: Math.abs(p.x - start.current.x), h: Math.abs(p.y - start.current.y) });
  };
  const up = () => { start.current = null; };

  function applySelection() {
    const img = imgRef.current;
    if (!img || !box || box.w < 8 || box.h < 8) return;
    const k = src.width / img.getBoundingClientRect().width;
    const out = document.createElement("canvas");
    out.width = Math.round(box.w * k); out.height = Math.round(box.h * k);
    out.getContext("2d")?.drawImage(src, box.x * k, box.y * k, box.w * k, box.h * k, 0, 0, out.width, out.height);
    onDone(out);
  }

  return (
    /* R-302: a Radix dialog, so focus is trapped inside while cropping, Esc cancels, and focus
       returns to AI Help afterwards. data-ai-help on the portalled nodes keeps these clicks out
       of the test trail, as before. */
    <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-ai-help className="fixed inset-0 z-[60] bg-black/70" />
      <DialogPrimitive.Content data-ai-help className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 p-3 outline-none">
      <DialogPrimitive.Title className="sr-only">Choose part of the screenshot</DialogPrimitive.Title>
      <DialogPrimitive.Description className="text-sm text-white text-center">Drag a box over the part you want — or keep the whole screen.</DialogPrimitive.Description>
      <div className="relative max-w-full max-h-[75vh] touch-none select-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imgRef} src={url} alt="Screenshot to crop" draggable={false}
          className="max-w-full max-h-[75vh] rounded-md cursor-crosshair"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} />
        {box && box.w > 0 && (
          <div className="absolute border-2 border-amber bg-amber/10 pointer-events-none" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
        )}
      </div>
      <div className="flex gap-2 flex-wrap justify-center">
        <Button size="sm" variant="primary" disabled={!box || box.w < 8 || box.h < 8} onClick={applySelection}>Use selection</Button>
        <Button size="sm" variant="outline" className="bg-paper" onClick={() => onDone(src)}>Whole screen</Button>
        <Button size="sm" variant="ghost" className="text-white" onClick={onCancel}>Cancel</Button>
      </div>
      </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
