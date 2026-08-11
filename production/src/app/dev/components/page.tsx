/**
 * Component showcase / dev playground.
 * Visit /dev/components to see every component in every variant.
 */
"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button, IconButton } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Avatar, AvatarGroup } from "@/components/ui/avatar";
import { Skeleton, SkeletonText, SkeletonCard, SkeletonKPI } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label, FormField } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";

import { EmptyState } from "@/components/shared/empty-state";
import { KPI } from "@/components/shared/kpi";
import { GeminiCard } from "@/components/shared/gemini-card";
import { ActivityTimeline } from "@/components/shared/activity-timeline";

import { MarginPill, computeMargin } from "@/components/features/margin-pill";

import { rupee, num, formatDate, formatPhone, initials, isValidGstin } from "@/lib/utils";

export default function ComponentsShowcase() {
  const [tab, setTab] = useState("active");
  const [agreed, setAgreed] = useState(false);
  const [notifications, setNotifications] = useState(true);

  const tabs: TabBarItem[] = [
    { id: "all",      label: "All",     count: 24 },
    { id: "active",   label: "Active",  count: 14, dot: "emerald" },
    { id: "expiring", label: "Expiring", count: 5, dot: "amber" },
    { id: "expired",  label: "Expired", count: 3, dot: "rose" },
  ];

  return (
    <main className="min-h-screen p-8 max-w-6xl mx-auto">
      {/* Header */}
      <header className="mb-12">
        <Badge kind="warning" dot className="mb-4">
          DEV ONLY · Not for production
        </Badge>
        <h1 className="font-serif text-4xl mb-2">Component Library</h1>
        <p className="text-ink-3">All production components in all their variants — for visual QA + a11y checks.</p>
      </header>

      {/* Buttons */}
      <Section title="Button" description="Variants × sizes × states">
        <div className="flex flex-wrap gap-3 mb-4">
          <Button>Default</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="link">Link button</Button>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Button size="sm" variant="primary">Small</Button>
          <Button size="md" variant="primary">Medium</Button>
          <Button size="lg" variant="primary">Large</Button>
        </div>

        <div className="flex flex-wrap gap-3 mb-4">
          <Button icon="send" variant="primary">Send quote</Button>
          <Button iconRight="arrow_right">Continue</Button>
          <Button icon="download" variant="ghost">Export</Button>
          <Button icon="trash" variant="danger">Delete</Button>
          <Button icon="plus" variant="primary" size="sm">Add</Button>
        </div>

        <div className="flex flex-wrap gap-3 mb-4">
          <Button loading>Loading…</Button>
          <Button variant="primary" loading>Processing payment…</Button>
          <Button disabled>Disabled</Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <IconButton icon="bell" aria-label="Notifications" />
          <IconButton icon="settings" aria-label="Settings" />
          <IconButton icon="refresh" aria-label="Refresh" size="sm" />
          <IconButton icon="more_h" aria-label="More options" size="lg" />
        </div>
      </Section>

      {/* Badges */}
      <Section title="Badge" description="Status pills (with or without dot)">
        <div className="flex flex-wrap gap-2 mb-4">
          <Badge kind="muted" dot>Draft</Badge>
          <Badge kind="success" dot>Paid</Badge>
          <Badge kind="warning" dot>Pending</Badge>
          <Badge kind="danger" dot>Overdue 14d</Badge>
          <Badge kind="info" dot>Trial · D5</Badge>
          <Badge kind="outline">Outline</Badge>
        </div>
      </Section>

      {/* Avatar */}
      <Section title="Avatar" description="Initials, image, status, sizes">
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <Avatar initials="PA" color="ink" size="xs" />
          <Avatar initials="PA" color="amber" size="sm" />
          <Avatar initials="RB" color="indigo" size="md" />
          <Avatar initials="PR" color="emerald" size="lg" status="online" />
          <Avatar name="Sneha K" color="rose" size="xl" status="busy" />
        </div>
        <div className="mb-4">
          <AvatarGroup
            size="md"
            avatars={[
              { initials: "PA", color: "amber" },
              { initials: "RB", color: "indigo" },
              { initials: "PR", color: "emerald" },
              { initials: "AM", color: "rose" },
              { initials: "SK", color: "slate" },
            ]}
            max={3}
          />
        </div>
      </Section>

      {/* KPI */}
      <Section title="KPI" description="Dashboard metric tiles">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <KPI label="MRR" value={rupee(420000, { compact: true })} trend="+12%" trendKind="up" icon="rupee" />
          <KPI label="ARR" value={rupee(5040000, { compact: true })} trend="+14%" trendKind="up" icon="trending_up" />
          <KPI label="Active subs" value={32} trend="+4 this month" trendKind="up" />
          <KPI label="High-risk renewals" value={3} trend="₹8.5L at risk" trendKind="down" icon="alert" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SkeletonKPI />
          <SkeletonKPI />
          <SkeletonKPI />
          <SkeletonKPI />
        </div>
      </Section>

      {/* Tabs */}
      <Section title="Tabs" description="Tab navigation with count badges + dots">
        <TabBar value={tab} onChange={setTab} items={tabs} />
        <div className="mt-4 p-4 bg-paper-2 rounded text-sm text-ink-2">
          Selected: <b>{tab}</b>
        </div>
      </Section>

      {/* Forms */}
      <Section title="Forms" description="Input · Textarea · Select · Switch · Checkbox">
        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <FormField label="Company name" required htmlFor="company">
              <Input id="company" placeholder="e.g. Acme Corp Pvt Ltd" />
            </FormField>

            <FormField label="GSTIN" htmlFor="gstin">
              <Input id="gstin" placeholder="e.g. 27AABCE9876D1Z3" className="font-mono uppercase" />
            </FormField>

            <FormField label="Domain" htmlFor="domain">
              <Input id="domain" placeholder="e.g. acmecorp" suffix=".com" />
            </FormField>

            <FormField label="Search" htmlFor="search">
              <Input id="search" placeholder="Search customers…" prefix={<Icon name="search" size={14} />} />
            </FormField>

            <FormField label="Email with error" htmlFor="email-err">
              <Input id="email-err" placeholder="e.g. you@example.com" defaultValue="invalid" error="Please enter a valid email" />
            </FormField>
          </div>

          <div className="space-y-4">
            <FormField label="State" htmlFor="state">
              <Select defaultValue="MH">
                <SelectTrigger id="state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MH">Maharashtra (27)</SelectItem>
                  <SelectItem value="KA">Karnataka (29)</SelectItem>
                  <SelectItem value="TN">Tamil Nadu (33)</SelectItem>
                  <SelectItem value="DL">Delhi (07)</SelectItem>
                  <SelectItem value="GJ">Gujarat (24)</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Notes" htmlFor="notes">
              <Textarea id="notes" placeholder="Internal notes about this customer…" rows={4} />
            </FormField>

            <div className="flex items-center gap-3">
              <Switch checked={notifications} onCheckedChange={setNotifications} id="notif" />
              <Label htmlFor="notif">Enable notifications</Label>
            </div>

            <div className="flex items-center gap-3">
              <Checkbox checked={agreed} onCheckedChange={(c) => setAgreed(!!c)} id="terms" />
              <Label htmlFor="terms">I agree to the terms of service</Label>
            </div>
          </div>
        </div>
      </Section>

      {/* Cards */}
      <Section title="Card" description="Surface for grouping content">
        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <Card
            title="Subscriptions"
            sub="Auto-synced across all vendors"
            actions={<Button size="sm" icon="refresh">Sync</Button>}
          >
            <p className="text-sm text-ink-2">
              You have <b>14 active subscriptions</b> generating ₹4.2L MRR.
              Avg margin <b className="text-emerald">17%</b>.
            </p>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Renewal forecast</CardTitle>
                <CardDescription>Next 90 days</CardDescription>
              </div>
              <Badge kind="warning" dot>3 high-risk</Badge>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-ink-2">
                ₹8.5L ARR scheduled to renew. Risk model flags 3 customers.
              </p>
            </CardContent>
            <CardFooter>
              <Button variant="ghost" size="sm">Dismiss</Button>
              <Button variant="primary" size="sm" icon="phone">Call high-risk</Button>
            </CardFooter>
          </Card>
        </div>
      </Section>

      {/* EmptyState */}
      <Section title="EmptyState" description="Illustrated nudges for empty lists">
        <div className="grid md:grid-cols-2 gap-4">
          <Card flush>
            <EmptyState
              icon="target"
              title="No leads yet"
              body="Leads will appear here when customers fill the contact form on your buy pages."
              action={<Button variant="primary" icon="plus">Add lead manually</Button>}
              secondary={<Button variant="default" icon="download">Import CSV</Button>}
              sample={{ onClick: () => toast.success("Sample data loaded") }}
            />
          </Card>
          <Card flush>
            <EmptyState
              icon="receipt"
              title="All caught up"
              body="No overdue invoices. Great job!"
              compact
            />
          </Card>
        </div>
      </Section>

      {/* GeminiCard */}
      <Section title="GeminiCard" description="AI insight cards with gradient border">
        <GeminiCard
          title="Lead intelligence · Today"
          actions={
            <>
              <Button size="sm" variant="primary" icon="phone" onClick={() => toast.success("Calling Acme Corp")}>Call Acme now</Button>
              <Button size="sm" icon="mail" onClick={() => toast("Nudge sent")}>Nudge Zephyr</Button>
            </>
          }
        >
          <b>3 leads worth focusing today.</b> Acme Corp opened your quote 3× in 24h — strong intent signal, ₹4.9L value, call within 2 hours. Zephyr Networks quote expires in 2 days, no response — send nudge.
        </GeminiCard>

        <GeminiCard compact>
          <b>1 conversion opportunity.</b> Cosmo Tech on Day 11 of trial with high engagement — perfect time to send convert quote.
        </GeminiCard>
      </Section>

      {/* ActivityTimeline */}
      <Section title="ActivityTimeline" description="Audit log + customer activity">
        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <ActivityTimeline
              events={[
                { icon: "phone", kind: "indigo", title: "Call with Rajesh — discussed Plus upgrade",
                  body: "Outcome: positive · Next: revised quote by 2 PM",
                  time: "Today · 11:30 AM", actor: "Rahul B" },
                { icon: "rupee", kind: "emerald", title: "Payment received · ₹3.05L",
                  body: "Invoice INV-2026-0156 via Razorpay UPI",
                  time: "Today · 09:42 AM" },
                { icon: "file", kind: "amber", title: "Quote viewed (3rd time)",
                  body: "Q-2026-0042 · ₹4.9L Plus + Voice upgrade",
                  time: "Yesterday · 04:15 PM" },
                { icon: "refresh", kind: "emerald", title: "Status changed: Trial → Quote Sent",
                  time: "Yesterday · 10:50 AM" },
                { icon: "edit", kind: "amber", title: "Note added",
                  body: "Decision maker = CTO Rajesh. Budget approved ₹3L.",
                  time: "3 days ago", actor: "Rahul B" },
              ]}
            />
          </Card>
          <Card title="Compact mode">
            <ActivityTimeline
              compact
              events={[
                { icon: "mail", kind: "indigo", title: "Email sent", time: "Today · 11:30 AM" },
                { icon: "phone", kind: "emerald", title: "Call completed", time: "Today · 10:15 AM" },
                { icon: "alert", kind: "rose", title: "Payment failed", time: "Yesterday" },
              ]}
            />
          </Card>
        </div>
      </Section>

      {/* MarginPill */}
      <Section title="MarginPill" description="The reseller moat — your margin per deal">
        <Card flush>
          <table className="w-full">
            <thead className="border-b border-hairline bg-paper-2">
              <tr>
                <th className="text-left p-3 text-xs font-semibold">Subscription</th>
                <th className="text-right p-3 text-xs font-semibold">MRR</th>
                <th className="text-right p-3 text-xs font-semibold">Margin (default)</th>
                <th className="text-right p-3 text-xs font-semibold">Compact</th>
                <th className="text-right p-3 text-xs font-semibold">Detailed</th>
              </tr>
            </thead>
            <tbody>
              {[
                { name: "Acme · Workspace Plus", cost: 28750, price: 34500 },     // 17% ok
                { name: "Cosmo · Workspace Plus", cost: 13800, price: 16560 },    // 17% ok
                { name: "Delta · Workspace Plus", cost: 57500, price: 69000 },    // 17% ok
                { name: "Echo · Enterprise", cost: 99000, price: 115200 },        // 14% ok
                { name: "Foxtrot · M365 Std", cost: 28560, price: 34650 },        // 18% healthy
                { name: "Hotel Royal · Workspace Std", cost: 5060, price: 5888 }, // 14% ok
                { name: "Zoho Workplace · 12 seats", cost: 1144, price: 1440 },   // 21% healthy
              ].map((r) => {
                const m = computeMargin(r.cost, r.price);
                return (
                  <tr key={r.name} className="border-b border-hairline last:border-0">
                    <td className="p-3 text-sm">{r.name}</td>
                    <td className="p-3 text-sm text-right tabular-nums">{rupee(r.price)}</td>
                    <td className="p-3 text-right"><MarginPill margin={m} period="monthly" /></td>
                    <td className="p-3 text-right"><MarginPill margin={m} variant="compact" /></td>
                    <td className="p-3 text-right"><MarginPill margin={m} variant="detailed" period="monthly" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </Section>

      {/* Loading skeletons */}
      <Section title="Skeleton" description="Loading placeholders that match content shape">
        <div className="grid md:grid-cols-2 gap-4">
          <Card title="Single-line + multi-line">
            <div className="space-y-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full" />
              <SkeletonText lines={4} />
            </div>
          </Card>
          <SkeletonCard />
        </div>
      </Section>

      {/* Toast */}
      <Section title="Toast (sonner)" description="Global feedback">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => toast("Quote sent")}>Default</Button>
          <Button variant="primary" onClick={() => toast.success("Payment received · ₹3.05L")}>Success</Button>
          <Button variant="danger" onClick={() => toast.error("Could not connect to Razorpay")}>Error</Button>
          <Button onClick={() => toast.warning("Trial expires in 2 days")}>Warning</Button>
          <Button onClick={() => toast.info("Vendor sync started")}>Info</Button>
          <Button onClick={() => toast.promise(
            new Promise((r) => setTimeout(r, 1500)),
            { loading: "Saving quote…", success: "Quote saved", error: "Save failed" }
          )}>Promise</Button>
        </div>
      </Section>

      {/* Icons */}
      <Section title="Icon" description="lucide-react with prototype-compatible names">
        <div className="grid grid-cols-6 md:grid-cols-10 gap-3">
          {[
            "home", "inbox", "target", "users", "file", "receipt", "refresh", "clock",
            "package", "rupee", "bell", "search", "check", "x", "alert", "info",
            "mail", "phone", "whatsapp", "settings", "shield", "globe", "download", "upload",
            "calendar", "rocket", "sparkles", "cart", "edit", "trash", "external", "more_h",
          ].map((name) => (
            <div key={name} className="flex flex-col items-center gap-1 p-2 rounded hover:bg-paper-2 transition-colors">
              <Icon name={name} size={20} className="text-ink-2" />
              <span className="text-[10px] font-mono text-ink-3">{name}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Utility helpers */}
      <Section title="Utility helpers" description="Indian-first formatting + validation">
        <Card flush>
          <table className="w-full text-sm">
            <thead className="border-b border-hairline bg-paper-2">
              <tr>
                <th className="text-left p-3 font-semibold w-1/3">Function</th>
                <th className="text-left p-3 font-semibold">Input</th>
                <th className="text-left p-3 font-semibold">Output</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["rupee(490644)",                "490644",      rupee(490644)],
                ["rupee(490644, {compact:true})","490644",      rupee(490644, { compact: true })],
                ["rupee(45000000, {compact})",   "45M",         rupee(45000000, { compact: true })],
                ["num(1234567)",                 "1234567",     num(1234567)],
                ["formatDate('2026-05-20')",     "ISO",         formatDate("2026-05-20")],
                ["formatDate(...,'long')",       "ISO",         formatDate("2026-05-20T11:30:00+05:30", "long")],
                ["formatPhone('9876543210')",    "9876543210",  formatPhone("9876543210")],
                ["initials('Rajesh K Sharma')",  "name",        initials("Rajesh K Sharma")],
                ["isValidGstin(...)",            "27AABCE9876D1Z3", String(isValidGstin("27AABCE9876D1Z3"))],
                ["isValidGstin('bad')",          "bad",         String(isValidGstin("bad"))],
              ].map(([fn, input, output], i) => (
                <tr key={i} className="border-b border-hairline last:border-0">
                  <td className="p-3 font-mono text-xs">{fn}</td>
                  <td className="p-3 font-mono text-xs text-ink-3">{input}</td>
                  <td className="p-3 font-mono text-xs"><b>{output}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Section>

      <footer className="mt-12 pt-8 border-t border-hairline text-xs text-ink-3">
        <p>
          Built by Claude as Frontend Engineer · Day 2 complete · 18 components ready ·{" "}
          <span className="font-mono">/dev/components</span>
        </p>
      </footer>
    </main>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <div className="border-b border-hairline pb-3 mb-6">
        <h2 className="font-serif text-2xl">{title}</h2>
        {description && <p className="text-sm text-ink-3 mt-1">{description}</p>}
      </div>
      {children}
    </section>
  );
}
