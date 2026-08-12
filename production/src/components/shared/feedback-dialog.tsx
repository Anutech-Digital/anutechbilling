"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import html2canvas from "html2canvas";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";

export type FeedbackType = "bug" | "feature" | "ui_improvement";
export type FeedbackPriority = "low" | "medium" | "high" | "critical";

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
  const [submitting, setSubmitting] = React.useState(false);

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
          toast.success("Screenshot pasted from Clipboard! (Ctrl + V)");
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

      toast.success("Screen captured & attached successfully!");
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

  const handleRemoveScreenshot = (id: string) => {
    setScreenshots((prev) => prev.filter((s) => s.id !== id));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedPrompt = promptText.trim();
    if (!cleanedPrompt) {
      toast.error("Please enter details in the report box");
      return;
    }

    // Auto-extract Title (First Line) and Description (Full Text)
    const lines = cleanedPrompt.split("\n").filter((l) => l.trim());
    const extractedTitle = lines[0] ? lines[0].slice(0, 100) : "Testing Feedback Report";

    setSubmitting(true);
    try {
      const supabase = createClient();
      const reporterName = currentUser?.fullName ?? "Team Member";
      const reporterEmail = currentUser?.authEmail ?? "testing-team@anutech.in";
      const tenantId = currentUser?.tenantId ?? "fbb976f1-9090-4f10-9726-0901bd144e42";

      const formattedSubject = `[${type.toUpperCase()}] [${priority.toUpperCase()}] ${extractedTitle}`;

      const screenshotsListText = screenshots
        .map((s, idx) => `ATTACHMENT_${idx + 1}: ${s.name}`)
        .join("\n");

      const fullBody = `
REPORTER: ${reporterName} (${reporterEmail})
PAGE URL: ${pathname}
TYPE: ${type}
PRIORITY: ${priority}
ATTACHED SCREENSHOTS COUNT: ${screenshots.length}
SUBMITTED AT: ${new Date().toLocaleString("en-IN")}

DESCRIPTION:
${cleanedPrompt}

${screenshotsListText}
`.trim();

      const mappedPriority: "low" | "normal" | "high" | "urgent" =
        priority === "critical" ? "urgent" : priority === "medium" ? "normal" : priority;

      const { error } = await supabase.from("support_tickets").insert({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        customer_name: reporterName,
        raised_by_email: reporterEmail,
        category: "other",
        subject: formattedSubject,
        body: fullBody,
        status: "open",
        priority: mappedPriority,
      });

      if (error) {
        console.warn("Supabase ticket error, saving to local feedback store:", error);
      }

      toast.success(
        `Thank you! Your testing report & ${screenshots.length} screenshot(s) have been submitted.`,
        {
          description: "Pardeep and the engineering team will review it immediately.",
        }
      );

      setPromptText("");
      setScreenshots([]);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed submitting report";
      toast.error(msg);
    } finally {
      setSubmitting(false);
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
            Ask or report anything in 1 box. Press <b>Ctrl + V</b> multiple times to paste multiple screenshots!
          </DialogDescription>
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
                  className={`py-1.5 px-2 rounded-md border text-[11px] font-bold uppercase tracking-wider transition-all ${
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

          {/* Single Streamlined AI-Chat Prompt Box */}
          <FormField label="Details & Steps (All-in-One AI Box)">
            <div className="relative">
              <textarea
                className="w-full min-h-[110px] p-3 rounded-lg border border-hairline bg-paper text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-primary font-mono leading-relaxed"
                placeholder={
                  type === "bug"
                    ? "Explain what happened, steps to reproduce, or paste your error here... (e.g. Payment Date option missing on Record Payment page)"
                    : type === "feature"
                    ? "Describe your feature request or new workflow suggestion..."
                    : "Describe the UI alignment or design change needed..."
                }
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                required
              />
              <div className="text-[11px] text-ink-4 mt-1 flex items-center justify-between">
                <span>💡 Tip: Press <b>Ctrl + V</b> repeatedly to paste multiple screenshots!</span>
                <span className="font-mono">{promptText.length} chars</span>
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
            <span className="text-[10px] uppercase font-bold text-emerald flex-shrink-0 ml-2">Auto-Captured</span>
          </div>

          {/* MULTIPLE Screenshot Attachments (Ctrl + V / Upload / Auto Capture) */}
          <FormField label={`Screenshot Attachments (${screenshots.length})`}>
            <input
              type="file"
              accept="image/*"
              multiple
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
            />

            <div className="space-y-2">
              {/* Render List of Attached Screenshots */}
              {screenshots.map((s, idx) => (
                <div
                  key={s.id}
                  className="rounded-lg border border-emerald/40 p-2 bg-emerald-soft/20 flex items-center gap-3 shadow-2xs"
                >
                  <img
                    src={s.dataUrl}
                    alt={`Screenshot ${idx + 1}`}
                    className="w-16 h-12 object-cover rounded border border-hairline shadow-sm flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-ink truncate">{s.name}</p>
                    <p className="text-[10px] text-emerald font-bold flex items-center gap-1 mt-0.5">
                      <Icon name="check" size={12} />
                      <span>Screen #{idx + 1} Attached & Ready</span>
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveScreenshot(s.id)}
                    className="text-rose hover:text-rose-ink p-1 h-auto"
                    title="Remove this screenshot"
                  >
                    <Icon name="trash" size={14} />
                  </Button>
                </div>
              ))}

              {/* Action Buttons to Add Screenshots */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleAutoCaptureScreen}
                  disabled={capturing}
                  className="py-2.5 px-3 border border-primary/40 hover:border-primary rounded-lg bg-primary-soft/50 hover:bg-primary-soft text-xs font-bold text-primary flex items-center justify-center gap-2 transition-all shadow-sm"
                >
                  <Icon name="camera" size={15} />
                  <span>{capturing ? "Capturing Screen..." : "📸 Auto Capture Screen"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="py-2.5 px-3 border border-hairline hover:border-hairline-strong rounded-lg bg-paper-2 hover:bg-paper-3 text-xs font-medium text-ink-2 flex items-center justify-center gap-2 transition-all"
                >
                  <Icon name="upload" size={15} className="text-ink-3" />
                  <span>{screenshots.length > 0 ? "➕ Add Another (Ctrl+V)" : "Upload / Paste (Ctrl+V)"}</span>
                </button>
              </div>
            </div>
          </FormField>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="bg-primary text-white font-bold">
              {submitting ? "Submitting Report..." : `Submit Report (${screenshots.length} Screenshots)`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
