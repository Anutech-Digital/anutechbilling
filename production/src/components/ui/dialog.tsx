/**
 * Dialog — accessible modal (Radix-based).
 *
 * @example
 * <Dialog>
 *   <DialogTrigger asChild><Button>Open</Button></DialogTrigger>
 *   <DialogContent>
 *     <DialogHeader>
 *       <DialogTitle>Delete subscription?</DialogTitle>
 *       <DialogDescription>This cannot be undone.</DialogDescription>
 *     </DialogHeader>
 *     <DialogFooter>
 *       <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
 *       <Button variant="danger">Delete</Button>
 *     </DialogFooter>
 *   </DialogContent>
 * </Dialog>
 */
"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** Edge/corner drag handles for resizing. Rendered as a fixed overlay that
 *  mirrors the dialog's box, so it never interferes with the dialog's own
 *  scroll or padding (works for every dialog, including `p-0` ones). */
const RESIZE_HANDLES: { dir: string; cls: string }[] = [
  { dir: "n",  cls: "top-0 left-0 right-0 h-1.5 cursor-ns-resize" },
  { dir: "s",  cls: "bottom-0 left-0 right-0 h-1.5 cursor-ns-resize" },
  { dir: "e",  cls: "top-0 bottom-0 right-0 w-1.5 cursor-ew-resize" },
  { dir: "w",  cls: "top-0 bottom-0 left-0 w-1.5 cursor-ew-resize" },
  { dir: "ne", cls: "top-0 right-0 h-3 w-3 cursor-nesw-resize" },
  { dir: "nw", cls: "top-0 left-0 h-3 w-3 cursor-nwse-resize" },
  { dir: "se", cls: "bottom-0 right-0 h-3 w-3 cursor-nwse-resize" },
  { dir: "sw", cls: "bottom-0 left-0 h-3 w-3 cursor-nesw-resize" },
];

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Hide the default close (X) button in the corner */
    hideClose?: boolean;
    /** Allow the user to drag-resize this dialog (desktop only). Default on. */
    resizable?: boolean;
  }
