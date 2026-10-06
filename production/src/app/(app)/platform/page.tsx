/**
 * Platform › Signups — FOUNDER-ONLY view of every reseller that signed up for
 * ResellerOS. Cross-tenant, so it reads through /api/platform/signups (which
 * re-checks the founder allowlist server-side before using the admin client).
 * Displays Owner Name, Email ID, Phone Number, Sign Up date & status.
 * Actions: Edit Workspace Modal, Secure Delete Workspace Modal, Search filter.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDate } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

type SignupRow = {
  id: string;
  name: string;
  owner: string;
  email: string | null;
  phone: string | null;
  signedUp: string;
  tier: string | null;
  gstin: string | null;
  state: string | null;
  activated: boolean;
  users: number;
  customers: number;
};

export default function PlatformSignupsPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const [searchQuery, setSearchQuery] = React.useState("");

  // Deletion Modal State
  const [deleteTarget, setDeleteTarget] = React.useState<SignupRow | null>(null);
  const [confirmInput, setConfirmInput] = React.useState("");
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Edit Modal State
  const [editTarget, setEditTarget] = React.useState<SignupRow | null>(null);
  const [editForm, setEditForm] = React.useState({
    name: "",
    tier: "reseller",
    gstin: "",
    state: "",
    phone: "",
    activated: false,
  });
  const [isSavingEdit, setIsSavingEdit] = React.useState(false);

  const q = useQuery({
    queryKey: ["platform-signups"],
    enabled: Boolean(me?.isPlatformAdmin),
    queryFn: async (): Promise<{ count: number; tenants: SignupRow[] }> => {
      const res = await fetch("/api/platform/signups");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Failed to load");
      return res.json();
    },
  });

  // Open Edit Modal
  function handleOpenEdit(t: SignupRow) {
    setEditTarget(t);
    setEditForm({
      name: t.name,
      tier: t.tier ?? "reseller",
      gstin: t.gstin ?? "",
      state: t.state ?? "",
      phone: t.phone ?? "",
      activated: t.activated,
    });
  }

  // Save Edit Workspace
  async function handleSaveEdit() {
    if (!editTarget) return;
    setIsSavingEdit(true);

    try {
      const res = await fetch(`/api/platform/signups/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to update workspace");
        return;
      }

      toast.success("Workspace details updated successfully!");
      setEditTarget(null);
      q.refetch();
    } catch (err: any) {
      toast.error(err.message || "Failed to save changes.");
    } finally {
      setIsSavingEdit(false);
    }
  }

  // Delete Tenant
  async function handleDeleteTenant() {
    if (!deleteTarget) return;
    setIsDeleting(true);

    try {
      const res = await fetch(`/api/platform/signups/${deleteTarget.id}`, {
        method: "DELETE",
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to delete workspace");
        return;
      }

      toast.success(data.message || `Workspace '${deleteTarget.name}' deleted.`);
      setDeleteTarget(null);
      setConfirmInput("");
      q.refetch();
    } catch (err: any) {
      toast.error(err.message || "Failed to execute deletion.");
    } finally {
      setIsDeleting(false);
    }
  }

  if (meLoading) return <div className="p-4 md:p-6 lg:p-8"><Skeleton className="h-40 w-full" /></div>;

  if (!me?.isPlatformAdmin) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
        <Card className="py-2">
          <EmptyState icon="lock" title="Not authorized" body="This founder view is limited to the ResellerOS platform owner." />
        </Card>
      </div>
    );
  }

  const allRows = q.data?.tenants ?? [];
  const activatedCount = allRows.filter((r) => r.activated).length;

  const filteredRows = allRows.filter((r) => {
    if (!searchQuery.trim()) return true;
    const s = searchQuery.toLowerCase().trim();
    return (
      r.name.toLowerCase().includes(s) ||
      r.owner.toLowerCase().includes(s) ||
      (r.email ?? "").toLowerCase().includes(s) ||
      (r.phone ?? "").toLowerCase().includes(s) ||
      (r.gstin ?? "").toLowerCase().includes(s)
    );
  });

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Platform Control</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Reseller Signups</h1>
          <p className="text-sm text-ink-3 mt-1">Every registered cloud reseller business on ResellerOS. Founder view.</p>
        </div>

        <div className="w-full sm:w-72">
          <Input
            aria-label="Search resellers"
            placeholder="Search reseller name, email, phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 text-xs bg-paper"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <Card className="p-3">
          <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total Resellers</div>
          <div className="font-serif text-2xl font-bold">{q.data ? q.data.count : "—"}</div>
        </Card>
        <Card className="p-3">
          <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Activated Workspaces</div>
          <div className="font-serif text-2xl font-bold text-emerald">{q.data ? activatedCount : "—"}</div>
        </Card>
        <Card className="p-3">
          <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Setup Pending</div>
          <div className="font-serif text-2xl font-bold text-amber-ink">{q.data ? q.data.count - activatedCount : "—"}</div>
        </Card>
      </div>

      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : q.isError ? (
        <Card className="py-2"><EmptyState icon="alert" title="Could not load signups" body={(q.error as Error)?.message ?? "Try again."} /></Card>
      ) : filteredRows.length === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No signups found" body="No registered reseller matches your search." /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left px-4 py-3">Business</th>
                <th className="text-left px-4 py-3">Owner Contact</th>
                <th className="text-left px-4 py-3">Phone</th>
                <th className="text-left px-4 py-3 whitespace-nowrap">Signed Up</th>
                <th className="text-left px-4 py-3">Tier</th>
                <th className="text-right px-4 py-3">Users</th>
                <th className="text-right px-4 py-3">Customers</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {filteredRows.map((t) => {
                const isPrimary = t.name.toLowerCase().includes("anutech digital");
                return (
                  <tr key={t.id} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-ink">{t.name}</div>
                      {t.gstin && (
                        <div className="font-mono text-2xs text-ink-3">
                          {t.gstin}{t.state ? ` · ${t.state}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink-2">{t.owner}</div>
                      {t.email ? (
                        <a
                          href={`mailto:${t.email}`}
                          className="text-xs text-amber-ink hover:underline flex items-center gap-1 mt-0.5"
                        >
                          <Icon name="mail" size={12} />
                          <span>{t.email}</span>
                        </a>
                      ) : (
                        <span className="text-xs text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {t.phone ? (
                        <a
                          href={`tel:${t.phone}`}
                          className="font-mono text-xs text-ink-2 hover:text-amber flex items-center gap-1"
                        >
                          <Icon name="phone" size={12} />
                          <span>{t.phone}</span>
                        </a>
                      ) : (
                        <span className="text-xs text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-2 whitespace-nowrap text-xs">
                      {formatDate(t.signedUp, "short")}
                    </td>
                    <td className="px-4 py-3">
                      <Badge kind={t.tier === "distributor" ? "info" : "muted"} size="sm">
                        {t.tier ?? "reseller"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs font-medium">{t.users}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs font-medium">{t.customers}</td>
                    <td className="px-4 py-3">
                      {t.activated ? (
                        <Badge kind="success" size="sm" dot>Activated</Badge>
                      ) : (
                        <Badge kind="warning" size="sm" dot>Setup Pending</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton
                          icon="edit"
                          title="Edit workspace"
                          aria-label="Edit workspace"
                          className="text-ink-3 hover:text-ink h-7 w-7"
                          onClick={() => handleOpenEdit(t)}
                        />
                        {!isPrimary && (
                          <IconButton
                            icon="trash"
                            title="Delete workspace"
                            aria-label="Delete workspace"
                            className="text-danger hover:bg-danger/10 h-7 w-7"
                            onClick={() => {
                              setDeleteTarget(t);
                              setConfirmInput("");
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* EDIT WORKSPACE MODAL */}
      <Dialog open={Boolean(editTarget)} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon name="pencil" size={18} />
              <span>Edit Reseller Workspace</span>
            </DialogTitle>
            <DialogDescription className="text-xs pt-1">
              Update platform metadata and setup status for {editTarget?.name}.
            </DialogDescription>
          </DialogHeader>

          {editTarget && (
            <div className="space-y-3 py-2 text-xs">
              <div>
                <label htmlFor="pf-name" className="font-semibold text-ink-2 block mb-1">Business Name</label>
                <Input
                  id="pf-name"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="pf-tier" className="font-semibold text-ink-2 block mb-1">Account Tier</label>
                  <select
                    id="pf-tier"
                    value={editForm.tier}
                    onChange={(e) => setEditForm({ ...editForm, tier: e.target.value })}
                    className="w-full h-9 rounded-md border border-hairline bg-paper text-xs px-2 text-ink"
                  >
                    <option value="reseller">Reseller</option>
                    <option value="distributor">Distributor</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="pf-phone" className="font-semibold text-ink-2 block mb-1">Phone Number</label>
                  <Input
                    id="pf-phone"
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    placeholder="+91 98765 43210"
                    className="text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="pf-gstin" className="font-semibold text-ink-2 block mb-1">GSTIN</label>
                  <Input
                    id="pf-gstin"
                    value={editForm.gstin}
                    onChange={(e) => setEditForm({ ...editForm, gstin: e.target.value })}
                    placeholder="07AAAAA0000A1Z5"
                    className="text-xs uppercase"
                  />
                </div>

                <div>
                  <label htmlFor="pf-state" className="font-semibold text-ink-2 block mb-1">State</label>
                  <Input
                    id="pf-state"
                    value={editForm.state}
                    onChange={(e) => setEditForm({ ...editForm, state: e.target.value })}
                    placeholder="Delhi"
                    className="text-xs"
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-hairline flex items-center justify-between">
                <div>
                  <p className="font-semibold text-ink">Activation Status</p>
                  <p className="text-2xs text-ink-3">Mark setup as completed or pending</p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditForm({ ...editForm, activated: !editForm.activated })}
                  aria-pressed={editForm.activated}
                  className={`px-3 py-1 text-xs font-semibold rounded-full border transition-colors ${
                    editForm.activated
                      ? "bg-emerald/15 border-emerald text-emerald-ink"
                      : "bg-amber/15 border-amber text-amber-ink"
                  }`}
                >
                  {editForm.activated ? "Activated" : "Setup Pending"}
                </button>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={isSavingEdit}
              onClick={handleSaveEdit}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* HIGH SECURITY 2-STEP TYPE-TO-CONFIRM DELETION MODAL */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-danger flex items-center gap-2">
              <Icon name="alert" size={18} />
              <span>Delete Reseller Workspace</span>
            </DialogTitle>
            <DialogDescription className="text-xs pt-1">
              This action is permanent and cannot be undone. All users, leads, invoices, and data associated with this workspace will be deleted.
            </DialogDescription>
          </DialogHeader>

          {deleteTarget && (
            <div className="space-y-4 py-2">
              <div className="p-3 border border-danger/20 bg-danger/5 rounded-lg text-xs space-y-1">
                <p className="font-semibold text-danger">Target Workspace:</p>
                <p className="text-ink font-bold text-sm">{deleteTarget.name}</p>
                <p className="text-ink-3">Owner: {deleteTarget.owner} ({deleteTarget.email ?? "No email"})</p>
              </div>

              <div>
                <label htmlFor="pf-delete-confirm" className="text-xs font-semibold text-ink-2 block mb-1.5">
                  To confirm deletion, type <span className="font-bold text-danger select-all font-mono">"{deleteTarget.name}"</span> below:
                </label>
                <Input
                  id="pf-delete-confirm"
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder={`Type "${deleteTarget.name}" exactly...`}
                  className="text-xs font-mono"
                  autoFocus
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon="trash"
              loading={isDeleting}
              disabled={!deleteTarget || confirmInput.trim() !== deleteTarget.name}
              onClick={handleDeleteTenant}
            >
              Permanently Delete Workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
