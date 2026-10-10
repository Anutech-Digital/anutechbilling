/**
 * /customers/[id]/edit — full-page "Edit customer" form (Zoho-style).
 * The customer detail page's "Edit" button navigates here.
 */
"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { useCustomer } from "@/lib/queries/customers";
import { CustomerFormPage } from "@/components/features/customers/customer-form-page";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

export default function EditCustomerPage() {
  const params = useParams<{ id: string }>();
  const { data: customer, isLoading, error } = useCustomer(params.id);

  if (isLoading) {
    return (
      <div className="max-w-[1080px] mx-auto p-4 md:p-6 lg:p-8 space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-md" />
          <Skeleton className="h-8 w-64" />
        </div>
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="p-8 max-w-[1080px] mx-auto">
        <EmptyState
          icon="alert"
          title={error ? "Could not load customer" : "Customer not found"}
          body={error?.message ?? "This customer does not exist in your tenant."}
          action={
            <Button asChild variant="primary" icon="users">
              <Link href={"/customers" as never}>Back to companies</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return <CustomerFormPage customer={customer} />;
}
