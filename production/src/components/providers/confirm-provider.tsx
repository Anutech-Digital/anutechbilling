/**
 * ConfirmProvider + useConfirm — app-wide, promise-based confirmation dialog.
 *
 * WHY THIS EXISTS: native `window.confirm()` is suppressed in some embedded
 * browsers / webviews (and the desktop app's preview pane) and silently returns
 * `false`. That made destructive actions gated on it — delete, archive, reopen,
 * salary-undo — look completely dead: the click did nothing. This replaces every
 * such prompt with the design-system <Dialog>.
 *
 * Usage (minimal swap from window.confirm):
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: "Delete this?", danger: true })) del.mutate();
 *
 * The mutation runs AFTER the dialog closes (the promise resolves on click), so
 * feedback is via the caller's own toast / loading state, exactly as before.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export interface ConfirmOptions {
  title: string;
  /** Supporting text. `\n` is rendered as a line break. */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Icon registry name. Defaults to "alert" (danger) or "question". */
  icon?: string;
  /** Red destructive styling on the confirm button. */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/** Returns a `confirm(opts) => Promise<boolean>` function. */
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null);
  const resolverRef = React.useRef<((v: boolean) => void) | null>(null);

  const confirm = React.useCallback<ConfirmFn>((options) => {
    setOpts(options);
    return new Promise<boolean>((resolve) => { resolverRef.current = resolve; });
  }, []);

  const settle = React.useCallback((result: boolean) => {
    setOpts(null);
    resolverRef.current?.(result);
    resolverRef.current = null;
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={!!opts} onOpenChange={(o) => { if (!o) settle(false); }}>
        <DialogContent className="md:!max-w-[440px]">
          {opts && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Icon
                    name={opts.icon ?? (opts.danger ? "alert" : "question")}
                    size={18}
                    className={opts.danger ? "text-rose" : "text-amber"}
                  />
                  {opts.title}
                </DialogTitle>
                {opts.body && (
                  <DialogDescription className="whitespace-pre-line">{opts.body}</DialogDescription>
                )}
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => settle(false)}>
                  {opts.cancelLabel ?? "Cancel"}
                </Button>
                <Button
                  type="button"
                  variant={opts.danger ? "danger" : "primary"}
                  icon={opts.icon}
                  onClick={() => settle(true)}
                  autoFocus
                >
                  {opts.confirmLabel ?? "Confirm"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
