"use client";

/**
 * EnquiryClient — the shareable public requirement form (rendered by /enquiry).
 *
 * Plain contact form: name, company, email, phone, product interest, approx
 * users, and a free-text requirement. POSTs to /api/public/enquiry/general,
 * then shows a success panel. Supports ?embed=1 (drops the outer chrome so it
 * sits cleanly inside an <iframe> on the reseller's own website).
 */
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const schema = z.object({
  fullName:    z.string().min(2, "Please enter your name"),
  companyName: z.string().min(2, "Company name required"),
  email:       z.string().email("Enter a valid email"),
  phone:       z.string().min(10, "Enter a valid phone number"),
  product:     z.enum(["google-workspace", "microsoft-365", "zoho", "other"]).optional()
                 .or(z.literal("").transform(() => undefined)),
  seats:       z.coerce.number().int().min(1).max(100000).optional()
                 .or(z.literal("").transform(() => undefined)),
  subscriptionType: z.enum(["fresh", "switch"]).optional()
                 .or(z.literal("").transform(() => undefined)),
  message:     z.string().min(5, "Tell us a bit about what you need"),
});
type FormData = z.infer<typeof schema>;

const PRODUCTS = [
  { id: "google-workspace", label: "Google Workspace" },
  { id: "microsoft-365",    label: "Microsoft 365" },
  { id: "zoho",             label: "Zoho" },
  { id: "other",            label: "Other / Not sure" },
] as const;

export function EnquiryClient({
  brandName,
  brandPhone,
  brandLogoUrl,
}: {
  brandName: string;
  brandPhone: string | null;
  brandLogoUrl?: string | null;
}) {
  const [embed, setEmbed]     = React.useState(false);
  const [done, setDone]       = React.useState(false);
  const [serverError, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    setEmbed(new URLSearchParams(window.location.search).get("embed") === "1");
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormData) => {
    setErr(null);
    try {
      const res = await fetch("/api/public/enquiry/general", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json.error ?? "Something went wrong. Please try again.");
        return;
      }
      setDone(true);
    } catch {
      setErr("Network error. Please check your connection and try again.");
    }
  };

  return (
    <div className={cn("min-h-screen bg-paper-2", embed && "min-h-0 bg-transparent")}>
      <div className="mx-auto max-w-lg px-4 py-8 md:py-12">
        {/* Brand header (hidden in embed mode — the host site has its own) */}
        {!embed && (
          <div className="mb-6 flex items-center gap-3">
            {brandLogoUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={brandLogoUrl} alt={brandName} className="h-11 max-w-[130px] object-contain" />
            ) : (
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink text-paper font-serif text-lg">
                {brandName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div className="font-serif text-base leading-none text-ink">{brandName}</div>
              <div className="mt-1 text-[10px] text-ink-3">Cloud Reseller · India</div>
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-hairline bg-paper p-6 shadow-sm md:p-8">
          {done ? (
            <div className="py-6 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-soft">
                <Icon name="check" size={28} className="text-emerald" />
              </div>
              <h1 className="font-serif text-2xl text-ink">Thank you!</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm text-ink-2">
                We&apos;ve got your requirement and someone from {brandName} will get back to
                you shortly. A confirmation is on its way to your inbox.
              </p>
              {brandPhone && (
                <p className="mt-4 text-xs text-ink-3">
                  Need to talk now? Call us at{" "}
                  <a href={`tel:${brandPhone}`} className="font-medium text-amber-ink underline">
                    {brandPhone}
                  </a>
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="mb-5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                  Enquiry
                </p>
                <h1 className="mt-1 font-serif text-2xl leading-tight text-ink">
                  Tell us what you need
                </h1>
                <p className="mt-1 text-sm text-ink-3">
                  Share your requirement and we&apos;ll get back to you with a quote.
                </p>
              </div>

              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <FormField label="Your name" required htmlFor="fullName">
                  <Input id="fullName" placeholder="e.g. Rajesh Kumar" error={errors.fullName?.message} {...register("fullName")} />
                </FormField>

                <FormField label="Company" required htmlFor="companyName">
                  <Input id="companyName" placeholder="e.g. Acme Pvt Ltd" error={errors.companyName?.message} {...register("companyName")} />
                </FormField>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField label="Work email" required htmlFor="email">
                    <Input id="email" type="email" placeholder="e.g. rajesh@acme.in" error={errors.email?.message} {...register("email")} />
                  </FormField>
                  <FormField label="Phone" required htmlFor="phone">
                    <Input id="phone" type="tel" placeholder="e.g. +91 98765 43210" error={errors.phone?.message} {...register("phone")} />
                  </FormField>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField label="Interested in" htmlFor="product">
                    <select
                      id="product"
                      defaultValue=""
                      {...register("product")}
                      className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                    >
                      <option value="">Select (optional)</option>
                      {PRODUCTS.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Approx. users" htmlFor="seats">
                    <Input id="seats" type="number" min={1} placeholder="e.g. 25" error={errors.seats?.message} {...register("seats")} />
                  </FormField>
                </div>

                <FormField label="New or switching?" htmlFor="subscriptionType">
                  <select
                    id="subscriptionType"
                    defaultValue=""
                    {...register("subscriptionType")}
                    className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  >
                    <option value="">Select (optional)</option>
                    <option value="fresh">Fresh subscription (new)</option>
                    <option value="switch">Already have it — switching provider to you</option>
                  </select>
                </FormField>

                <FormField label="What do you need?" required htmlFor="message">
                  <textarea
                    id="message"
                    rows={4}
                    placeholder="e.g. We're 25 people moving from Microsoft 365 to Google Workspace and need help with migration + GST invoice."
                    className={cn(
                      "w-full rounded-md border bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber/40",
                      errors.message ? "border-rose" : "border-hairline",
                    )}
                    {...register("message")}
                  />
                  {errors.message && (
                    <p className="mt-1 text-xs text-rose">{errors.message.message}</p>
                  )}
                </FormField>

                {serverError && (
                  <div className="rounded-md border border-rose/40 bg-rose-soft px-3 py-2 text-sm text-rose">
                    {serverError}
                  </div>
                )}

                <Button type="submit" variant="primary" className="w-full" loading={isSubmitting}>
                  Send enquiry
                </Button>

                <p className="text-center text-[11px] text-ink-3">
                  We&apos;ll only use your details to respond to this enquiry.
                </p>
              </form>
            </>
          )}
        </div>

        {!embed && (
          <p className="mt-4 text-center text-[10px] text-ink-3">
            Powered by ResellerOS
          </p>
        )}
      </div>
    </div>
  );
}
