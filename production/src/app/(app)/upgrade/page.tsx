/**
 * /upgrade — Upgrade to business, for a personal login (GP-07a, R-2115).
 *
 * A stub so the Personal menu row resolves. Decision D2: business features unlock only after
 * the upgrade payment is confirmed — that flow, and the PRICE (an owner decision, not set yet),
 * belong to later G-PERSONAL cards. So this page names what the upgrade brings and shows no
 * price and no pay button.
 */
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";

const BRINGS = [
  "GST invoices and quotations",
  "Customers and leads",
  "Payments received and reminders",
  "Your Money pages stay exactly as they are — private to you",
];

export default function UpgradePage() {
  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[720px] mx-auto space-y-5">
      <div>
        <h1 className="text-2xl md:text-3xl font-serif text-ink">Upgrade to business</h1>
        <p className="text-sm text-ink-3 mt-1">Use the same login to run your business.</p>
      </div>
      <Card className="p-6 space-y-4">
        <ul className="space-y-2">
          {BRINGS.map((b) => (
            <li key={b} className="flex items-start gap-2 text-sm text-ink">
              <Icon name="check" size={16} className="text-emerald mt-0.5 shrink-0" />
              {b}
            </li>
          ))}
        </ul>
        <p className="text-sm text-ink-3">Upgrading is not open yet. This page will let you upgrade as soon as it is.</p>
      </Card>
    </div>
  );
}
