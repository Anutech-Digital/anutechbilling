"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useSubmitFeedback } from "@/lib/queries/feedback";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { ImageViewer } from "@/components/shared/image-viewer";

/* Types live with the triage engine now — one definition, so the dialog cannot offer a
   value the engine and the DB check constraint do not know about. */
import type { FeedbackType, FeedbackSeverity } from "@/lib/feedback/triage";
export type { FeedbackType };
export type FeedbackPriority = FeedbackSeverity;

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ScreenshotItem {
  id: string;
  name: string;
  dataUrl: string;
}

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const pathname = usePathname();
  const { data: currentUser } = useCurrentUser();

  const [type, setType] = React.useState<FeedbackType>("bug");
  const [priority, setPriority] = React.useState<FeedbackPriority>("medium");
  const [promptText, setPromptText] = React.useState("");
  const [screenshots, setScreenshots] = React.useState<ScreenshotItem[]>([]);
  const [capturing, setCapturing] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [preview, setPreview] = React.useState<ScreenshotItem | null>(null);

  const submit = useSubmitFeedback();
  const submitting = submit.isPending;

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Global Clipboard Paste (Ctrl + V) Handler for MULTIPLE Screenshots
  const handlePaste = React.useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = (evt) => {
          const newScreenshot: ScreenshotItem = {
            id: crypto.randomUUID(),
            name: `pasted_screen_${Date.now()}_${i + 1}.png`,
            dataUrl: evt.target?.result as string,
          };
          setScreenshots((prev) => [...prev, newScreenshot]);
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  // Instant Auto Screenshot Capture feature using html2canvas
  const handleAutoCaptureScreen = async () => {
    setCapturing(true);
    toast.info("Capturing current screen...", { duration: 1500 });

    try {
      // Hide dialog temporarily for 220ms to capture clean web page DOM
      onOpenChange(false);
      await new Promise((resolve) => setTimeout(resolve, 220));

      // Loaded on click only: this dialog is mounted in the topbar of every page, and a
      // static import shipped ~200 KB of html2canvas in every app bundle.
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(document.body, {
        useCORS: true,
        allowTaint: true,
        scale: 1,
      });

      const dataUrl = canvas.toDataURL("image/png");
      const newScreenshot: ScreenshotItem = {
        id: crypto.randomUUID(),
        name: `auto_screen_${Date.now()}.png`,
        dataUrl,
      };
      setScreenshots((prev) => [...prev, newScreenshot]);

    } catch (err: unknown) {
      console.error("Auto screen capture failed:", err);
      toast.error("Could not auto-capture screen. Use Ctrl + V or upload image files.");
    } finally {
      setCapturing(false);
      onOpenChange(true);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) {
        toast.error(`"${file.name}" is not an image file.`);
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        toast.error(`"${file.name}" exceeds 5MB size limit.`);
        return;
      }

      const reader = new FileReader();
      reader.onload = (evt) => {
        const newScreenshot: ScreenshotItem = {
          id: crypto.randomUUID(),
          name: file.name,
          dataUrl: evt.target?.result as string,
        };
        setScreenshots((prev) => [...prev, newScreenshot]);
      };
      reader.readAsDataURL(file);
    });

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) { toast.error(`"${file.name}" exceeds 5MB size limit.`); continue; }
      const reader = new FileReader();
      reader.onload = (evt) => setScreenshots((prev) => [...prev, { id: crypto.randomUUID(), name: file.name, dataUrl: evt.target?.result as string }]);
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveScreenshot = (id: string) => {
    setScreenshots((prev) => prev.filter((s) => s.id !== id));
  };

  /**
   * Submit.
   *
   * ─── THE RULE THIS FUNCTION EXISTS TO ENFORCE ─────────────────────────────
   * Nothing here says "thank you" until the row is actually in the database. The
   * version this replaced logged a failed insert to the console and thanked the
   * reporter regardless, with a comment about a "local feedback store" that did not
   * exist. A reporter who is thanked stops mentioning the problem, so a swallowed
   * report is not one lost message — it is a bug that nobody will ever raise again.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedPrompt = promptText.trim();
    if (!cleanedPrompt) {
      toast.error("Please enter details in the report box");
      return;
    }

    try {
      const result = await submit.mutateAsync({
        // Never defaulted. It once defaulted to Anutech Digital's tenant id, which filed
        // another tenant's bug report into Anutech's books.
        tenantId: currentUser?.tenantId ?? "",
        reportedType: type,
        reportedSeverity: priority,
        text: cleanedPrompt,
        pagePath: pathname,
        reporterId: currentUser?.userId ?? null,
        reporterName: currentUser?.fullName ?? null,
        reporterEmail: currentUser?.authEmail ?? null,
        screenshots: screenshots.map((s) => ({ name: s.name, dataUrl: s.dataUrl })),
      });

      // The report is saved by this point. Everything below is about being honest
      // regarding the parts that are not.
      const parts: string[] = [];
      if (result.uploaded > 0) parts.push(`${result.uploaded} screenshot(s) attached`);
      if (!result.triaged) parts.push("AI triage will run when you open /admin/feedback");

      if (result.failedUploads.length > 0) {
        // Deliberately a warning and not a success: the words were saved, the pictures
        // were not, and the reporter is the only person who can attach them again.
        toast.warning(`Report saved — but ${result.failedUploads.length} screenshot(s) did not upload.`, {
          description: `Not attached: ${result.failedUploads.join(", ")}. The report itself is safe; please re-attach from /admin/feedback if they matter.`,
          duration: 10_000,
        });
      } else {
        toast.success("Report submitted — thank you.", {
          description: parts.length ? parts.join(" · ") : "It is now in the triage queue.",
        });
      }

      setPromptText("");
      setScreenshots([]);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not submit the report.";
      // Nothing is cleared and the dialog stays open, so the text the reporter typed is
      // still on screen and a retry costs one click instead of retyping it.
      toast.error(msg, {
        description: "Your report was NOT saved. The text is still here — try again in a moment.",
        duration: 10_000,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onPaste={handlePaste}
        className="sm:max-w-[620px] p-0 max-h-[92vh] flex flex-col overflow-hidden shadow-2xl z-[99999]"
      >
        <DialogHeader className="p-6 pb-4 border-b border-hairline bg-paper/95 backdrop-blur-xs sticky top-0 z-10 flex-shrink-0">
          <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider mb-1">
            <Icon name="bug" size={16} />
            <span>Team Software Testing & Bug Reporter</span>
          </div>
          <DialogTitle className="text-xl md:text-2xl font-serif">Report Bug / Suggest Feature</DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            Write it in one box. Paste screenshots with <b>Ctrl + V</b> and they show right in the box.
          </DialogDescription>
          {/* Where reports go (5 Oct 2026: "Admin / Feedback menu option missing from sidebar"
              — it lives under Automation, which nobody looks in while reporting a bug). Same
              owner/manager roles as the nav entry. */}
          {(currentUser?.role === "owner" || currentUser?.role === "manager") && (
            <Link href="/admin/feedback" onClick={() => onOpenChange(false)} className="text-xs font-semibold text-primary hover:underline self-start">
              See all reports →
            </Link>
          )}
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Report Category */}
          <FormField label="Report Type">
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setType("bug")}
                className={`p-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-2 transition-all ${
                  type === "bug"
                    ? "bg-rose-soft border-rose text-rose-ink font-bold shadow-sm"
                    : "bg-paper-2 border-hairline text-ink-2 hover:bg-paper-3"
                }`}
              >
                <Icon name="bug" size={14} />
                <span>🐛 Bug / Error</span>
              </button>
              <button
                type="button"
                onClick={() => setType("feature")}
                className={`p-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-2 transition-all ${
                  type === "feature"
                    ? "bg-indigo-soft border-indigo text-indigo-ink font-bold shadow-sm"
                    : "bg-paper-2 border-hairline text-ink-2 hover:bg-paper-3"
                }`}
              >
                <Icon name="sparkles" size={14} />
                <span>💡 Feature Idea</span>
              </button>
              <button
                type="button"
                onClick={() => setType("ui_improvement")}
                className={`p-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-2 transition-all ${
                  type === "ui_improvement"
                    ? "bg-amber-soft border-amber text-amber-ink font-bold shadow-sm"
                    : "bg-paper-2 border-hairline text-ink-2 hover:bg-paper-3"
                }`}
              >
                <Icon name="sliders" size={14} />
                <span>🎨 UI Polish</span>
              </button>
            </div>
          </FormField>

          {/* Priority */}
          <FormField label="Severity / Priority">
            <div className="grid grid-cols-4 gap-2">
              {(["low", "medium", "high", "critical"] as FeedbackPriority[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`py-1.5 px-2 rounded-md border text-2xs font-bold uppercase tracking-wider transition-all ${
                    priority === p
                      ? p === "critical"
                        ? "bg-rose text-white border-rose shadow-sm"
                        : p === "high"
                        ? "bg-amber text-paper border-amber shadow-sm"
                        : "bg-ink text-paper border-ink shadow-sm"
                      : "bg-paper-2 border-hairline text-ink-3 hover:bg-paper-3"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </FormField>

          {/* One box, like a chat composer (5 Oct 2026, Pardeep): pasted, dropped, uploaded and
              auto-captured screenshots all show INSIDE the box as thumbnails above the text, and
              the capture / attach buttons live in the box's own toolbar. */}
          <FormField label="Details & Steps" htmlFor="feedback-details">
            <input type="file" accept="image/*" multiple ref={fileInputRef} onChange={handleFileChange} className="hidden" />
            <div
              onDragOver={(e) => { if (Array.from(e.dataTransfer.items).some((i) => i.type.startsWith("image/"))) { e.preventDefault(); setDragging(true); } }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`rounded-xl border bg-paper transition-shadow focus-within:ring-2 focus-within:ring-primary ${dragging ? "border-primary ring-2 ring-primary/40 bg-primary-soft/20" : "border-hairline"}`}
            >
              {screenshots.length > 0 && (
                <ul className="flex flex-wrap gap-2 p-2.5 pb-0" aria-label={`${screenshots.length} screenshot(s) attached`}>
                  {screenshots.map((s, idx) => (
                    <li key={s.id} className="relative">
                      <button
                        type="button"
                        onClick={() => setPreview(s)}
                        title={`View ${s.name}`}
                        className="block w-20 h-16 rounded-lg overflow-hidden border border-hairline bg-paper-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                      >
                        <img src={s.dataUrl} alt={`Screenshot ${idx + 1}`} className="w-full h-full object-cover" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveScreenshot(s.id)}
                        aria-label={`Remove screenshot ${idx + 1}`}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-ink text-paper flex items-center justify-center shadow ring-2 ring-paper hover:bg-rose"
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <textarea
                id="feedback-details"
                className="block w-full min-h-[110px] p-3 bg-transparent border-0 shadow-none ring-0 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-0 focus-visible:ring-0 focus:border-0 leading-relaxed resize-y"
                placeholder={
                  type === "bug"
                    ? "What happened, and the steps to see it. Paste a screenshot with Ctrl + V and it shows here."
                    : type === "feature"
                    ? "Describe your feature request or new workflow suggestion..."
                    : "Describe the UI alignment or design change needed..."
                }
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                required
              />
              <div className="flex items-center gap-1 px-2 pb-2 text-ink-3">
                <button
                  type="button"
                  onClick={handleAutoCaptureScreen}
                  disabled={capturing}
                  title="Capture this screen"
                  className="h-8 px-2 rounded-md flex items-center gap-1.5 text-xs font-medium hover:bg-paper-2 hover:text-ink disabled:opacity-60"
                >
                  <Icon name="camera" size={15} />
                  <span>{capturing ? "Capturing…" : "Capture screen"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach an image"
                  className="h-8 px-2 rounded-md flex items-center gap-1.5 text-xs font-medium hover:bg-paper-2 hover:text-ink"
                >
                  <Icon name="upload" size={15} />
                  <span>Attach</span>
                </button>
                <span className="ml-auto text-2xs font-mono text-ink-4">
                  {screenshots.length > 0 && `${screenshots.length} image${screenshots.length > 1 ? "s" : ""} · `}{promptText.length} chars
                </span>
              </div>
            </div>
          </FormField>

          {/* Auto captured Page URL */}
          <div className="p-2.5 bg-paper-2 border border-hairline rounded-md flex items-center justify-between text-xs text-ink-3">
            <div className="flex items-center gap-1.5 min-w-0">
              <Icon name="link" size={13} className="text-ink-4 flex-shrink-0" />
              <span>Current Page:</span>
              <span className="font-mono text-ink font-medium truncate">{pathname}</span>
            </div>
            <span className="text-3xs uppercase font-bold text-emerald flex-shrink-0 ml-2">Auto-Captured</span>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={submitting} className="font-bold">
              {submitting ? "Submitting…" : "Submit report"}
            </Button>
          </div>
        </form>

        <ImageViewer src={preview?.dataUrl ?? null} name={preview?.name} onClose={() => setPreview(null)} />
      </DialogContent>
    </Dialog>
  );
}
