/**
 * Contact persons editor on the customer form (Zoho-style grid on desktop).
 *
 * R-293: the grid was `min-w-[860px]` at every width, so on a 375px phone the form scrolled
 * sideways and the Remove menu sat 500px off screen. One set of inputs, two layouts by CSS:
 *   - md and up: the same bordered table as before (7 columns, cell borders draw the grid);
 *   - below md: each person is a card — label above each field, two columns, menu top-right.
 * The inputs are rendered ONCE (not a phone copy + a desktop copy), so react-hook-form never
 * sees two fields registered under the same name.
 */
"use client";

import type { FieldArrayWithId, UseFormRegister } from "react-hook-form";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { CustomerFormData } from "./use-customer-form";

// Desktop: borderless — the table cell borders draw the grid. Phone: a normal bordered box.
const cellInput =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4/70 focus:outline-none " +
  "md:rounded-none md:border-0 md:bg-transparent focus:ring-2 focus:ring-amber/40 md:focus:ring-0 md:focus:bg-amber-soft/25";

const th = "text-left font-medium px-3 py-2 border-b border-r border-hairline";
// Phone: stacked block with its label; desktop: a plain table cell with the right border.
const td = "block min-w-0 md:table-cell md:border-r md:border-hairline md:p-0";
const phoneLabel = "mb-1 block text-2xs font-medium uppercase tracking-wider text-ink-3 md:hidden";

interface Props {
  fields: FieldArrayWithId<CustomerFormData, "contact_persons", "id">[];
  register: UseFormRegister<CustomerFormData>;
  onMakePrimary: (index: number) => void;
  onRemove: (index: number) => void;
}

export function ContactPersonsTable({ fields, register, onMakePrimary, onRemove }: Props) {
  if (fields.length === 0) return null;
  return (
    <div className="mb-3 md:overflow-x-auto md:rounded-lg md:border md:border-hairline" data-testid="contact-persons">
      <table className="block w-full border-collapse text-sm md:table md:min-w-[860px]">
        <thead className="hidden md:table-header-group">
          <tr className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3">
            <th className={cn(th, "w-[92px]")}>Salutation</th>
            <th className={th}>First name</th>
            <th className={th}>Last name</th>
            <th className={th}>Email address</th>
            <th className={th}>Work phone</th>
            <th className={th}>Mobile</th>
            <th className="w-10 border-b border-hairline" aria-label="Actions" />
          </tr>
        </thead>
        <tbody className="flex flex-col gap-3 md:table-row-group">
          {fields.map((f, i) => {
            const id = (k: string) => `contact_persons_${i}_${k}`;
            return (
              <tr
                key={f.id}
                data-testid="contact-person"
                className="relative grid grid-cols-2 gap-x-2 gap-y-2.5 rounded-lg border border-hairline p-3 pt-10 md:table-row md:rounded-none md:border-0 md:border-b md:p-0 md:last:border-b-0"
              >
                <td className={td}>
                  <label htmlFor={id("salutation")} className={phoneLabel}>Salutation</label>
                  <select id={id("salutation")} className={cellInput} aria-label="Salutation" {...register(`contact_persons.${i}.salutation`)}>
                    <option value="">—</option>
                    <option value="Mr.">Mr.</option>
                    <option value="Ms.">Ms.</option>
                    <option value="Mrs.">Mrs.</option>
                    <option value="Dr.">Dr.</option>
                  </select>
                </td>
                <td className={cn(td, "col-start-1")}>
                  <label htmlFor={id("first_name")} className={phoneLabel}>First name</label>
                  <input id={id("first_name")} className={cellInput} placeholder="First name" aria-label="First name" autoComplete="off" {...register(`contact_persons.${i}.first_name`)} />
                </td>
                <td className={td}>
                  <label htmlFor={id("last_name")} className={phoneLabel}>Last name</label>
                  <input id={id("last_name")} className={cellInput} placeholder="Last name" aria-label="Last name" autoComplete="off" {...register(`contact_persons.${i}.last_name`)} />
                </td>
                <td className={cn(td, "col-span-2")}>
                  <label htmlFor={id("email")} className={phoneLabel}>Email address</label>
                  <input id={id("email")} className={cellInput} type="email" inputMode="email" placeholder="e.g. name@company.com" aria-label="Email address" autoComplete="off" {...register(`contact_persons.${i}.email`)} />
                </td>
                <td className={td}>
                  <label htmlFor={id("phone")} className={phoneLabel}>Work phone</label>
                  <input id={id("phone")} className={cellInput} type="tel" inputMode="tel" placeholder="e.g. +91 98765 43210" aria-label="Work phone" autoComplete="off" {...register(`contact_persons.${i}.phone`)} />
                </td>
                <td className={td}>
                  <label htmlFor={id("mobile")} className={phoneLabel}>Mobile</label>
                  <input id={id("mobile")} className={cellInput} type="tel" inputMode="tel" placeholder="e.g. +91 98765 43210" aria-label="Mobile" autoComplete="off" {...register(`contact_persons.${i}.mobile`)} />
                </td>
                <td className="absolute right-1.5 top-1.5 md:static md:table-cell md:text-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-ink-3 hover:text-ink md:h-auto md:w-auto md:p-1"
                        aria-label={`Contact ${i + 1} actions`}
                      >
                        <Icon name="more_h" size={16} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onMakePrimary(i)}>
                        <Icon name="check_circle" size={14} className="text-amber" /> Make primary contact
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onRemove(i)} className="text-rose focus:text-rose">
                        <Icon name="trash" size={14} /> Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