>(({ className, children, hideClose, resizable = true, style, ...props }, ref) => {
  // Size the user has dragged the dialog to (null = natural / default size).
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);
  // Offset (px) the user has dragged the dialog away from centre (null = centred).
  const [pos, setPos] = React.useState<{ dx: number; dy: number } | null>(null);
  // Live bounding box of the dialog, mirrored onto the handle overlay.
  const [box, setBox] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const innerRef = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{ dir: string; x: number; y: number; w: number; h: number } | null>(null);
  const moveRef = React.useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

  const syncBox = React.useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBox((prev) =>
      prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height
        ? prev
        : { left: r.left, top: r.top, width: r.width, height: r.height }
    );
  }, []);

  const setRefs = React.useCallback((node: HTMLDivElement | null) => {
    innerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    // Measure as soon as the node mounts — more reliable than a layout effect
    // for the initial paint of the handle overlay.
    if (node) syncBox();
  }, [ref, syncBox]);

  // Keep the handle overlay aligned with the dialog as it (re)sizes.
  React.useLayoutEffect(() => {
    if (!resizable) return;
    syncBox();
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncBox);
    ro.observe(el);
    window.addEventListener("resize", syncBox);
    return () => { ro.disconnect(); window.removeEventListener("resize", syncBox); };
  }, [resizable, syncBox]);

  const onMove = React.useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    let w = d.w, h = d.h;
    // Dialog is centre-anchored (translate -50%), so an edge tracks the pointer
    // when the dimension changes by 2× the drag distance.
    if (d.dir.includes("e")) w = d.w + 2 * dx;
    if (d.dir.includes("w")) w = d.w - 2 * dx;
    if (d.dir.includes("s")) h = d.h + 2 * dy;
    if (d.dir.includes("n")) h = d.h - 2 * dy;
    w = Math.max(320, Math.min(w, window.innerWidth * 0.96));
    h = Math.max(200, Math.min(h, window.innerHeight * 0.94));
    setSize({ w, h });
  }, []);

  const onUp = React.useCallback(() => {
    drag.current = null;
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }, [onMove]);

  const startDrag = React.useCallback((dir: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { dir, x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [onMove, onUp]);

  React.useEffect(() => () => {
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }, [onMove, onUp]);

  // ── Drag-to-move: grab any non-interactive part of the dialog (header, blank
  //    space, labels) and reposition it anywhere on screen. Desktop only.
  const onMoving = React.useCallback((e: PointerEvent) => {
    const m = moveRef.current;
    if (!m) return;
    let dx = m.dx + (e.clientX - m.x);
    let dy = m.dy + (e.clientY - m.y);
    // Keep the dialog reachable — don't let it fully leave the viewport.
    const maxX = window.innerWidth / 2;
    const maxY = window.innerHeight / 2;
    dx = Math.max(-maxX + 80, Math.min(dx, maxX - 80));
    dy = Math.max(-maxY + 40, Math.min(dy, maxY - 40));
    setPos({ dx, dy });
  }, []);

  const onMoveUp = React.useCallback(() => {
    moveRef.current = null;
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMoving);
    window.removeEventListener("pointerup", onMoveUp);
  }, [onMoving]);

  // Move is started ONLY from the two top-corner grips (below) — never by
  // dragging the body — so it never fights with scrolling or clicking fields.
  const startMove = React.useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (typeof window !== "undefined" && window.innerWidth < 768) return; // desktop only
    e.preventDefault();
    e.stopPropagation();
    moveRef.current = { x: e.clientX, y: e.clientY, dx: pos?.dx ?? 0, dy: pos?.dy ?? 0 };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMoving);
    window.addEventListener("pointerup", onMoveUp);
  }, [pos, onMoving, onMoveUp]);

  React.useEffect(() => () => {
    window.removeEventListener("pointermove", onMoving);
    window.removeEventListener("pointerup", onMoveUp);
  }, [onMoving, onMoveUp]);

  return (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={setRefs}
      style={{
        ...(size ? { ["--dlg-w"]: `${size.w}px`, ["--dlg-h"]: `${size.h}px` } : {}),
        ...(pos ? { ["--dlg-x"]: `${pos.dx}px`, ["--dlg-y"]: `${pos.dy}px` } : {}),
        ...style,
      } as React.CSSProperties}
      className={cn(
        // ── Mobile (default): bottom sheet — slides up from viewport bottom,
        //    full-width, top-rounded only.
        // ── Desktop (md+): centered modal.
        //
        // We use `!important` (`!`) on every md: positioning rule because
        // tailwind-merge and CSS source-order can silently let mobile rules
        // win on desktop otherwise. Confirmed via preview_inspect — without
        // `!`, `right-0` from mobile bleeds into md and forces the dialog
        // against the right edge of the viewport.
        "fixed left-0 right-0 bottom-0 z-50 grid w-full",
        "max-h-[90vh] overflow-y-auto",
        "gap-4 border-t border-hairline bg-paper p-5 pb-6 shadow-2xl",
        "rounded-t-2xl",
        // Safe-area for iPhone notch / Android gesture bar
        "pb-[max(1.5rem,env(safe-area-inset-bottom))]",
        // Mobile open/close: slide up from bottom
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",

        // Desktop position — `!` forces override of the mobile anchors.
        "md:!left-1/2 md:!right-auto md:!top-1/2 md:!bottom-auto",
        "md:!w-auto md:!max-w-xl md:max-h-[90vh] md:-translate-x-1/2 md:-translate-y-1/2",
        "md:rounded-lg md:border md:p-6",
        "md:data-[state=closed]:zoom-out-95 md:data-[state=open]:zoom-in-95",
        "md:data-[state=closed]:slide-out-to-left-1/2 md:data-[state=closed]:slide-out-to-top-[48%]",
        "md:data-[state=open]:slide-in-from-left-1/2 md:data-[state=open]:slide-in-from-top-[48%]",
        // Reset mobile-only slides on desktop
        "md:data-[state=closed]:slide-out-to-bottom-0 md:data-[state=open]:slide-in-from-bottom-0",
        size && "dlg-resizable",
        pos && "dlg-movable",
        className
      )}
      {...props}
    >
      {/* Drag handle (mobile only — visual affordance that the sheet is dismissible) */}
      <div className="md:hidden mx-auto -mt-1 mb-2 h-1.5 w-12 rounded-full bg-hairline" aria-hidden />

      {/* Move grips (desktop only) — the ONLY way to reposition the dialog: grab
          the top-left or top-right corner and drag it anywhere on screen. */}
      <div
        onPointerDown={startMove}
        title="Drag to move"
        aria-hidden
        className="hidden md:flex absolute left-1.5 top-1.5 z-[61] h-6 w-6 cursor-move items-center justify-center rounded text-ink-3/40 hover:text-ink-2 hover:bg-paper-2 touch-none"
      >
        <GripVertical className="h-4 w-4" />
      </div>
      <div
        onPointerDown={startMove}
        title="Drag to move"
        aria-hidden
        className="hidden md:flex absolute right-12 top-1.5 z-[61] h-6 w-6 cursor-move items-center justify-center rounded text-ink-3/40 hover:text-ink-2 hover:bg-paper-2 touch-none"
      >
        <GripVertical className="h-4 w-4" />
      </div>

      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          className={cn(
            "absolute right-4 top-4 z-[62] rounded-sm opacity-70 transition-opacity hover:opacity-100",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
            "disabled:pointer-events-none"
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>

    {/* Resize handles — desktop only. Fixed overlay mirroring the dialog box so
        it never disturbs the dialog's own layout/scroll. */}
    {resizable && box && (
      <div
        className="hidden md:block fixed z-[60] pointer-events-none"
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        aria-hidden
      >
        {RESIZE_HANDLES.map((h) => (
          <div
            key={h.dir}
            onPointerDown={startDrag(h.dir)}
            className={cn(
              "absolute pointer-events-auto touch-none select-none",
              (h.dir.length === 2) && "z-[61]",
              h.cls
            )}
          />
        ))}
      </div>
    )}
  </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName; // resizable dialogs

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col gap-1 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-2",
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("font-serif text-xl leading-tight text-ink", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-ink-3 leading-relaxed", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
