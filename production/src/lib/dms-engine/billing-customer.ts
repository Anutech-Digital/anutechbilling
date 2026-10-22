/**
 * R-1771 — the ResellerOS customer ID that DMS stores on its user (`resellerosCustomerId`).
 *
 * It is the SAME id /api/v1 answers to (`billingCustomerId`: the customer number, else the
 * uuid), so DMS can call /api/v1/customers/{id}/… with what it was given. Before this, DMS
 * could only link its user to a ResellerOS customer by matching emails — a customer whose
 * email differs between the two never got linked.
 *
 * Read with the service-role client, so the tenant filter here IS the tenant boundary.
 * Returns undefined when there is nothing certain to say (no customer, a failed read): the
 * caller then sends the old shape, never a guess.
 */
import { billingCustomerId } from "@/lib/api/v1-mappers";

type AdminLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => {
        eq: (col: string, val: unknown) => {
          maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
};

export async function billingCustomerIdFor(
  /* The service-role client. Taken as `unknown` and narrowed here: matching the generated
     Database type structurally makes tsc recurse too deep (TS2589). */
  adminClient: unknown,
  tenantId: string,
  customerId: string | null | undefined,
): Promise<string | undefined> {
  if (!customerId) return undefined;
  const admin = adminClient as AdminLike;
  const { data, error } = await admin
    .from("customers")
    .select("id, customer_number")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const c = data as { id?: string | null; customer_number?: string | null } | null;
  if (error || !c?.id) return undefined;
  return billingCustomerId({ id: c.id, customer_number: c.customer_number ?? null });
}
