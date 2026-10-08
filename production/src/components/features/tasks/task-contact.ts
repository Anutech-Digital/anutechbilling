/**
 * R-354 — the person a task is about, with the ways to reach them, taken from the lead or
 * customer embedded in the task row (TASK_SELECT). No extra request per row.
 */
import { dialable } from "@/lib/leads/call-queue";
import type { TaskWithLink } from "@/lib/queries/tasks";

export interface TaskContact {
  /** Person to ask for (contact name), when the linked row has one. */
  person: string | null;
  phone: string | null;
  email: string | null;
  /** `tel:` link, null when there is no usable number. */
  telHref: string | null;
  /** wa.me link, null when there is no usable number. */
  whatsappHref: string | null;
}

const clean = (s: string | null | undefined) => (s ?? "").trim() || null;

export function taskContact(task: Pick<TaskWithLink, "leads" | "customers">): TaskContact | null {
  const src = task.leads ?? task.customers ?? null;
  if (!src) return null;
  const phone = clean(src.contact_phone);
  const email = clean(src.contact_email);
  const person = clean(src.contact_name);
  if (!phone && !email && !person) return null;
  const digits = dialable(phone);
  return {
    person,
    phone,
    email,
    telHref: digits ? `tel:+${digits}` : null,
    whatsappHref: digits ? `https://wa.me/${digits}` : null,
  };
}
